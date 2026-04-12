import express from "express";
import { BigQuery } from "@google-cloud/bigquery";
import { Firestore } from "@google-cloud/firestore";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { randomInt, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "crypto";

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS for portal (GitHub Pages → Cloud Run)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === "https://agent-logs.chibatech.dev" || origin?.startsWith("http://localhost")) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const bigquery = new BigQuery();
const firestore = new Firestore();

const PROJECT_ID = process.env.GCP_PROJECT || "agent-logging";
const DATASET = "course";
const TABLE = "logs";
const COWORK_TABLE = "cowork_events";
const RESEARCH_TABLE = "research_logs";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const GMAIL_SENDER = process.env.GMAIL_SENDER || "claude@chibatech.dev";
const OTLP_SECRET = process.env.OTLP_SECRET || "change-me-otlp-secret";
const SEALED_MAPPING_KEY = process.env.SEALED_MAPPING_KEY || null;

/* ── Sealed mapping helpers ── */

function hashEmail(email) {
  return createHash("sha256").update(email).digest("hex");
}

function sealMapping(email, anonId) {
  const key = Buffer.from(SEALED_MAPPING_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify({ email, anon_id: anonId });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function unsealMapping(sealed) {
  const key = Buffer.from(SEALED_MAPPING_KEY, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "hex")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function signResearchToken(anonId) {
  return jwt.sign({ anon_id: anonId, type: "research" }, JWT_SECRET);
}

async function resolveAnonId(email) {
  const sealedDoc = await firestore.doc(`sealed_mapping/${hashEmail(email)}`).get();
  if (!sealedDoc.exists) return null;
  return unsealMapping(sealedDoc.data()).anon_id;
}

/* ── Phase 1 structural anonymization ── */

function anonymizeRecord(jsonString) {
  const record = JSON.parse(jsonString);

  if (record.cwd) {
    record.cwd = record.cwd.replace(/\/home\/[^/]+\//, "/home/anon/");
  }

  if (record.gitBranch) {
    record.gitBranch = record.gitBranch.replace(/^[^/]+\//, "anon/");
  }

  if (record.requestId && SEALED_MAPPING_KEY) {
    record.requestId = createHmac("sha256", SEALED_MAPPING_KEY)
      .update(record.requestId).digest("hex").slice(0, 20);
  }

  if (record.message?.content && Array.isArray(record.message.content)) {
    for (const block of record.message.content) {
      if (block.type === "tool_use" && block.input) {
        for (const [key, val] of Object.entries(block.input)) {
          if (typeof val === "string") {
            block.input[key] = val.replace(/\/home\/[^/]+\//g, "/home/anon/");
          }
        }
      }
    }
  }

  return JSON.stringify(record);
}

/** Admin emails that can manage the allowlist */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "grisha@henkaku.center,contact@gszep.com")
  .split(",")
  .map((e) => e.trim().toLowerCase());

/* ── Allowlist ── */

async function isAuthorized(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;

  if (ADMIN_EMAILS.includes(email.toLowerCase())) return true;

  const [domainDoc, emailDoc] = await firestore.getAll(
    firestore.doc("allowlist/domains"),
    firestore.doc("allowlist/emails"),
  );
  if (domainDoc.exists && (domainDoc.data().list || []).includes(domain)) return true;
  if (emailDoc.exists && (emailDoc.data().list || []).includes(email.toLowerCase())) return true;

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
    `From: Agent Logs <${GMAIL_SENDER}>`,
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

  // Issue research token (sealed mapping)
  let researchToken;
  if (SEALED_MAPPING_KEY) {
    try {
      const docId = hashEmail(normalized);
      const sealedRef = firestore.doc(`sealed_mapping/${docId}`);
      const sealedDoc = await sealedRef.get();
      let anonId;

      if (sealedDoc.exists) {
        anonId = unsealMapping(sealedDoc.data()).anon_id;
      } else {
        anonId = randomUUID();
        await sealedRef.set({ ...sealMapping(normalized, anonId), updated_at: new Date() });
      }

      researchToken = signResearchToken(anonId);
    } catch (err) {
      console.error("Research token issuance failed:", err.message);
    }
  }

  res.json({ status: "ok", token, email: normalized, ...(researchToken && { research_token: researchToken }) });
});

/* ── Ingest endpoint ── */

app.post("/ingest", async (req, res) => {
  let participantId;
  try {
    participantId = authenticate(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { project_path, session_id, file_name, offset, file_offset, lines, research_token } = req.body;

  if (!project_path || !session_id || !file_name || offset == null || file_offset == null || !Array.isArray(lines)) {
    return res.status(400).json({
      error: "Missing required fields: project_path, session_id, file_name, offset, file_offset, lines",
    });
  }

  // Verify research token upfront (used after course.logs write)
  let researchPayload = null;
  if (research_token && SEALED_MAPPING_KEY) {
    try {
      const payload = jwt.verify(research_token, JWT_SECRET);
      if (payload.type === "research" && payload.anon_id) {
        researchPayload = payload;
      } else {
        console.warn("Invalid research token payload from", participantId);
      }
    } catch {
      console.warn("Invalid research token from", participantId);
    }
  }

  if (lines.length === 0) {
    return res.json({
      status: "ok",
      server_offset: file_offset,
      lines_accepted: 0,
      lines_skipped: 0,
    });
  }

  try {
    const ledgerRef = firestore.doc(`offsets/${participantId}/${session_id}/${file_name}`);
    let linesToInsert;
    let linesSkipped = 0;
    const serverOffset = file_offset;

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
        linesToInsert = [];
        linesSkipped = lines.length;
      } else {
        linesToInsert = lines;
        linesSkipped = 0;
      }

      tx.set(ledgerRef, { offset: serverOffset, updated_at: new Date() });
    });

    if (linesToInsert.length > 0) {
      const rows = linesToInsert.map((line) => {
        let parsed;
        try { parsed = JSON.parse(line); } catch { parsed = {}; }
        return {
          participant_id: participantId,
          project_path,
          session_id,
          file_name,
          record_type: parsed.type || "unknown",
          timestamp: parsed.timestamp ? new Date(parsed.timestamp).toISOString() : new Date().toISOString(),
          version: parsed.version || null,
          data: line,
        };
      });

      await bigquery.dataset(DATASET).table(TABLE).insert(rows);

      const titleRef = firestore.doc(`session_titles/${participantId}/${session_id}/meta`);
      const titleDoc = await titleRef.get();
      if (!titleDoc.exists) {
        for (const line of linesToInsert) {
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }
          if (parsed.type !== "user") continue;
          const content = parsed.message?.content;
          let text = typeof content === "string" ? content
            : Array.isArray(content) ? (content.find((c) => c.type === "text")?.text || "") : "";
          if (text.startsWith("<system>") || text.startsWith("# ")) continue;
          if (text) {
            await titleRef.set({
              title: text.slice(0, 100),
              project_path,
              updated_at: new Date(),
            });
            break;
          }
        }
      }

      // Dual-write to research.logs if participant opted in
      if (researchPayload) {
        try {
          const consentDoc = await firestore.doc(`consent/${participantId}`).get();
          if (consentDoc.exists && consentDoc.data().research_use) {
            const projectHash = createHash("sha256").update(project_path).digest("hex");
            const researchRows = linesToInsert.map((line) => {
              let parsed;
              try { parsed = JSON.parse(line); } catch { parsed = {}; }
              return {
                anon_id: researchPayload.anon_id,
                project_hash: projectHash,
                session_id,
                file_name,
                record_type: parsed.type || "unknown",
                timestamp: parsed.timestamp ? new Date(parsed.timestamp).toISOString() : new Date().toISOString(),
                version: parsed.version || null,
                data: anonymizeRecord(line),
                revoked: false,
              };
            });
            await bigquery.dataset(DATASET).table(RESEARCH_TABLE).insert(researchRows);
          }
        } catch (err) {
          console.error("Research logs write failed:", err.message);
        }
      }
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

/* ── Role management (instructor/researcher access to BigQuery views) ── */

const ROLE_VIEW_MAP = {
  instructor: `${PROJECT_ID}.${DATASET}.logs_view`,
  researcher: `${PROJECT_ID}.${DATASET}.research_logs_view`,
};

async function syncViewAccess(role) {
  const viewId = ROLE_VIEW_MAP[role];
  if (!viewId) return;

  const doc = await firestore.doc(`roles/${role}s`).get();
  const emails = doc.exists ? doc.data().list || [] : [];

  // Grant dataViewer on the specific view
  const table = viewId.split(".").pop();
  const view = bigquery.dataset(DATASET).table(table);

  const [policy] = await view.getIamPolicy();
  policy.bindings = (policy.bindings || []).filter(
    (b) => b.role !== "roles/bigquery.dataViewer"
  );
  if (emails.length > 0) {
    policy.bindings.push({
      role: "roles/bigquery.dataViewer",
      members: emails.map((e) => `user:${e}`),
    });
  }
  await view.setIamPolicy(policy);

  // Grant bigquery.jobUser at project level so they can run queries
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const crm = google.cloudresourcemanager({ version: "v1", auth });
  const { data: projPolicy } = await crm.projects.getIamPolicy({
    resource: PROJECT_ID,
    requestBody: {},
  });

  const jobBinding = (projPolicy.bindings || []).find((b) => b.role === "roles/bigquery.jobUser") || { role: "roles/bigquery.jobUser", members: [] };
  if (!projPolicy.bindings) projPolicy.bindings = [];
  if (!projPolicy.bindings.includes(jobBinding)) projPolicy.bindings.push(jobBinding);

  // Collect all role emails (instructors + researchers) for jobUser
  const allRoleDocs = await firestore.getAll(firestore.doc("roles/instructors"), firestore.doc("roles/researchers"));
  const allRoleEmails = new Set();
  for (const d of allRoleDocs) {
    if (d.exists) for (const e of d.data().list || []) allRoleEmails.add(`user:${e}`);
  }

  // Keep non-user members (service accounts), replace user members with our list
  jobBinding.members = [
    ...jobBinding.members.filter((m) => !m.startsWith("user:")),
    ...allRoleEmails,
  ];

  await crm.projects.setIamPolicy({
    resource: PROJECT_ID,
    requestBody: { policy: projPolicy },
  });
}

app.get("/admin/roles", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const [instDoc, resDoc] = await firestore.getAll(
    firestore.doc("roles/instructors"),
    firestore.doc("roles/researchers"),
  );
  res.json({
    instructors: instDoc.exists ? instDoc.data().list : [],
    researchers: resDoc.exists ? resDoc.data().list : [],
  });
});

app.post("/admin/roles/:role", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { role } = req.params;
  if (!ROLE_VIEW_MAP[role]) return res.status(400).json({ error: "Role must be 'instructor' or 'researcher'" });

  const { email: targetEmail } = req.body;
  if (!targetEmail) return res.status(400).json({ error: "Missing email" });

  const ref = firestore.doc(`roles/${role}s`);
  const doc = await ref.get();
  const list = doc.exists ? doc.data().list || [] : [];
  const normalized = targetEmail.toLowerCase().trim();
  if (!list.includes(normalized)) {
    list.push(normalized);
    await ref.set({ list });
  }

  try { await syncViewAccess(role); } catch (err) {
    console.error(`Failed to sync ${role} view access:`, err.message);
  }

  res.json({ status: "ok", [`${role}s`]: list });
});

app.delete("/admin/roles/:role", async (req, res) => {
  let email;
  try { email = authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!isAdmin(email)) return res.status(403).json({ error: "Admin access required" });

  const { role } = req.params;
  if (!ROLE_VIEW_MAP[role]) return res.status(400).json({ error: "Role must be 'instructor' or 'researcher'" });

  const { email: targetEmail } = req.body;
  if (!targetEmail) return res.status(400).json({ error: "Missing email" });

  const ref = firestore.doc(`roles/${role}s`);
  const doc = await ref.get();
  if (!doc.exists) return res.json({ status: "ok", [`${role}s`]: [] });
  const list = (doc.data().list || []).filter((e) => e !== targetEmail.toLowerCase().trim());
  await ref.set({ list });

  try { await syncViewAccess(role); } catch (err) {
    console.error(`Failed to sync ${role} view access:`, err.message);
  }

  res.json({ status: "ok", [`${role}s`]: list });
});

/* ── Portal helpers ── */

/** Auth middleware — extracts email from JWT or returns 401 */
function requireAuth(req, res) {
  try { return authenticate(req); } catch (err) {
    res.status(401).json({ error: err.message });
    return null;
  }
}

/** Cached survey config (refreshed every 60s) */
let _surveyConfigCache = null;
let _surveyConfigExpiry = 0;
async function getUnlockedSurveys() {
  if (Date.now() < _surveyConfigExpiry) return _surveyConfigCache;
  const doc = await firestore.doc("survey_config/current").get();
  _surveyConfigCache = doc.exists ? doc.data().unlocked || [] : ["pre_course"];
  _surveyConfigExpiry = Date.now() + 60_000;
  return _surveyConfigCache;
}
export function resetSurveyCache() { _surveyConfigCache = null; _surveyConfigExpiry = 0; }

/* ── Portal endpoints ── */

/** GET /portal/sessions — list participant's sessions grouped by project */
app.get("/portal/sessions", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  try {
    // Session summaries with pagination
    const [rows] = await bigquery.query({
      query: `SELECT project_path, session_id,
                     MIN(timestamp) AS first_timestamp,
                     MAX(timestamp) AS last_timestamp,
                     COUNT(*) AS record_count,
                     COUNTIF(record_type='user') AS user_count,
                     COUNTIF(record_type='assistant') AS assistant_count,
                     LOGICAL_OR(COALESCE(revoked, FALSE)) AS revoked
              FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\`
              WHERE participant_id = @participant_id
              GROUP BY project_path, session_id
              ORDER BY MAX(timestamp) DESC
              LIMIT @limit OFFSET @offset`,
      params: { participant_id: email, limit: limit + 1, offset },
    });

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    // Read titles from Firestore cache (single batched RPC)
    const titles = {};
    if (pageRows.length > 0) {
      const titleRefs = pageRows.map((r) => firestore.doc(`session_titles/${email}/${r.session_id}/meta`));
      const titleDocs = await firestore.getAll(...titleRefs);
      titleDocs.forEach((doc, i) => {
        if (doc.exists) titles[pageRows[i].session_id] = doc.data().title;
      });
    }

    const projects = {};
    for (const row of pageRows) {
      if (!projects[row.project_path]) projects[row.project_path] = [];
      projects[row.project_path].push({
        session_id: row.session_id,
        title: titles[row.session_id] || null,
        first_timestamp: row.first_timestamp?.value,
        last_timestamp: row.last_timestamp?.value,
        record_count: row.record_count,
        user_count: row.user_count,
        assistant_count: row.assistant_count,
        revoked: row.revoked || false,
      });
    }

    res.json({
      projects: Object.entries(projects).map(([path, sessions]) => ({
        project_path: path,
        sessions,
      })),
      has_more: hasMore,
      offset,
      limit,
    });
  } catch (err) {
    console.error("Sessions query error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

/** GET /portal/consent — get research-use consent state */
app.get("/portal/consent", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const doc = await firestore.doc(`consent/${email}`).get();
  if (!doc.exists) {
    return res.json({ research_use: false });
  }
  const data = doc.data();
  res.json({
    research_use: data.research_use || false,
    consented_at: data.consented_at?.toDate?.()?.toISOString() || null,
    signed_at: data.signed_at?.toDate?.()?.toISOString() || null,
  });
});

/** POST /portal/consent — toggle research-use consent */
app.post("/portal/consent", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { research_use } = req.body;
  if (typeof research_use !== "boolean") {
    return res.status(400).json({ error: "research_use must be a boolean" });
  }

  const ref = firestore.doc(`consent/${email}`);
  const doc = await ref.get();
  const existing = doc.exists ? doc.data() : {};
  const wasOptedIn = existing.research_use === true;

  const update = {
    research_use,
    changed_at: new Date(),
  };

  if (research_use && !existing.consented_at) {
    update.consented_at = new Date();
  }

  await ref.set({ ...existing, ...update }, { merge: true });

  let backfill_count = 0;
  if (SEALED_MAPPING_KEY && research_use !== wasOptedIn) {
    try {
      const anonId = await resolveAnonId(email);
      if (anonId) {
        if (!research_use) {
          // Opt-out: flag all research rows as revoked
          await bigquery.query({
            query: `UPDATE \`${PROJECT_ID}.${DATASET}.${RESEARCH_TABLE}\` SET revoked = true WHERE anon_id = @anon_id`,
            params: { anon_id: anonId },
          });
        } else {
          // Opt-in: restore any previously revoked rows
          if (wasOptedIn === false) {
            await bigquery.query({
              query: `UPDATE \`${PROJECT_ID}.${DATASET}.${RESEARCH_TABLE}\` SET revoked = false WHERE anon_id = @anon_id`,
              params: { anon_id: anonId },
            });
          }

          // Backfill: copy course.logs rows not yet in research.logs
          const consentedAt = update.consented_at || existing.consented_at;
          const sinceDate = consentedAt instanceof Date ? consentedAt : consentedAt?.toDate?.() || new Date(0);

          const [rows] = await bigquery.query({
            query: `SELECT c.project_path, c.session_id, c.file_name, c.record_type, c.timestamp, c.version, c.data
                    FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` c
                    LEFT JOIN \`${PROJECT_ID}.${DATASET}.${RESEARCH_TABLE}\` r
                      ON r.anon_id = @anon_id AND r.session_id = c.session_id
                    WHERE c.participant_id = @email AND c.timestamp >= @since AND r.session_id IS NULL
                    ORDER BY c.timestamp ASC`,
            params: { email, since: sinceDate.toISOString(), anon_id: anonId },
          });

          if (rows.length > 0) {
            const newRows = rows.map((r) => ({
              anon_id: anonId,
              project_hash: createHash("sha256").update(r.project_path).digest("hex"),
              session_id: r.session_id,
              file_name: r.file_name,
              record_type: r.record_type,
              timestamp: r.timestamp?.value || r.timestamp,
              version: r.version || null,
              data: anonymizeRecord(r.data),
              revoked: false,
            }));
            await bigquery.dataset(DATASET).table(RESEARCH_TABLE).insert(newRows);
            backfill_count = newRows.length;
          }
        }
      }
    } catch (err) {
      console.error("Research consent sync failed:", err.message);
    }
  }

  res.json({ status: "ok", research_use, ...(backfill_count > 0 && { backfill_count }) });
});

/** GET /portal/survey — get survey status and any existing responses */
app.get("/portal/survey", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const surveyIds = ["pre_course", "mid_course", "post_course"];
  const unlocked = await getUnlockedSurveys();

  // Fetch all responses in parallel (single batched read)
  const unlockedIds = surveyIds.filter((id) => unlocked.includes(id));
  const refs = unlockedIds.map((id) => firestore.doc(`survey_responses/${email}/${id}/data`));
  const docs = refs.length > 0 ? await firestore.getAll(...refs) : [];

  const surveys = {};
  let docIdx = 0;
  for (const surveyId of surveyIds) {
    if (!unlocked.includes(surveyId)) {
      surveys[surveyId] = { status: "locked" };
      continue;
    }
    const respDoc = docs[docIdx++];
    if (!respDoc.exists) {
      surveys[surveyId] = { status: "not_started", responses: null };
    } else {
      const data = respDoc.data();
      surveys[surveyId] = {
        status: data.status || "in_progress",
        responses: data.responses || {},
        completed_at: data.completed_at?.toDate?.()?.toISOString() || null,
        signed_at: data.signed_at?.toDate?.()?.toISOString() || null,
      };
    }
  }

  res.json({ surveys });
});

/** POST /portal/survey — submit or update survey responses */
app.post("/portal/survey", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { survey_id, responses, completed } = req.body;
  if (!survey_id || !responses) {
    return res.status(400).json({ error: "Missing survey_id or responses" });
  }

  const unlocked = await getUnlockedSurveys();
  if (!unlocked.includes(survey_id)) {
    return res.status(403).json({ error: "This survey is not currently available" });
  }

  const ref = firestore.doc(`survey_responses/${email}/${survey_id}/data`);
  const existing = (await ref.get()).data() || {};

  if (existing.signed_at) {
    return res.status(403).json({ error: "Survey has been signed. Responses cannot be changed." });
  }

  if (completed) {
    const merged = { ...(existing.responses || {}), ...responses };
    if (Object.keys(merged).length === 0) {
      return res.status(400).json({ error: "Cannot submit an empty survey." });
    }
  }

  const update = {
    responses: { ...(existing.responses || {}), ...responses },
    updated_at: new Date(),
    status: completed ? "completed" : "in_progress",
  };

  if (!existing.started_at) update.started_at = new Date();
  if (completed) update.completed_at = new Date();

  await ref.set(update, { merge: true });

  res.json({ status: "ok", survey_id, survey_status: update.status });
});

/** POST /portal/consent/sign — sign the consent form (locks it) */
app.post("/portal/consent/sign", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const ref = firestore.doc(`consent/${email}`);
  const doc = await ref.get();
  const existing = doc.exists ? doc.data() : {};
  if (existing.signed_at) {
    return res.status(403).json({ error: "Consent form already signed." });
  }

  const { consent_html, research_use } = req.body;
  const signedAt = new Date();

  // Generate archival HTML document
  const archiveHtml = `<!DOCTYPE html>
<html><head><title>Informed Consent — Agent Logs</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; max-width: 700px; margin: 40px auto; font-size: 14px; line-height: 1.6; color: #333; }
  h1 { font-size: 20px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  h2 { font-size: 16px; margin-top: 24px; }
  h3 { text-align: center; margin: 0 0 4px; font-size: 16px; }
  h4 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .signature { margin-top: 32px; padding-top: 16px; border-top: 2px solid #000; }
  .signature .check { color: #2E7D32; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
  th { font-weight: bold; font-size: 12px; text-transform: uppercase; color: #666; }
  ul { padding-left: 20px; } li { margin-bottom: 8px; }
  .info-box { background: #E3F2FD; padding: 16px 20px; margin: 12px 0; }
  .info-box.warning { background: #FFF3E0; }
  @media print { body { margin: 20px; } }
</style></head><body>
  <h1>Informed Consent — Agent Logs</h1>
  <div class="meta">Participant: ${email} · Signed: ${signedAt.toISOString()}</div>
  <h2>Consent Preferences</h2>
  <table>
    <tr><th>Educational-use</th><td>✓ Enabled</td></tr>
    <tr><th>Research-use</th><td>${research_use ? "✓ Opted in" : "○ Not enrolled"}</td></tr>
  </table>
  <div class="signature">
    <p class="check">✓ Signed by participant on ${signedAt.toLocaleString()}</p>
  </div>
  <hr style="margin:32px 0">
  ${consent_html || ""}
</body></html>`;

  const consent_pdf = Buffer.from(archiveHtml, "utf8").toString("base64");

  await ref.set({
    ...existing,
    research_use: research_use ?? existing.research_use ?? false,
    signed_at: signedAt,
    signed_by: email,
    consent_pdf,
    ...(!existing.consented_at && { consented_at: signedAt }),
  }, { merge: true });
  res.json({ status: "ok", signed_at: signedAt.toISOString() });
});

/** GET /portal/consent/pdf — download the signed consent form */
app.get("/portal/consent/pdf", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const doc = await firestore.doc(`consent/${email}`).get();
  if (!doc.exists || !doc.data().consent_pdf) {
    return res.status(404).json({ error: "No signed consent form found." });
  }

  const html = Buffer.from(doc.data().consent_pdf, "base64").toString("utf8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/** POST /portal/survey/sign — sign a completed survey (locks it) */
app.post("/portal/survey/sign", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { survey_id } = req.body;
  if (!survey_id) return res.status(400).json({ error: "Missing survey_id" });

  const ref = firestore.doc(`survey_responses/${email}/${survey_id}/data`);
  const doc = await ref.get();
  if (!doc.exists || doc.data().status !== "completed") {
    return res.status(400).json({ error: "Survey must be submitted before signing." });
  }
  if (doc.data().signed_at) {
    return res.status(403).json({ error: "Survey already signed." });
  }

  await ref.update({ signed_at: new Date(), signed_by: email });
  res.json({ status: "ok", signed_at: new Date().toISOString() });
});

/** POST /portal/revoke — toggle revoked flag on session data */
app.post("/portal/revoke", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { project_path, session_id, revoked } = req.body;
  if (!project_path || typeof revoked !== "boolean") {
    return res.status(400).json({ error: "Missing project_path or revoked boolean" });
  }

  try {
    const whereClause = session_id
      ? `participant_id = @email AND project_path = @project_path AND session_id = @session_id`
      : `participant_id = @email AND project_path = @project_path`;
    const params = { email, project_path };
    if (session_id) params.session_id = session_id;

    await bigquery.query({
      query: `UPDATE \`${PROJECT_ID}.${DATASET}.${TABLE}\` SET revoked = @revoked WHERE ${whereClause}`,
      params: { ...params, revoked },
    });

    // Cascade to research.logs
    if (SEALED_MAPPING_KEY) {
      try {
        const anonId = await resolveAnonId(email);
        if (anonId) {
          const projectHash = createHash("sha256").update(project_path).digest("hex");
          const researchWhere = session_id
            ? `anon_id = @anon_id AND project_hash = @project_hash AND session_id = @session_id`
            : `anon_id = @anon_id AND project_hash = @project_hash`;
          const researchParams = { anon_id: anonId, project_hash: projectHash };
          if (session_id) researchParams.session_id = session_id;

          await bigquery.query({
            query: `UPDATE \`${PROJECT_ID}.${DATASET}.${RESEARCH_TABLE}\` SET revoked = @revoked WHERE ${researchWhere}`,
            params: { ...researchParams, revoked },
          });
        }
      } catch (err) {
        console.error("Research revoke cascade failed:", err.message);
      }
    }

    res.json({ status: "ok", revoked });
  } catch (err) {
    console.error("Revoke error:", err);
    res.status(500).json({ error: "Failed to update revocation status" });
  }
});

/** POST /portal/delete-request — request data deletion */
app.post("/portal/delete-request", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { project_path, session_id, reason } = req.body;
  if (!project_path) return res.status(400).json({ error: "Missing project_path" });

  const ref = firestore.collection("delete_requests").doc();
  await ref.set({
    participant_id: email,
    project_path,
    session_id: session_id || null,
    reason: reason || "",
    state: "pending",
    created_at: new Date(),
  });

  res.json({ status: "ok", request_id: ref.id, state: "pending" });
});

/** GET /portal/delete-requests — list participant's delete requests */
app.get("/portal/delete-requests", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const snapshot = await firestore.collection("delete_requests")
    .where("participant_id", "==", email)
    .orderBy("created_at", "desc")
    .get();

  const requests = snapshot.docs.map((doc) => ({
    request_id: doc.id,
    ...doc.data(),
    created_at: doc.data().created_at?.toDate?.()?.toISOString(),
  }));

  res.json({ requests });
});

