import express from "express";
import { BigQuery } from "@google-cloud/bigquery";
import { Firestore } from "@google-cloud/firestore";
import jwt from "jsonwebtoken";
import { google } from "googleapis";
import { randomInt, randomUUID } from "crypto";

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
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const GMAIL_SENDER = process.env.GMAIL_SENDER || "claude@chibatech.dev";
const OTLP_SECRET = process.env.OTLP_SECRET || "change-me-otlp-secret";

/** Admin emails that can manage the allowlist */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "grisha@henkaku.center,contact@gszep.com")
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

      const titleRef = firestore.doc(`session_titles/${studentId}/${session_id}/meta`);
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
  _surveyConfigCache = doc.exists ? doc.data().unlocked || [] : ["pre_study"];
  _surveyConfigExpiry = Date.now() + 60_000;
  return _surveyConfigCache;
}

/* ── Portal endpoints ── */

/** GET /portal/sessions — list student's sessions grouped by project */
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
                     COUNTIF(record_type='assistant') AS assistant_count
              FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\`
              WHERE student_id = @student_id
              GROUP BY project_path, session_id
              ORDER BY MAX(timestamp) DESC
              LIMIT @limit OFFSET @offset`,
      params: { student_id: email, limit: limit + 1, offset },
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

  const update = {
    research_use,
    changed_at: new Date(),
  };

  if (research_use && !existing.anon_id) {
    update.anon_id = randomUUID();
    update.consented_at = new Date();
  }

  await ref.set({ ...existing, ...update }, { merge: true });

  res.json({ status: "ok", research_use, anon_id: existing.anon_id || update.anon_id || null });
});

/** GET /portal/survey — get survey status and any existing responses */
app.get("/portal/survey", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const surveyIds = ["pre_study", "mid_semester", "post_study"];
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

  if (existing.status === "completed") {
    return res.status(403).json({ error: "Survey already submitted. Responses cannot be changed." });
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
  if (!doc.exists) {
    return res.status(400).json({ error: "No consent record found. Set your consent preference first." });
  }
  const existing = doc.data();
  if (existing.signed_at) {
    return res.status(403).json({ error: "Consent form already signed." });
  }

  await ref.update({ signed_at: new Date(), signed_by: email });
  res.json({ status: "ok", signed_at: new Date().toISOString() });
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

/** POST /portal/delete-request — request data deletion */
app.post("/portal/delete-request", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const { project_path, session_id, reason } = req.body;
  if (!project_path) return res.status(400).json({ error: "Missing project_path" });

  const ref = firestore.collection("delete_requests").doc();
  await ref.set({
    student_id: email,
    project_path,
    session_id: session_id || null,
    reason: reason || "",
    state: "pending",
    created_at: new Date(),
  });

  res.json({ status: "ok", request_id: ref.id, state: "pending" });
});

/** GET /portal/delete-requests — list student's delete requests */
app.get("/portal/delete-requests", async (req, res) => {
  const email = requireAuth(req, res);
  if (!email) return;

  const snapshot = await firestore.collection("delete_requests")
    .where("student_id", "==", email)
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`agent-logs ingestion service listening on port ${PORT}`);
});
