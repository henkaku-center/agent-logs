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

/** Allowed email domains. Only students with these domains can sync logs. */
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || "chibatech.dev,henkaku.center,chibatech.ac.jp")
  .split(",")
  .map((d) => d.trim().toLowerCase());

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

  // Check domain allowlist
  const domain = studentId.split("@")[1]?.toLowerCase();
  if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
    return res.status(403).json({ error: `Domain @${domain} is not authorized` });
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

/** Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`agent-logs ingestion service listening on port ${PORT}`);
});