/* ── OTLP ingestion (Claude Code & Cowork telemetry) ── */
// Accepts OTLP HTTP/JSON logs/events from Claude Code and Cowork.
// Events: user_prompt, tool_result, api_request, api_error, tool_decision
// Future: Compliance API will be another data source once Enterprise upgrade completes.

function parseOtlpAttributes(attrs) {
  const result = {};
  for (const attr of attrs || []) {
    const v = attr.value;
    result[attr.key] = v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? "";
  }
  return result;
}

/**
 * POST /v1/logs — OTLP HTTP/JSON logs endpoint
 * Receives OpenTelemetry log records from Claude Code/Cowork.
 * Auth via Bearer token in OTLP headers (shared secret).
 */
app.post("/v1/logs", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${OTLP_SECRET}`) {
    return res.status(401).json({ error: "Invalid OTLP authorization" });
  }

  try {
    const { resourceLogs } = req.body;
    if (!resourceLogs || !Array.isArray(resourceLogs)) {
      return res.status(400).json({ error: "Invalid OTLP logs payload" });
    }

    const rows = [];

    for (const rl of resourceLogs) {
      const resourceAttrs = parseOtlpAttributes(rl.resource?.attributes);

      for (const scopeLog of rl.scopeLogs || []) {
        for (const logRecord of scopeLog.logRecords || []) {
          const attrs = parseOtlpAttributes(logRecord.attributes);

          rows.push({
            user_email: resourceAttrs["user.email"] || attrs["user.email"] || "",
            organization_id: resourceAttrs["organization.id"] || attrs["organization.id"] || "",
            session_id: resourceAttrs["session.id"] || attrs["session.id"] || "",
            prompt_id: attrs["prompt.id"] || "",
            event_type: attrs["event.name"] || logRecord.severityText || "unknown",
            timestamp: logRecord.timeUnixNano
              ? new Date(Number(BigInt(logRecord.timeUnixNano) / 1000000n)).toISOString()
              : new Date().toISOString(),
            data: JSON.stringify({ ...resourceAttrs, ...attrs }),
          });
        }
      }
    }

    if (rows.length > 0) {
      await bigquery.dataset(DATASET).table(COWORK_TABLE).insert(rows);
    }

    res.json({ partialSuccess: {} });
  } catch (err) {
    console.error("OTLP ingestion error:", err);
    res.status(500).json({ error: "Failed to ingest telemetry" });
  }
});

/** POST /v1/traces — accept but no-op (traces not stored yet) */
app.post("/v1/traces", (req, res) => {
  res.json({ partialSuccess: {} });
});

/** POST /v1/metrics — accept but no-op (metrics not stored yet) */
app.post("/v1/metrics", (req, res) => {
  res.json({ partialSuccess: {} });
});

/** Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export { app, anonymizeRecord };

const PORT = process.env.PORT || 8080;
if (!process.env.NODE_ENV?.startsWith("test")) {
  app.listen(PORT, () => {
    console.log(`agent-logs ingestion service listening on port ${PORT}`);
  });
}
