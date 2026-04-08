#!/usr/bin/env node

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readProjects, writeProjects, ensureConfigDir, readLastSync, readToken, writeToken } from "./config.js";
import { INGESTION_URL } from "./constants.js";
import { login, getToken } from "./auth.js";
import { registerHooks, unregisterHooks, hooksRegistered } from "./hooks.js";
import { sync } from "./sync.js";

const command = process.argv[2];

/**
 * Prompt user for consent decision via /dev/tty.
 * Hooks receive piped stdin from Claude, so we read the terminal directly.
 * Returns true for yes (share), false for no (decline).
 * Default is yes (press Enter to accept), matching the meeting agreement.
 */
async function promptConsent() {
  const green = (s) => `\x1b[32m${s}\x1b[0m`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;

  let ttyIn;
  try {
    ttyIn = createReadStream("/dev/tty");
  } catch {
    // No TTY available (non-interactive environment) — default to no
    return false;
  }

  const rl = createInterface({ input: ttyIn, output: process.stderr });

  try {
    return await new Promise((resolve) => {
      rl.question(
        `\n  ${green("❯")} ${bold("Yes, share this folder")}  /  No, don't share  ${dim("[Y/n]")} `,
        (answer) => {
          const a = answer.trim().toLowerCase();
          resolve(a === "" || a === "y" || a === "yes");
        }
      );
    });
  } finally {
    rl.close();
    ttyIn.close();
  }
}

// Commands that don't require authentication
const PUBLIC_COMMANDS = new Set(["login", "uninstall", "consent-dialog", "sync", undefined]);

if (!PUBLIC_COMMANDS.has(command)) {
  const token = readToken();
  if (!token?.token || !token?.email) {
    console.error("Not logged in. Run `agent-logs login` first.");
    process.exit(1);
  }
}

