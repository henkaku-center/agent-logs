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
 * Magic code login flow:
 * 1. Read email from Claude config or prompt
 * 2. Server checks allowlist, sends 6-digit code via email
 * 3. Prompt for code
 * 4. Server verifies, returns JWT
 */
export async function login() {
  let email = readClaudeEmail();
  if (email) {
    console.log(`Using Claude account: ${email}`);
  } else {
    email = await prompt("Claude account email: ");
  }
  if (!email || !email.includes("@")) {
    throw new Error("Invalid email address");
  }

  // Request verification code
  console.log(`Sending verification code to ${email}...`);
  const sendResp = await fetch(`${INGESTION_URL}/auth/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  if (!sendResp.ok) {
    const body = await sendResp.json().catch(() => ({}));
    throw new Error(
      `Claude account not recognized.\nContact \x1b[4;34mclaude@chibatech.dev\x1b[0m to add your email to the allowlist.`
    );
  }

  // Prompt for code
  const code = await prompt("Enter the 6-digit code from your email: ");
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

  // Store token
  writeToken({ token: result.token, email: result.email });
  return { email: result.email };
}
