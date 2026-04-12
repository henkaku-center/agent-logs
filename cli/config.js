import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".config", "agent-logs");
const PROJECTS_FILE = join(CONFIG_DIR, "projects.json");
const CURSORS_FILE = join(CONFIG_DIR, "cursors.json");
const TOKEN_FILE = join(CONFIG_DIR, "token.json");
const LAST_SYNC_FILE = join(CONFIG_DIR, "last-sync.json");

export { CONFIG_DIR, PROJECTS_FILE, CURSORS_FILE, TOKEN_FILE, LAST_SYNC_FILE };

export function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

/**
 * Read projects config (JSON).
 * shared: array of { path, consented_at } objects
 * withdrawn: array of path strings
 */
export function readProjects() {
  if (!existsSync(PROJECTS_FILE)) {
    return { participant_id: null, research_use: false, shared: [], withdrawn: [] };
  }
  try {
    const config = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
    config.shared = config.shared || [];
    config.withdrawn = config.withdrawn || [];
    return config;
  } catch {
    return { participant_id: null, research_use: false, shared: [], withdrawn: [] };
  }
}

/** Write projects config (JSON) */
export function writeProjects(config) {
  ensureConfigDir();
  writeFileSync(PROJECTS_FILE, JSON.stringify(config, null, 2));
}

/** Check if a path is in the shared list */
export function isShared(projects, path) {
  return projects.shared.some((s) => s.path === path);
}

/** Add a path to shared with current timestamp, removing from withdrawn */
export function addShared(projects, path) {
  projects.shared = projects.shared.filter((s) => s.path !== path);
  projects.shared.push({ path, consented_at: new Date().toISOString() });
  projects.withdrawn = projects.withdrawn.filter((p) => p !== path);
}

/** Remove a path from shared, add to withdrawn */
export function removeShared(projects, path) {
  projects.shared = projects.shared.filter((s) => s.path !== path);
  if (!projects.withdrawn.includes(path)) projects.withdrawn.push(path);
}

/** Sync research_use consent from server. Returns true if changed. */
export async function syncConsent(projects, token, serverUrl) {
  try {
    const resp = await fetch(`${serverUrl}/portal/consent`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (projects.research_use !== (data.research_use || false)) {
        projects.research_use = data.research_use || false;
        return true;
      }
    }
  } catch {}
  return false;
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
