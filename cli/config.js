import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".config", "agent-logs");
const PROJECTS_FILE = join(CONFIG_DIR, "projects.yaml");
const CURSORS_FILE = join(CONFIG_DIR, "cursors.json");
const TOKEN_FILE = join(CONFIG_DIR, "token.json");
const LAST_SYNC_FILE = join(CONFIG_DIR, "last-sync.json");

export { CONFIG_DIR, PROJECTS_FILE, CURSORS_FILE, TOKEN_FILE, LAST_SYNC_FILE };

export function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

/** Read projects.yaml (simple key-value parser, no yaml dep needed for POC) */
export function readProjects() {
  if (!existsSync(PROJECTS_FILE)) {
    return { student_id: null, tier_b: false, shared: [], withdrawn: [] };
  }
  const text = readFileSync(PROJECTS_FILE, "utf8");
  const config = { student_id: null, tier_b: false, shared: [], withdrawn: [] };
  let currentList = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("student_id:")) {
      config.student_id = trimmed.slice("student_id:".length).trim();
    } else if (trimmed.startsWith("tier_b:")) {
      config.tier_b = trimmed.slice("tier_b:".length).trim() === "true";
    } else if (trimmed === "shared:") {
      currentList = "shared";
    } else if (trimmed === "withdrawn:") {
      currentList = "withdrawn";
    } else if (trimmed.startsWith("- ") && currentList) {
      config[currentList].push(trimmed.slice(2).trim());
    }
  }
  return config;
}

/** Write projects.yaml */
export function writeProjects(config) {
  ensureConfigDir();
  const lines = [
    `student_id: ${config.student_id || ""}`,
    `tier_b: ${config.tier_b}`,
    "shared:",
    ...config.shared.map((p) => `  - ${p}`),
    "withdrawn:",
    ...config.withdrawn.map((p) => `  - ${p}`),
    "",
  ];
  writeFileSync(PROJECTS_FILE, lines.join("\n"));
}

/** Read cursors.json with atomic-write-safe fallback */
export function readCursors() {
  if (!existsSync(CURSORS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CURSORS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Write cursors.json atomically (write to temp, rename) */
export function writeCursors(cursors) {
  ensureConfigDir();
  const tmp = CURSORS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cursors, null, 2));
  renameSync(tmp, CURSORS_FILE);
}

/** Read stored OAuth token */
export function readToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** Write OAuth token with restrictive permissions */
export function writeToken(token) {
  ensureConfigDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/** Write last sync result */
export function writeLastSync(result) {
  ensureConfigDir();
  const tmp = LAST_SYNC_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2));
  renameSync(tmp, LAST_SYNC_FILE);
}

/** Read last sync result */
export function readLastSync() {
  if (!existsSync(LAST_SYNC_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LAST_SYNC_FILE, "utf8"));
  } catch {
    return null;
  }
}
