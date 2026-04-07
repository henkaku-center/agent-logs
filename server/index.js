import express from "express";
import { BigQuery } from "@google-cloud/bigquery";
import { Firestore } from "@google-cloud/firestore";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { randomInt } from "crypto";

const app = express();
app.use(express.json({ limit: "5mb" }));

const bigquery = new BigQuery();
const firestore = new Firestore();

const PROJECT_ID = process.env.GCP_PROJECT || "agent-logging";
const DATASET = "course";
const TABLE = "logs";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const GMAIL_SENDER = process.env.GMAIL_SENDER || "claude@chibatech.dev";

/** Admin emails that can manage the allowlist */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "grisha@henkaku.center")
  .split(",")
  .map((e) => e.trim().toLowerCase());

/* ── Allowlist ── */

async function isAuthorized(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;

  const domainDoc = await firestore.doc("allowlist/domains").get();
  if (domainDoc.exists && (domainDoc.data().list || []).includes(domain)) return true;

  const emailDoc = await firestore.doc("allowlist/emails").get();
  if (emailDoc.exists && (emailDoc.data().list || []).includes(email.toLowerCase())) return true;

  // Admins are always authorized
  if (ADMIN_EMAILS.includes(email.toLowerCase())) return true;

  return false;
}

function isAdmin(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/* ── Auth ── */

/**
 * Authenticate requests via JWT Bearer token.
 * Returns the email from the token payload.
 */
function authenticate(req) {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.email) return payload.email;
  } catch {
    // fall through
  }
  throw new Error("Invalid or expired token");
}

/**
 * Send a verification code via Gmail API.
 * Uses the Cloud Run service account with domain-wide delegation
 * to send as the GMAIL_SENDER user.
 *
 * On Cloud Run, the metadata server provides access tokens but doesn't
 * support the 'subject' claim needed for domain-wide delegation.
 * We use the IAM signBlob API to create a self-signed JWT with the
 * subject claim, then exchange it for an access token.
 */
async function getGmailAuth() {
  const auth = new google.auth.GoogleAuth();
  const client = await auth.getClient();
  const saEmail = (await auth.getCredentials()).client_email;

  // Create a JWT assertion with subject claim for domain-wide delegation
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: saEmail,
    sub: GMAIL_SENDER,
    scope: "https://www.googleapis.com/auth/gmail.send",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${headerB64}.${payloadB64}`;

  // Sign using IAM signBlob API (no key file needed)
  const iam = google.iam({ version: "v1", auth: client });
  const signResponse = await iam.projects.serviceAccounts.signBlob({
    name: `projects/-/serviceAccounts/${saEmail}`,
    requestBody: { bytesToSign: Buffer.from(unsigned).toString("base64") },
  });
  const signature = signResponse.data.signature
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const signedJwt = `${unsigned}.${signature}`;

  // Exchange for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  // Return an OAuth2Client with the access token
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: tokenData.access_token });
  return oauth2Client;
}

async function sendVerificationEmail(to, code) {
  const auth = await getGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const subject = `Your agent-logs verification code: ${code}`;
  const body = [
    `Your verification code is: ${code}`,
    "",
    "Enter this code in the agent-logs CLI to complete login.",
    "This code expires in 10 minutes.",
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const message = [
    `From: Chiba Tech Agent Logs <${GMAIL_SENDER}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\n");

  const encoded = Buffer.from(message).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
}

/* ── Magic code auth endpoints ── */

/**
 * POST /auth/send-code
 * Checks allowlist, generates a 6-digit code, emails it.
 */
app.post("/auth/send-code", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });

  const normalized = email.toLowerCase().trim();

  if (!(await isAuthorized(normalized))) {
    return res.status(403).json({
      error: `${normalized} is not authorized. Use the same email as your Claude Enterprise account, or contact claude@chibatech.dev to be added.`,
    });
  }

  // Generate 6-digit code
  const code = String(randomInt(100000, 999999));

  // Store in Firestore with 10-minute TTL
  await firestore.doc(`auth_codes/${normalized}`).set({
    code,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
  });

  // Send email
  try {
    await sendVerificationEmail(normalized, code);
  } catch (err) {
    console.error("Failed to send email:", err.message);
    return res.status(500).json({ error: "Failed to send verification email" });
  }

  res.json({ status: "ok", message: `Verification code sent to ${normalized}` });
});

/**
 * POST /auth/verify-code
 * Validates the code, returns a signed JWT.
 */
app.post("/auth/verify-code", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing email or code" });

  const normalized = email.toLowerCase().trim();
  const ref = firestore.doc(`auth_codes/${normalized}`);
  const doc = await ref.get();

  if (!doc.exists) {
    return res.status(401).json({ error: "No verification code found. Request a new one." });
  }

  const data = doc.data();

  // Check expiry
  if (new Date() > data.expires_at.toDate()) {
    await ref.delete();
    return res.status(401).json({ error: "Code expired. Request a new one." });
  }

  // Rate limit: max 5 attempts
  if (data.attempts >= 5) {
    await ref.delete();
    return res.status(429).json({ error: "Too many attempts. Request a new code." });
  }

  // Increment attempts
  await ref.update({ attempts: data.attempts + 1 });

  // Check code
  if (data.code !== code.trim()) {
    return res.status(401).json({ error: `Incorrect code. ${4 - data.attempts} attempts remaining.` });
  }

  // Code is valid — delete it and issue JWT
  await ref.delete();

  const token = jwt.sign(
    { email: normalized, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: "90d" }
  );

  res.json({ status: "ok", token, email: normalized });
});

