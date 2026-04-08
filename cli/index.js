#!/usr/bin/env node

import { readProjects, writeProjects, ensureConfigDir, readLastSync, readToken, writeToken } from "./config.js";
import { INGESTION_URL } from "./constants.js";
import { login, getToken } from "./auth.js";
import { registerHooks, unregisterHooks, hooksRegistered } from "./hooks.js";
import { sync } from "./sync.js";

const command = process.argv[2];

/**
 * Interactive consent prompt via /dev/tty in raw mode.
 * Up/down arrows or 1/2 to move, Enter to confirm, Esc to skip.
 * Returns true (share), false (decline), or null (skipped).
 */
async function promptConsent() {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

  const fs = await import("fs");
  const tty = await import("tty");

  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return false;
  }

  const ttyIn = new tty.ReadStream(fd);
  const ttyOut = new tty.WriteStream(fd);

  let selected = 0; // 0 = yes, 1 = no

  const render = () => {
    const yes = selected === 0
      ? `  ${cyan("❯")} ${bold("1.")} ${bold("Yes, share this folder")}`
      : `    ${dim("1.")} ${dim("Yes, share this folder")}`;
    const no = selected === 1
      ? `  ${cyan("❯")} ${bold("2.")} ${bold("No, don't share")}`
      : `    ${dim("2.")} ${dim("No, don't share")}`;
    // Move cursor up 4 lines, clear them, redraw
    ttyOut.write(`\x1b[4A\x1b[J${yes}\n${no}\n\n  ${dim("Enter to confirm · Esc to cancel")}\n`);
  };

  // Initial draw
  ttyOut.write(`\n  ${cyan("❯")} ${bold("1.")} ${bold("Yes, share this folder")}\n    ${dim("2.")} ${dim("No, don't share")}\n\n  ${dim("Enter to confirm · Esc to cancel")}\n`);

  ttyIn.setRawMode(true);

  const result = await new Promise((resolve) => {
    ttyIn.on("data", (buf) => {
      const str = buf.toString();

      // Ctrl-C or Esc — cancel (skip, ask again next time)
      if (buf[0] === 3 || (buf[0] === 27 && buf.length === 1)) {
        resolve(null);
        return;
      }

      // Arrow up / Arrow down
      if (str === "\x1b[A" || str === "1") { selected = 0; render(); return; }
      if (str === "\x1b[B" || str === "2") { selected = 1; render(); return; }

      // Enter — confirm current selection
      if (str === "\r" || str === "\n") {
        resolve(selected === 0);
        return;
      }
    });
  });

  ttyIn.setRawMode(false);
  ttyIn.destroy();
  ttyOut.destroy();
  fs.closeSync(fd);

  return result;
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
      console.log(` Authenticated as: ${result.email}`);

      // Initialize projects config
      const projects = readProjects();
      projects.student_id = result.email;
      writeProjects(projects);

      // Register Claude Code hooks
      registerHooks();
      console.log("Claude Code hooks registered.");
      console.log("Setup complete. Use `agent-logs consent` in a project directory to start sharing.");
    } catch (err) {
      console.error(` Login failed: ${err.message}`);
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
    console.log("Review your consent and project-level session logs at\n\x1b[4;34mhttps://agent-logs.chibatech.dev\x1b[0m");
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
    const cwd = process.cwd();

    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
    const green = (s) => `\x1b[32m${s}\x1b[0m`;
    const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
    const blue = (s) => `\x1b[34m${s}\x1b[0m`;
    const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
    const line = dim("─".repeat(52));

    // Not logged in or expired — initiate login
    if (!readToken()?.token) {
      try {
        const result = await login();
        console.log(` Authenticated as: ${result.email}`);
        const p = readProjects();
        p.student_id = result.email;
        writeProjects(p);
        registerHooks();
      } catch (err) {
        console.error(` Login failed: ${err.message}`);
        process.exit(1);
      }
    }

    // Read projects after potential login
    const projects = readProjects();

    // Already decided — skip
    if (projects.shared.includes(cwd) || projects.withdrawn.includes(cwd)) break;

    // Unknown folder — show consent dialog
    const cols = process.stdout.columns || 89;
    const cyanLine = cyan("─".repeat(cols));
    console.log([
      cyanLine,
      cyan(` Agent Logging Consent`),
      ``,
      ` ${bold("Share session logs for this workspace?")}`,
      ` ${dim(cwd)}`,
      ``,
      ` Session logs from this folder will be shared with`,
      ` your course instructors for grading and feedback.`,
      ``,
      ` You can change this anytime with ${blue("agent-logs withdraw")}`,
      ` ${dim("└")} ${dim(projects.student_id)}`,
    ].join("\n"));

    const choice = await promptConsent();

    if (choice === true) {
      projects.shared.push(cwd);
      projects.withdrawn = projects.withdrawn.filter((p) => p !== cwd);
      writeProjects(projects);
    } else if (choice === false) {
      projects.withdrawn.push(cwd);
      projects.shared = projects.shared.filter((p) => p !== cwd);
      writeProjects(projects);
    }
    // choice === null (Esc) — do nothing, ask again next time, don't launch claude
    if (choice === null) process.exit(1);
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

    // Remove claude wrapper if it's ours, restore symlink to real binary
    const wrapper = join(homedir(), ".local", "bin", "claude");
    try {
      const { readFileSync: readF, readdirSync, symlinkSync } = await import("fs");
      const content = readF(wrapper, "utf8");
      if (content.includes("agent-logs")) {
        rmSync(wrapper);
        // Restore symlink to latest Claude binary
        const versionsDir = join(homedir(), ".local", "share", "claude", "versions");
        const versions = readdirSync(versionsDir).sort().reverse();
        if (versions.length > 0) {
          symlinkSync(join(versionsDir, versions[0]), wrapper);
          console.log(`Restored ${wrapper} → ${join(versionsDir, versions[0])}`);
        }
      }
    } catch {
      // No wrapper or not ours — skip
    }

    console.log("\nUninstall complete. Review your consent and project-level session logs at\n\x1b[4;34mhttps://agent-logs.chibatech.dev\x1b[0m");
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
