import express from "express";
import { BigQuery } from "@google-cloud/bigquery";
import { Firestore } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(express.json({ limit: "5mb" }));

const bigquery = new BigQuery();
const firestore = new Firestore();
const authClient = new OAuth2Client();

const PROJECT_ID = process.env.GCP_PROJECT || "agent-logging";
const DATASET = "course";
const TABLE = "logs";

/** Admin emails that can manage the allowlist */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "grisha@henkaku.center")
  .split(",")
  .map((e) => e.trim().toLowerCase());

/**
 * Check if an email is authorized to sync.
 * Checks Firestore allowlist: allowed_domains and allowed_emails collections.
 */
async function isAuthorized(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;

  // Check domain allowlist
  const domainDoc = await firestore.doc(`allowlist/domains`).get();
  if (domainDoc.exists) {
    const domains = domainDoc.data().list || [];
    if (domains.includes(domain)) return true;
  }

  // Check individual email allowlist
  const emailDoc = await firestore.doc(`allowlist/emails`).get();
  if (emailDoc.exists) {
    const emails = emailDoc.data().list || [];
    if (emails.includes(email.toLowerCase())) return true;
  }

  return false;
}

/** Check if the authenticated user is an admin */
function isAdmin(email) {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Verify caller identity.
 *
 * Cloud Run IAM authenticates requests before they reach this service.
 * The original Authorization header is consumed by Cloud Run's auth layer
 * and replaced with X-Serverless-Authorization containing the verified token.
 * We decode the email from whichever token header is available.
 */
async function authenticate(req) {
  // Try X-Serverless-Authorization first (Cloud Run IAM forwards verified token here)
  // Then fall back to Authorization (direct calls, local dev)
  const serverlessAuth = req.headers["x-serverless-authorization"];
  const authHeader = req.headers.authorization;
  const header = serverlessAuth || authHeader;

  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = header.slice(7);

  // Cloud Run IAM verifies the token and strips the signature before forwarding.
  // The token arrives with "SIGNATURE_REMOVED_BY_GOOGLE" as the signature,
  // so we decode the payload directly — authentication is already done by IAM.
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    if (payload?.email) return payload.email;
  } catch {
    // fall through
  }
  throw new Error("Could not extract email from token");
}

/**
 * POST /ingest
 *
 * Accepts new JSONL lines from student sync agents.
 * Deduplicates via offset ledger in Firestore, writes to BigQuery.
 */
app.post("/ingest", async (req, res) => {
  let studentId;
  try {
    studentId = await authenticate(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  // Check allowlist
  if (!(await isAuthorized(studentId))) {
    return res.status(403).json({
      error: `${studentId} is not authorized. Use the same email as your Claude Enterprise account, or contact claude@chibatech.dev to be added.`,
    });
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
    // Dedup via Firestore offset ledger (transactional)
    const ledgerRef = firestore.doc(`offsets/${studentId}/${session_id}/${file_name}`);
    let linesToInsert;
    let linesSkipped = 0;
    let serverOffset;

    await firestore.runTransaction(async (tx) => {
      const ledgerDoc = await tx.get(ledgerRef);
      const currentOffset = ledgerDoc.exists ? ledgerDoc.data().offset : 0;

      if (offset > currentOffset) {
        // Gap -- client is ahead of server. Reject so client can re-align.
        throw Object.assign(
          new Error(`Offset gap: client=${offset}, server=${currentOffset}`),
          { code: "OFFSET_GAP", serverOffset: currentOffset }
        );
      }

      if (offset < currentOffset) {
        // Re-upload after cursor reset. Skip lines the server already has.
        // Calculate how many bytes we need to skip.
        // Each line's byte length contributes to the offset.
        let accumulatedOffset = offset;
        let skipCount = 0;
        for (const line of lines) {
          const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
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
        // Exact match -- normal append
        linesToInsert = lines;
        linesSkipped = 0;
      }

      // Calculate new offset from accepted lines
      let newOffset = Math.max(offset, currentOffset);
      for (const line of linesToInsert) {
        newOffset += Buffer.byteLength(line, "utf8") + 1;
      }

      serverOffset = newOffset;
      tx.set(ledgerRef, { offset: newOffset, updated_at: new Date() });
    });

    // Write accepted lines to BigQuery
    if (linesToInsert.length > 0) {
      const rows = linesToInsert.map((line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = {};
        }
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
      return res.status(409).json({
        error: "Offset gap",
        server_offset: err.serverOffset,
      });
    }
    console.error("Ingest error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/** GET /check-auth — verify the caller is on the allowlist */
app.get("/check-auth", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const authorized = await isAuthorized(email);
  if (!authorized) {
    return res.status(403).json({
      error: `${email} is not authorized. Use the same email as your Claude Enterprise account, or contact claude@chibatech.dev to be added.`,
    });
  }
  res.json({ status: "ok", email });
});

/* ── Admin endpoints ── */

/** GET /admin/allowlist — list all allowed domains and emails */
app.get("/admin/allowlist", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
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

/** POST /admin/allowlist/domain — add a domain */
app.post("/admin/allowlist/domain", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
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

/** DELETE /admin/allowlist/domain — remove a domain */
app.delete("/admin/allowlist/domain", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
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

/** POST /admin/allowlist/email — add an individual email */
app.post("/admin/allowlist/email", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
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

/** DELETE /admin/allowlist/email — remove an individual email */
app.delete("/admin/allowlist/email", async (req, res) => {
  let email;
  try { email = await authenticate(req); } catch (err) {
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