/* ── Ingest endpoint ── */

app.post("/ingest", async (req, res) => {
  let studentId;
  try {
    studentId = authenticate(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { project_path, session_id, file_name, offset, lines } = req.body;

  if (!project_path || !session_id || !file_name || offset == null || !Array.isArray(lines)) {
    return res.status(400).json({
      error: "Missing required fields: project_path, session_id, file_name, offset, lines",
    });
  }

  if (lines.length === 0) {
    return res.json({
      status: "ok",
      server_offset: offset,
      lines_accepted: 0,
      lines_skipped: 0,
    });
  }

  try {
    const ledgerRef = firestore.doc(`offsets/${studentId}/${session_id}/${file_name}`);
    let linesToInsert;
    let linesSkipped = 0;
    let serverOffset;

    await firestore.runTransaction(async (tx) => {
      const ledgerDoc = await tx.get(ledgerRef);
      const currentOffset = ledgerDoc.exists ? ledgerDoc.data().offset : 0;

      if (offset > currentOffset) {
        throw Object.assign(
          new Error(`Offset gap: client=${offset}, server=${currentOffset}`),
          { code: "OFFSET_GAP", serverOffset: currentOffset }
        );
      }

      if (offset < currentOffset) {
        let accumulatedOffset = offset;
        let skipCount = 0;
        for (const line of lines) {
          const lineBytes = Buffer.byteLength(line, "utf8") + 1;
          if (accumulatedOffset + lineBytes <= currentOffset) {
            accumulatedOffset += lineBytes;
            skipCount++;
          } else {
            break;
          }
        }
        linesToInsert = lines.slice(skipCount);
        linesSkipped = skipCount;
      } else {
        linesToInsert = lines;
        linesSkipped = 0;
      }

      let newOffset = Math.max(offset, currentOffset);
      for (const line of linesToInsert) {
        newOffset += Buffer.byteLength(line, "utf8") + 1;
      }

      serverOffset = newOffset;
      tx.set(ledgerRef, { offset: newOffset, updated_at: new Date() });
    });

    if (linesToInsert.length > 0) {
      const rows = linesToInsert.map((line) => {
        let parsed;
        try { parsed = JSON.parse(line); } catch { parsed = {}; }
        return {
          student_id: studentId,
          project_path,
          session_id,
          file_name,
          offset,
          record_type: parsed.type || "unknown",
          timestamp: parsed.timestamp ? new Date(parsed.timestamp).toISOString() : new Date().toISOString(),
          version: parsed.version || null,
          data: line,
        };
      });

      await bigquery.dataset(DATASET).table(TABLE).insert(rows);
    }

    return res.json({
      status: "ok",
      server_offset: serverOffset,
      lines_accepted: linesToInsert.length,
      lines_skipped: linesSkipped,
    });
  } catch (err) {
    if (err.code === "OFFSET_GAP") {
      return res.status(409).json({ error: "Offset gap", server_offset: err.serverOffset });
    }
    console.error("Ingest error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Admin endpoints ── */

app.get("/admin/allowlist", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const domainDoc = await firestore.doc("allowlist/domains").get();
  const emailDoc = await firestore.doc("allowlist/emails").get();
  res.json({
    domains: domainDoc.exists ? domainDoc.data().list : [],
    emails: emailDoc.exists ? emailDoc.data().list : [],
  });
});

app.post("/admin/allowlist/domain", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "Missing domain" });

  const ref = firestore.doc("allowlist/domains");
  const doc = await ref.get();
  const list = doc.exists ? doc.data().list : [];
  const normalized = domain.toLowerCase().trim();
  if (!list.includes(normalized)) {
    list.push(normalized);
    await ref.set({ list });
  }
  res.json({ status: "ok", domains: list });
});

app.delete("/admin/allowlist/domain", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "Missing domain" });

  const ref = firestore.doc("allowlist/domains");
  const doc = await ref.get();
  if (!doc.exists) return res.json({ status: "ok", domains: [] });
  const list = doc.data().list.filter((d) => d !== domain.toLowerCase().trim());
  await ref.set({ list });
  res.json({ status: "ok", domains: list });
});

app.post("/admin/allowlist/email", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { allow_email } = req.body;
  if (!allow_email) return res.status(400).json({ error: "Missing allow_email" });

  const ref = firestore.doc("allowlist/emails");
  const doc = await ref.get();
  const list = doc.exists ? doc.data().list : [];
  const normalized = allow_email.toLowerCase().trim();
  if (!list.includes(normalized)) {
    list.push(normalized);
    await ref.set({ list });
  }
  res.json({ status: "ok", emails: list });
});

app.delete("/admin/allowlist/email", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { allow_email } = req.body;
  if (!allow_email) return res.status(400).json({ error: "Missing allow_email" });

  const ref = firestore.doc("allowlist/emails");
  const doc = await ref.get();
  if (!doc.exists) return res.json({ status: "ok", emails: [] });
  const list = doc.data().list.filter((e) => e !== allow_email.toLowerCase().trim());
  await ref.set({ list });
  res.json({ status: "ok", emails: list });
});

/** Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`agent-logs ingestion service listening on port ${PORT}`);
});
