import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { readProjects, writeProjects, syncConsent, readCursors, writeCursors, readToken, writeLastSync } from "./config.js";
import { getToken } from "./auth.js";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");
import { INGESTION_URL } from "./constants.js";

/** Record types that are synced */
export const ALLOWED_TYPES = new Set([
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
export function stripToolResults(record) {
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
 * e.g. /home/tanaka/projects/my-project -> -home-tanaka-projects-my-project
 */
export function pathToProjectDir(fsPath) {
  return fsPath.replace(/\//g, "-").replace(/^-/, "-");
}

/** Compute tail hash from a buffer (SHA-256 of last 1024 bytes before offset). */
export function tailHash(buf, offset) {
  if (offset <= 0) return null;
  const start = Math.max(0, offset - 1024);
  return createHash("sha256").update(buf.subarray(start, offset)).digest("hex");
}

/** Read a slice of a file into a Buffer (offset to EOF, plus tail bytes for hash). */
export function readFileSlice(filePath, cursorOffset, fileSize) {
  const tailStart = Math.max(0, cursorOffset - 1024);
  const length = fileSize - tailStart;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, length, tailStart);
  } finally {
    closeSync(fd);
  }
  return { buf, tailStart };
}

/**
 * Discover all JSONL files for a project directory, including subagent files.
 */
export function discoverJsonlFiles(claudeProjectDir) {
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

  for (const { path: projectPath, consented_at } of projects.shared) {
    const consentedAtMs = consented_at ? new Date(consented_at).getTime() : 0;
    const projectDirName = pathToProjectDir(projectPath);
    const claudeProjectDir = join(CLAUDE_DIR, projectDirName);
    const jsonlFiles = discoverJsonlFiles(claudeProjectDir);

    for (const { absolute: filePath, relative: relPath } of jsonlFiles) {
      const cursorKey = join(projectDirName, relPath);
      const cursor = cursors[cursorKey] || { offset: 0 };
      const fileSize = statSync(filePath).size;

      // Nothing new
      if (fileSize <= cursor.offset) continue;

      // Single read: tail bytes (for hash check) + new bytes (for sync)
      const { buf, tailStart } = readFileSlice(filePath, cursor.offset, fileSize);

      // Validate continuity
      if (fileSize < cursor.offset) {
        cursor.offset = 0;
        cursor.tail_hash = null;
      } else if (cursor.offset > 0 && cursor.tail_hash) {
        const currentHash = tailHash(buf, cursor.offset - tailStart);
        if (currentHash !== cursor.tail_hash) {
          cursor.offset = 0;
          cursor.tail_hash = null;
        }
      }

      // Extract new text from cursor to EOF
      const newStart = cursor.offset - tailStart;
      const newText = buf.subarray(newStart).toString("utf8");

      // Truncate at last complete line
      const lastNewline = newText.lastIndexOf("\n");
      if (lastNewline === -1) continue;
      const completeText = newText.slice(0, lastNewline + 1);

      // Filter and strip lines
      const filteredLines = [];
      for (const line of completeText.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || !ALLOWED_TYPES.has(parsed.type)) continue;
        if (parsed.timestamp && new Date(parsed.timestamp).getTime() < consentedAtMs) continue;
        const stripped = stripToolResults(parsed);
        filteredLines.push(JSON.stringify(stripped));
      }

      if (filteredLines.length === 0) {
        const newOffset = cursor.offset + Buffer.byteLength(completeText, "utf8");
        cursors[cursorKey] = {
          offset: newOffset,
          tail_hash: tailHash(buf, newOffset - tailStart),
        };
        writeCursors(cursors);
        continue;
      }

      // Raw file offset after the complete text we consumed
      const newFileOffset = cursor.offset + Buffer.byteLength(completeText, "utf8");

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
            file_offset: newFileOffset,
            lines: filteredLines,
          }),
        });

        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (resp.status === 409 && body.server_offset != null) {
            cursors[cursorKey] = {
              offset: body.server_offset,
              tail_hash: tailHash(buf, body.server_offset - tailStart),
            };
            writeCursors(cursors);
          }
          errors.push(`${relPath}: HTTP ${resp.status}`);
          continue;
        }

        const result = await resp.json();
        cursors[cursorKey] = {
          offset: newFileOffset,
          tail_hash: tailHash(buf, newFileOffset - tailStart),
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

  const fresh = readProjects();
  if (await syncConsent(fresh, token, INGESTION_URL)) writeProjects(fresh);
}