switch (command) {
  case "login": {
    console.log("Logging in to agent-logs...");
    try {
      const result = await login();
      console.log(`Authenticated as: ${result.email}`);

      // Initialize projects config
      const projects = readProjects();
      projects.student_id = result.email;
      writeProjects(projects);

      // Register Claude Code hooks
      registerHooks();
      console.log("Claude Code hooks registered.");
      console.log("Setup complete. Use `agent-logs consent` in a project directory to start sharing.");
    } catch (err) {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }

  case "consent": {
    const cwd = process.cwd();
    const projects = readProjects();
    projects.withdrawn = projects.withdrawn.filter((p) => p !== cwd);
    if (!projects.shared.includes(cwd)) {
      projects.shared.push(cwd);
    }
    writeProjects(projects);
    console.log(`Sharing enabled for: ${cwd}`);
    break;
  }

  case "withdraw": {
    const cwd = process.cwd();
    const projects = readProjects();
    projects.shared = projects.shared.filter((p) => p !== cwd);
    if (!projects.withdrawn.includes(cwd)) {
      projects.withdrawn.push(cwd);
    }
    writeProjects(projects);
    console.log(`Sharing disabled for: ${cwd}`);
    console.log("Previously synced data remains on the server. Submit a delete request via the portal to remove it.");
    break;
  }

  case "logout": {
    const token = readToken();
    if (!token?.email) {
      console.log("Not logged in.");
      break;
    }
    writeToken({});
    console.log(`Logged out. Hooks are still registered — sync will fail until you log in again.`);
    break;
  }

  case "consent-dialog": {
    // Runs BEFORE claude launches (called by shell wrapper, not a hook).
    // If folder state is already known, exits immediately. Otherwise
    // shows an interactive Y/n prompt like Claude's own trust dialog.
    const projects = readProjects();
    const cwd = process.cwd();

    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
    const green = (s) => `\x1b[32m${s}\x1b[0m`;
    const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
    const blue = (s) => `\x1b[34m${s}\x1b[0m`;
    const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
    const line = dim("─".repeat(52));

    // Not logged in — nothing to ask
    const tokenData = readToken();
    if (!tokenData?.token) break;

    // Already decided — skip
    if (projects.shared.includes(cwd) || projects.withdrawn.includes(cwd)) break;

    // Unknown folder — show consent dialog
    console.log([
      line,
      `  ${bold("Chiba Tech SDS")} ${dim("· agent-logs")}`,
      ``,
      `  ${bold("Share session logs for this workspace?")}`,
      `  ${cyan(cwd)}`,
      ``,
      `  Session logs from this folder will be shared with`,
      `  your course instructors for grading and feedback.`,
      ``,
      `  You can change this anytime with ${blue("agent-logs withdraw")}`,
      `  ${dim("└")} ${dim(projects.student_id)}`,
      line,
    ].join("\n"));

    const choice = await promptConsent();

    if (choice) {
      projects.shared.push(cwd);
      projects.withdrawn = projects.withdrawn.filter((p) => p !== cwd);
      writeProjects(projects);
      console.log(`  ${green("●")} Sharing enabled.\n`);
    } else {
      projects.withdrawn.push(cwd);
      projects.shared = projects.shared.filter((p) => p !== cwd);
      writeProjects(projects);
      console.log(`  ${yellow("○")} Sharing declined.\n`);
    }
    break;
  }

  case "sync": {
    await sync();
    break;
  }

  case "doctor": {
    console.log("agent-logs doctor\n");
    const token = readToken();
    console.log(`Auth:     ${token?.email ? `logged in as ${token.email}` : "NOT LOGGED IN"}`);
    console.log(`Hooks:    ${hooksRegistered() ? "registered" : "NOT REGISTERED"}`);

    const projects = readProjects();
    console.log(`Projects: ${projects.shared.length} shared, ${projects.withdrawn.length} withdrawn`);

    const lastSync = readLastSync();
    if (lastSync) {
      console.log(`Last sync: ${lastSync.status} at ${lastSync.timestamp}`);
      if (lastSync.errors) {
        console.log(`  Errors: ${lastSync.errors.join(", ")}`);
      }
    } else {
      console.log("Last sync: never");
    }

    try {
      const resp = await fetch(`${INGESTION_URL}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await resp.json();
      console.log(`Server:   ${INGESTION_URL} — ${body.status}`);
    } catch (err) {
      console.log(`Server:   ${INGESTION_URL} — UNREACHABLE (${err.message})`);
    }
    break;
  }

  case "admin": {
    const subcommand = process.argv[3];
    const arg = process.argv[4];

    let token;
    try {
      token = getToken();
    } catch (err) {
      console.error("Auth failed:", err.message);
      process.exit(1);
    }

    const adminFetch = async (path, method = "GET", body) => {
      const resp = await fetch(`${INGESTION_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
      return data;
    };

    switch (subcommand) {
      case "list": {
        const data = await adminFetch("/admin/allowlist");
        console.log("Allowed domains:");
        for (const d of data.domains) console.log(`  @${d}`);
        console.log("\nAllowed emails:");
        for (const e of data.emails) console.log(`  ${e}`);
        if (data.domains.length === 0 && data.emails.length === 0) {
          console.log("  (none — no students can sync)");
        }
        break;
      }
      case "add-domain": {
        if (!arg) { console.error("Usage: agent-logs admin add-domain <domain>"); process.exit(1); }
        const data = await adminFetch("/admin/allowlist/domain", "POST", { domain: arg });
        console.log(`Added @${arg}. Domains: ${data.domains.map(d => "@" + d).join(", ")}`);
        break;
      }
      case "remove-domain": {
        if (!arg) { console.error("Usage: agent-logs admin remove-domain <domain>"); process.exit(1); }
        const data = await adminFetch("/admin/allowlist/domain", "DELETE", { domain: arg });
        console.log(`Removed @${arg}. Domains: ${data.domains.map(d => "@" + d).join(", ")}`);
        break;
      }
      case "add-email": {
        if (!arg) { console.error("Usage: agent-logs admin add-email <email>"); process.exit(1); }
        const data = await adminFetch("/admin/allowlist/email", "POST", { allow_email: arg });
        console.log(`Added ${arg}. Emails: ${data.emails.join(", ")}`);
        break;
      }
      case "remove-email": {
        if (!arg) { console.error("Usage: agent-logs admin remove-email <email>"); process.exit(1); }
        const data = await adminFetch("/admin/allowlist/email", "DELETE", { allow_email: arg });
        console.log(`Removed ${arg}. Emails: ${data.emails.join(", ")}`);
        break;
      }
      default:
        console.log(`Usage: agent-logs admin <command>

Commands:
  list                     Show allowed domains and emails
  add-domain <domain>      Allow all emails from a domain
  remove-domain <domain>   Remove a domain
  add-email <email>        Allow a specific email address
  remove-email <email>     Remove a specific email address`);
    }
    break;
  }

  case "uninstall": {
    const { rmSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    unregisterHooks();
    console.log("Claude Code hooks removed.");

    const configDir = join(homedir(), ".config", "agent-logs");
    try {
      rmSync(configDir, { recursive: true });
      console.log(`Removed ${configDir}`);
    } catch {
      console.log(`${configDir} already removed.`);
    }

    const launcher = join(homedir(), ".local", "bin", "agent-logs");
    try {
      rmSync(launcher);
      console.log(`Removed ${launcher}`);
    } catch {
      console.log(`${launcher} already removed.`);
    }

    // Remove claude wrapper if it's ours
    const wrapper = join(homedir(), ".local", "bin", "claude");
    try {
      const { readFileSync: readF } = await import("fs");
      const content = readF(wrapper, "utf8");
      if (content.includes("agent-logs")) {
        rmSync(wrapper);
        console.log(`Removed claude wrapper: ${wrapper}`);
      }
    } catch {
      // No wrapper or not ours — skip
    }

    console.log("\nUninstall complete. Previously synced data remains on the server.");
    break;
  }

  default: {
    console.log(`Usage: agent-logs <command>

Commands:
  login          Authenticate via email verification code
  logout         Clear stored credentials
  consent        Start sharing logs for the current project directory
  withdraw       Stop sharing logs for the current project directory
  doctor         Check configuration and connectivity
  uninstall      Remove hooks, config, and CLI`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
  }
}
