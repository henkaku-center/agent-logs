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
 * 1. Prompt for email
 * 2. Server checks allowlist, sends 6-digit code via email
 * 3. Prompt for code
 * 4. Server verifies, returns JWT
 */
export async function login() {
  const email = await prompt("Enter your email (same as your Claude account): ");
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
    throw new Error(body.error || `Server error: ${sendResp.status}`);
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
