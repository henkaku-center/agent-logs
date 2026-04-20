#!/usr/bin/env node

import { readProjects, writeProjects, isShared, addShared, removeShared, syncConsent, ensureConfigDir, readLastSync, readToken, writeToken } from "./config.js";
import { INGESTION_URL } from "./constants.js";
import { login, getToken, authFetch } from "./auth.js";
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

  // Skip interactive prompt if not a real terminal (IDE terminals, pipes, etc.)
  if (!process.stdin.isTTY && !process.stdout.isTTY) {
    return false;
  }

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
const PUBLIC_COMMANDS = new Set(["login", "update", "uninstall", "consent-dialog", "consent-status", "context", "sync", undefined]);

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

      // Initialize projects config
      const projects = readProjects();
      projects.participant_id = result.email;
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
    addShared(projects, cwd);
    writeProjects(projects);
    console.log(`Sharing enabled for: ${cwd}`);
    break;
  }

  case "withdraw": {
    const cwd = process.cwd();
    const projects = readProjects();
    removeShared(projects, cwd);
    writeProjects(projects);
    console.log(`Sharing disabled for: ${cwd}`);
    console.log("Review your consent and project-level session logs at\n\x1b[4;36mhttps://agent-logs.chibatech.dev\x1b[0m");
    break;
  }

  case "opt-in": {
    const projects = readProjects();
    if (projects.research_use) {
      console.log("Research-use is already enabled.");
      break;
    }
    try {
      await authFetch("/portal/consent", "POST", { research_use: true });
      projects.research_use = true;
      writeProjects(projects);
      console.log("Research-use enabled. Anonymised session logs will be used for research.");
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
    break;
  }

  case "opt-out": {
    const projects = readProjects();
    if (!projects.research_use) {
      console.log("Research-use is already disabled.");
      break;
    }
    try {
      await authFetch("/portal/consent", "POST", { research_use: false });
      projects.research_use = false;
      writeProjects(projects);
      console.log("Research-use disabled. Session logs will only be used for educational purposes.");
    } catch (err) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
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
    const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

    // Not logged in or expired — initiate login
    const storedToken = readToken();
    if (!storedToken?.token) {
      try {
        const result = await login();
          const p = readProjects();
        p.participant_id = result.email;
        writeProjects(p);
        registerHooks();
      } catch (err) {
        console.error(` Login failed: ${err.message}`);
        process.exit(3);
      }
    }

    // Sync consent from server (also caches signed_at locally)
    const projects = readProjects();
    const token = (storedToken || readToken())?.token;
    if (token && await syncConsent(projects, token, INGESTION_URL)) {
      writeProjects(projects);
    }

    // Block launch if consent form not signed
    if (!projects.signed_at) {
      const cols = process.stdout.columns || 89;
      console.log([
        cyan("─".repeat(cols)),
        cyan(" Agent Logs — Consent Required"),
        ``,
        ` You must sign the informed consent form before using Claude.`,
        ` Visit the portal to read and sign:`,
        ``,
        `   \x1b[4;36mhttps://agent-logs.chibatech.dev/portal.html?email=${encodeURIComponent(projects.participant_id || "")}\x1b[0m`,
        ``,
        ` ${dim(`Logged in as ${projects.participant_id || ""}`)}`,
        cyan("─".repeat(cols)),
      ].join("\n"));
      process.exit(3);
    }

    // Already decided — skip
    if (isShared(projects, cwd) || projects.withdrawn.includes(cwd)) break;

    // Unknown folder — show consent dialog
    const cols = process.stdout.columns || 89;
    const cyanLine = cyan("─".repeat(cols));
    const bannerLines = [
      cyanLine,
      cyan(` Agent Logging Consent`),
      ``,
      ` ${bold("Share session logs for this workspace?")}`,
      ` ${dim(cwd)}`,
      ``,
      ` Session logs from this folder will be shared with`,
      ` Chiba Tech for evaluation and feedback.`,
      ``,
      ` You can change this anytime by asking Claude`,
      ` ${dim("└")} ${dim(projects.participant_id)}`,
    ];
    console.log(bannerLines.join("\n"));

    const choice = await promptConsent();

    // Clear dialog: banner lines + 1 (console.log newline) + 5 (prompt lines)
    const totalLines = bannerLines.length + 1 + 5;
    process.stdout.write(`\x1b[${totalLines}A\x1b[J`);

    if (choice === true) {
      addShared(projects, cwd);
      writeProjects(projects);
    } else if (choice === false) {
      removeShared(projects, cwd);
      writeProjects(projects);
    }
    // choice === null (Esc) — do nothing, ask again next time, don't launch claude
    if (choice === null) process.exit(3);
    break;
  }

  case "context": {
    // SessionStart hook — injects agent-logs awareness into Claude's context via stdout
    const projects = readProjects();
    let hookCwd = process.cwd();
    try {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      if (input) {
        const hookData = JSON.parse(input);
        if (hookData.cwd) hookCwd = hookData.cwd;
      }
    } catch {}

    const shared = isShared(projects, hookCwd);
    const withdrawn = projects.withdrawn.includes(hookCwd);
    const status = shared ? "shared" : withdrawn ? "not shared" : "unknown";

    // stdout → injected into Claude's context
    console.log([
      `[agent-logs] Session logs for this project are ${status}.`,
      `Participant: ${projects.participant_id}. Research-use: ${projects.research_use ? "opted in" : "not enrolled"}.`,
      `Available commands (run via Bash tool):`,
      `  agent-logs consent   — start sharing logs for the current project`,
      `  agent-logs withdraw  — stop sharing logs for the current project`,
      `  agent-logs opt-in    — enable research-use (anonymised logs for research, global)`,
      `  agent-logs opt-out   — disable research-use (global)`,
      `  agent-logs update    — update to the latest version`,
      `  agent-logs doctor    — check configuration and connectivity`,
      `If the participant asks to change sharing or research consent, run the appropriate command.`,
    ].join("\n"));
    break;
  }

  case "consent-status": {
    // StatusLine command — reads JSON from stdin, outputs colored status
    const projects = readProjects();
    let input = "";
    for await (const chunk of process.stdin) input += chunk;

    let cwd = process.cwd();
    try {
      const data = JSON.parse(input);
      if (data.cwd) cwd = data.cwd;
    } catch {}

    const cyanBold = (s) => `\x1b[1;36m${s}\x1b[0m`;
    const dim = (s) => `\x1b[2m${s}\x1b[0m`;

    if (isShared(projects, cwd)) {
      const res = projects.research_use || false;
      const eduLabel = cyanBold("● Educational-use");
      const resLabel = res ? cyanBold("● Research-use") : dim("○ Research-use");

      console.log(`${cyanBold("Agent Logs")} sharing for: ${eduLabel} ${resLabel}`);
      console.log("");
      console.log(`Visit \x1b[4;36mhttps://agent-logs.chibatech.dev\x1b[0m or ask Claude to review consent and data`);
      console.log(`Run \x1b[1magent-logs uninstall\x1b[0m to uninstall this tool`);
    } else if (projects.withdrawn.includes(cwd)) {
      console.log(`${cyanBold("Agent Logs")} ${dim("not shared for this project")}`);
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

    switch (subcommand) {
      case "list": {
        const data = await authFetch("/admin/allowlist");
        console.log("Allowed domains:");
        for (const d of data.domains) console.log(`  @${d}`);
        console.log("\nAllowed emails:");
        for (const e of data.emails) console.log(`  ${e}`);
        if (data.domains.length === 0 && data.emails.length === 0) {
          console.log("  (none — no participants can sync)");
        }
        break;
      }
      case "add-domain": {
        if (!arg) { console.error("Usage: agent-logs admin add-domain <domain>"); process.exit(1); }
        const data = await authFetch("/admin/allowlist/domain", "POST", { domain: arg });
        console.log(`Added @${arg}. Domains: ${data.domains.map(d => "@" + d).join(", ")}`);
        break;
      }
      case "remove-domain": {
        if (!arg) { console.error("Usage: agent-logs admin remove-domain <domain>"); process.exit(1); }
        const data = await authFetch("/admin/allowlist/domain", "DELETE", { domain: arg });
        console.log(`Removed @${arg}. Domains: ${data.domains.map(d => "@" + d).join(", ")}`);
        break;
      }
      case "add-email": {
        if (!arg) { console.error("Usage: agent-logs admin add-email <email>"); process.exit(1); }
        const data = await authFetch("/admin/allowlist/email", "POST", { allow_email: arg });
        console.log(`Added ${arg}. Emails: ${data.emails.join(", ")}`);
        break;
      }
      case "remove-email": {
        if (!arg) { console.error("Usage: agent-logs admin remove-email <email>"); process.exit(1); }
        const data = await authFetch("/admin/allowlist/email", "DELETE", { allow_email: arg });
        console.log(`Removed ${arg}. Emails: ${data.emails.join(", ")}`);
        break;
      }
      case "roles": {
        const data = await authFetch("/admin/roles");
        console.log("Instructors (course.logs_view access):");
        for (const e of data.instructors) console.log(`  ${e}`);
        if (data.instructors.length === 0) console.log("  (none)");
        console.log("\nResearchers (research_logs_view access):");
        for (const e of data.researchers) console.log(`  ${e}`);
        if (data.researchers.length === 0) console.log("  (none)");
        break;
      }
      case "add-instructor": {
        if (!arg) { console.error("Usage: agent-logs admin add-instructor <email>"); process.exit(1); }
        const data = await authFetch("/admin/roles/instructor", "POST", { email: arg });
        console.log(`Added instructor ${arg}. Instructors: ${data.instructors.join(", ")}`);
        if (data.warning) { console.error(`Warning: ${data.warning}`); process.exit(2); }
        break;
      }
      case "remove-instructor": {
        if (!arg) { console.error("Usage: agent-logs admin remove-instructor <email>"); process.exit(1); }
        const data = await authFetch("/admin/roles/instructor", "DELETE", { email: arg });
        console.log(`Removed instructor ${arg}. Instructors: ${data.instructors.join(", ")}`);
        if (data.warning) { console.error(`Warning: ${data.warning}`); process.exit(2); }
        break;
      }
      case "add-researcher": {
        if (!arg) { console.error("Usage: agent-logs admin add-researcher <email>"); process.exit(1); }
        const data = await authFetch("/admin/roles/researcher", "POST", { email: arg });
        console.log(`Added researcher ${arg}. Researchers: ${data.researchers.join(", ")}`);
        if (data.warning) { console.error(`Warning: ${data.warning}`); process.exit(2); }
        break;
      }
      case "remove-researcher": {
        if (!arg) { console.error("Usage: agent-logs admin remove-researcher <email>"); process.exit(1); }
        const data = await authFetch("/admin/roles/researcher", "DELETE", { email: arg });
        console.log(`Removed researcher ${arg}. Researchers: ${data.researchers.join(", ")}`);
        if (data.warning) { console.error(`Warning: ${data.warning}`); process.exit(2); }
        break;
      }
      default:
        console.log(`Usage: agent-logs admin <command>

Commands:
  list                     Show allowed domains and emails
  add-domain <domain>      Allow all emails from a domain
  remove-domain <domain>   Remove a domain
  add-email <email>        Allow a specific email address
  remove-email <email>     Remove a specific email address
  roles                    Show instructor and researcher assignments
  add-instructor <email>   Grant BigQuery access to course.logs_view
  remove-instructor <email> Revoke instructor access
  add-researcher <email>   Grant BigQuery access to research_logs_view
  remove-researcher <email> Revoke researcher access`);
    }
    break;
  }

  case "update": {
    const { execSync } = await import("child_process");
    console.log("Checking for updates...");
    try {
      execSync("curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash", { stdio: "inherit" });
    } catch {
      console.error("Update failed. Try manually: curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash");
      process.exit(1);
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

    // Remove claude wrapper function from shell configs
    const { readFileSync: readF, writeFileSync: writeF } = await import("fs");
    const removedFrom = [];
    for (const rc of [join(homedir(), ".bashrc"), join(homedir(), ".zshrc")]) {
      try {
        const content = readF(rc, "utf8");
        const filtered = content.split("\n").filter((l) => !l.includes("# agent-logs wrapper")).join("\n");
        if (filtered !== content) {
          writeF(rc, filtered);
          removedFrom.push(rc);
          console.log(`Removed claude wrapper from ${rc}`);
        }
      } catch {
        // File doesn't exist — skip
      }
    }

    console.log("\nUninstall complete. Review your consent and project-level session logs at\n\x1b[4;36mhttps://agent-logs.chibatech.dev\x1b[0m");
    if (removedFrom.length > 0) {
      console.log(`\n\x1b[1;32m✓\x1b[0m To complete uninstallation run:\n\n  \x1b[1msource ${removedFrom[0]}\x1b[0m\n`);
    }
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
  update         Update to the latest version
  uninstall      Remove hooks, config, and CLI

Exit codes:
  0    Success
  1    Usage error or authentication failure
  2    Partial failure (e.g. role saved but IAM sync failed)
  3    Consent pending — do not launch Claude`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
  }
}
