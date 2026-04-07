import { readToken, writeToken } from "./config.js";
import { OAuth2Client } from "google-auth-library";

/**
 * OAuth2 authentication for agent-logs CLI.
 *
 * Uses the same pattern as Claude Code: OAuth2 desktop flow with
 * Google identity tokens. The refresh token is stored locally.
 *
 * For Milestone 1 (POC), the OAuth client ID/secret must be configured
 * as environment variables or in the config. In production these would
 * be baked into the distributed binary.
 */

const CLIENT_ID = process.env.AGENT_LOGS_CLIENT_ID || "321175301732-h76b62fmfgvuraf0okl8n77fnm2ldv2m.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.AGENT_LOGS_CLIENT_SECRET || "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";
const REDIRECT_URI = "http://localhost:3000/callback";

export function createOAuthClient() {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Get a valid ID token for the ingestion service.
 * Uses the stored refresh token to obtain a fresh ID token.
 */
export async function getIdToken() {
  // Try gcloud identity token first (development / testing).
  // Cloud Run IAM requires an identity token, not an access token.
  try {
    const { execSync } = await import("child_process");
    const token = execSync("gcloud auth print-identity-token 2>/dev/null", {
      encoding: "utf8",
    }).trim();
    if (token) return token;
  } catch {
    // Fall through to refresh token path
  }

  const stored = readToken();
  if (!stored?.refresh_token) {
    throw new Error("Not logged in. Run `agent-logs login` first.");
  }

  const client = createOAuthClient();
  client.setCredentials({ refresh_token: stored.refresh_token });

  const { credentials } = await client.refreshAccessToken();
  if (credentials.id_token) {
    return credentials.id_token;
  }

  // Fallback: use access token
  return credentials.access_token;
}

/**
 * Run the OAuth2 login flow.
 * Opens a browser for Google sign-in, receives the code via local redirect,
 * exchanges for tokens, and stores the refresh token.
 */
export async function login() {
  const { default: open } = await import("open");
  const { createServer } = await import("http");
  const { URL } = await import("url");

  const client = createOAuthClient();

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
  });

  // Start local server to receive the OAuth callback
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:3000`);
        if (url.pathname !== "/callback") return;

        const code = url.searchParams.get("code");
        if (!code) {
          res.end("No authorization code received.");
          server.close();
          reject(new Error("No authorization code"));
          return;
        }

        const { tokens } = await client.getToken(code);
        writeToken({
          refresh_token: tokens.refresh_token,
          email: null, // Will be populated from ID token
        });

        // Decode email from ID token
        if (tokens.id_token) {
          const payload = JSON.parse(
            Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()
          );
          const stored = readToken();
          stored.email = payload.email;
          writeToken(stored);
        }

        res.end("Login successful! You can close this tab.");
        server.close();
        resolve(readToken());
      } catch (err) {
        res.end("Login failed.");
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log("Opening browser for Google sign-in...");
      open(authUrl);
    });
  });
}
