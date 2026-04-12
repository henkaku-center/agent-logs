import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { readProjects, writeProjects, readCursors, writeCursors, readToken, writeLastSync } from "./config.js";
import { getToken } from "./auth.js";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");
import { INGESTION_URL } from "./constants.js";

/** Record types that are synced */
const ALLOWED_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "progress",
  "summary",
  "custom-title",
  "ai-title",
]);

/**
 * Strip tool_result content blocks from a parsed record.
 * Retains stub with tool_use_id and type, drops content field.
 */
function stripToolResults(record) {
  if (!record.message?.content || !Array.isArray(record.message.content)) {
    return record;
  }
  record.message.content = record.message.content.map((block) => {
    if (block.type === "tool_result") {
      return { type: "tool_result", tool_use_id: block.tool_use_id };
    }
    return block;
  });
  return record;
}

/**
 * Convert a filesystem path to Claude Code's project directory name.
 * e.g. /home/tanaka/coursework/project -> -home-tanaka-coursework-project
 */
function pathToProjectDir(fsPath) {
  return fsPath.replace(/\//g, "-").replace(/^-/, "-");
}

/**
 * Compute tail hash (SHA-256 of last 1024 bytes before offset).
 */
function computeTailHash(filePath, offset) {
  if (offset <= 0) return null;
  const start = Math.max(0, offset - 1024);
  const length = offset - start;
  const fd = readFileSync(filePath);
  const slice = fd.slice(start, start + length);
  return createHash("sha256").update(slice).digest("hex");
}

/**
 * Discover all JSONL files for a project directory, including subagent files.
 */
function discoverJsonlFiles(claudeProjectDir) {
  const files = [];
  if (!existsSync(claudeProjectDir)) return files;

  for (const entry of readdirSync(claudeProjectDir)) {
    const full = join(claudeProjectDir, entry);

    // Main session file: {session-id}.jsonl
    if (entry.endsWith(".jsonl")) {
      files.push({ absolute: full, relative: entry });
    }

    // Subagent directory: {session-id}/subagents/
    const subagentDir = join(full, "subagents");
    if (existsSync(subagentDir)) {
      try {
        for (const sub of readdirSync(subagentDir)) {
          if (sub.endsWith(".jsonl")) {
            const subFull = join(subagentDir, sub);
            const subRel = join(entry, "subagents", sub);
            files.push({ absolute: subFull, relative: subRel });
          }
        }
      } catch {
        // Permission or read error on subagent dir -- skip
      }
    }
  }
  return files;
}

/**
 * Sync all shared projects. Called by Stop, SubagentStop, and SessionEnd hooks.
 */
export async function sync() {
  const projects = readProjects();
  if (!projects.participant_id) {
    writeLastSync({ status: "error", error: "Not logged in" });
    return;
  }
  if (projects.shared.length === 0) {
    writeLastSync({ status: "ok", message: "No shared projects" });
    return;
  }

  let token;
  try {
    token = getToken();
  } catch (err) {
    writeLastSync({ status: "error", error: `Auth failed: ${err.message}` });
    return;
  }

  const cursors = readCursors();
  let totalAccepted = 0;
  let totalSkipped = 0;
  let errors = [];

  for (const projectPath of projects.shared) {
    const projectDirName = pathToProjectDir(projectPath);
    const claudeProjectDir = join(CLAUDE_DIR, projectDirName);
    const jsonlFiles = discoverJsonlFiles(claudeProjectDir);

    for (const { absolute: filePath, relative: relPath } of jsonlFiles) {
      const cursorKey = join(projectDirName, relPath);
      const cursor = cursors[cursorKey] || { offset: 0 };
      const fileSize = statSync(filePath).size;

      // Nothing new
      if (fileSize <= cursor.offset) continue;

      // Validate continuity
      if (fileSize < cursor.offset) {
        // File truncated -- reset cursor
        cursor.offset = 0;
        cursor.tail_hash = null;
      } else if (cursor.offset > 0 && cursor.tail_hash) {
        const currentHash = computeTailHash(filePath, cursor.offset);
        if (currentHash !== cursor.tail_hash) {
          // File rewritten -- reset cursor
          cursor.offset = 0;
          cursor.tail_hash = null;
        }
      }

      // Read from cursor to EOF
      const content = readFileSync(filePath, "utf8");
      const bytes = Buffer.from(content, "utf8");
      const newBytes = bytes.slice(cursor.offset);
      const newText = newBytes.toString("utf8");

      // Truncate at last complete line
      const lastNewline = newText.lastIndexOf("\n");
      if (lastNewline === -1) continue; // No complete lines yet
      const completeText = newText.slice(0, lastNewline + 1);

      // Filter and strip lines
      const filteredLines = [];
      for (const line of completeText.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Skip unparseable lines
        }
        if (!ALLOWED_TYPES.has(parsed.type)) continue;
        const stripped = stripToolResults(parsed);
        filteredLines.push(JSON.stringify(stripped));
      }

      if (filteredLines.length === 0) {
        // Advance cursor past filtered/skipped lines
        const newOffset = cursor.offset + Buffer.byteLength(completeText, "utf8");
        cursors[cursorKey] = {
          offset: newOffset,
          tail_hash: computeTailHash(filePath, newOffset),
        };
        writeCursors(cursors);
        continue;
      }

      // Extract session ID from file path
      const sessionId = relPath.split("/")[0].replace(".jsonl", "");

      // POST to ingestion endpoint
      try {
        const resp = await fetch(`${INGESTION_URL}/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            project_path: projectPath,
            session_id: sessionId,
            file_name: relPath,
            offset: cursor.offset,
            lines: filteredLines,
          }),
        });

        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (resp.status === 409 && body.server_offset != null) {
            // Server returned its offset -- adopt it
            cursors[cursorKey] = {
              offset: body.server_offset,
              tail_hash: computeTailHash(filePath, body.server_offset),
            };
            writeCursors(cursors);
          }
          errors.push(`${relPath}: HTTP ${resp.status}`);
          continue;
        }

        const result = await resp.json();
        cursors[cursorKey] = {
          offset: result.server_offset,
          tail_hash: computeTailHash(filePath, result.server_offset),
        };
        writeCursors(cursors);
        totalAccepted += result.lines_accepted;
        totalSkipped += result.lines_skipped;
      } catch (err) {
        errors.push(`${relPath}: ${err.message}`);
      }
    }
  }

  writeLastSync({
    status: errors.length > 0 ? "partial" : "ok",
    lines_accepted: totalAccepted,
    lines_skipped: totalSkipped,
    errors: errors.length > 0 ? errors : undefined,
  });

  // Sync consent state from server (piggyback on sync hook)
  try {
    const resp = await fetch(`${INGESTION_URL}/portal/consent`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const consent = await resp.json();
      const fresh = readProjects();
      if (fresh.research_use !== (consent.research_use || false)) {
        fresh.research_use = consent.research_use || false;
        writeProjects(fresh);
      }
    }
  } catch {}
}
