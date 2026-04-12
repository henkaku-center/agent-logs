import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readToken, writeToken } from "./config.js";
import { INGESTION_URL } from "./constants.js";
import { createInterface } from "readline";

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Read email from Claude Code's config (~/.claude.json) */
function readClaudeEmail() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return config.oauthAccount?.emailAddress || null;
  } catch {
    return null;
  }
}

/**
 * Get the stored JWT token for API requests.
 */
export function getToken() {
  const stored = readToken();
  if (!stored?.token) {
    throw new Error("Not logged in. Run `agent-logs login` first.");
  }
  return stored.token;
}

/**
 * Authenticated fetch wrapper for server API calls.
 */
export async function authFetch(path, method = "GET", body) {
  const token = getToken();
  const resp = await fetch(`${INGESTION_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Request failed: ${resp.status}`);
  return data;
}

/**
 * Magic code login flow:
 * 1. Read email from Claude config or prompt
 * 2. Server checks allowlist, sends 6-digit code via email
 * 3. Prompt for code
 * 4. Server verifies, returns JWT
 */
export async function login() {
  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
  const cols = process.stdout.columns || 89;
  let lines = 0;
  const log = (msg) => { console.log(msg); lines += msg.split("\n").length; };

  log(`${cyan("─".repeat(cols))}\n${cyan(" Agent Logging Authentication")}\n`);

  let email = readClaudeEmail();
  if (!email) {
    email = await prompt(" Email address: ");
    lines += 1;
    if (!email || !email.includes("@")) {
      throw new Error("Invalid email address");
    }
  }

  // Request verification code
  const sendResp = await fetch(`${INGESTION_URL}/auth/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!sendResp.ok) {
    throw new Error(
      `Claude account not recognized.\n Contact \x1b[4;36mclaude@chibatech.dev\x1b[0m to add your email to the allowlist.\n Otherwise use \x1b[1magent-logs uninstall\x1b[0m to remove this tool.`
    );
  }
  log(` Verification code sent to ${email}`);

  // Prompt for code
  const code = await prompt(" Enter the 6-digit code from your email: ");
  lines += 1;
  if (!code) {
    throw new Error("No code entered");
  }

  // Verify code
  const verifyResp = await fetch(`${INGESTION_URL}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });

  const result = await verifyResp.json().catch(() => ({}));
  if (!verifyResp.ok) {
    throw new Error(result.error || `Verification failed: ${verifyResp.status}`);
  }

  // Store token (includes research_token if server issued one)
  writeToken({ token: result.token, email: result.email, research_token: result.research_token || null });
  // Clear auth dialog
  process.stdout.write(`\x1b[${lines}A\x1b[J`);
  return { email: result.email };
}
