#!/usr/bin/env node

import { readProjects, writeProjects, ensureConfigDir, readLastSync, readToken } from "./config.js";
import { INGESTION_URL } from "./constants.js";
import { login } from "./auth.js";
import { registerHooks, unregisterHooks, hooksRegistered } from "./hooks.js";
import { sync } from "./sync.js";

const command = process.argv[2];

switch (command) {
  case "login": {
    console.log("Logging in to agent-logs...");
    try {
      const token = await login();
      console.log(`Authenticated as: ${token.email}`);

      // Initialize projects config
      const projects = readProjects();
      projects.student_id = token.email;
      writeProjects(projects);

      // Register Claude Code hooks
      registerHooks();
      console.log("Claude Code hooks registered.");
      console.log("Setup complete. Use `agent-logs consent` in a project directory to start sharing.");
    } catch (err) {
      console.error("Login failed:", err.message);
      process.exit(1);
    }
    break;
  }

  case "consent": {
    const cwd = process.cwd();
    const projects = readProjects();
    if (!projects.student_id) {
      console.error("Not logged in. Run `agent-logs login` first.");
      process.exit(1);
    }
    // Remove from withdrawn if present
    projects.withdrawn = projects.withdrawn.filter((p) => p !== cwd);
    // Add to shared if not already
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
    if (!projects.student_id) {
      console.error("Not logged in. Run `agent-logs login` first.");
      process.exit(1);
    }
    // Remove from shared
    projects.shared = projects.shared.filter((p) => p !== cwd);
    // Add to withdrawn if not already
    if (!projects.withdrawn.includes(cwd)) {
      projects.withdrawn.push(cwd);
    }
    writeProjects(projects);
    console.log(`Sharing disabled for: ${cwd}`);
    console.log("Previously synced data remains on the server. Submit a delete request via the portal to remove it.");
    break;
  }

  case "consent-check": {
    // Called by SessionStart hook. Reads stdin for hook JSON, outputs status message.
    const projects = readProjects();
    const cwd = process.cwd();

    // Try to read cwd from hook input (stdin)
    let hookCwd = cwd;
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
      }
      if (input) {
        const hookData = JSON.parse(input);
        if (hookData.cwd) hookCwd = hookData.cwd;
      }
    } catch {
      // Use process.cwd() as fallback
    }

    if (!projects.student_id) {
      console.log("agent-logs: not logged in. Run `agent-logs login` to set up.");
      break;
    }

    if (projects.shared.includes(hookCwd)) {
      const tierB = projects.tier_b ? "\n  [x] Anonymised data for research" : "";
      console.log(`Chiba Tech — session logs are being shared\n  [x] Course purposes (grading and feedback)${tierB}\n\nRun \`agent-logs withdraw\` to stop sharing logs for this project.`);
    } else if (projects.withdrawn.includes(hookCwd)) {
      console.log("Session logs are not being shared. Run `agent-logs consent` to start sharing.");
    } else {
      console.log("This project is not being shared with Chiba Tech. Run `agent-logs consent` to share.");
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

    // Check server reachability
    try {
      const { getIdToken } = await import("./auth.js");
      const idToken = await getIdToken();
      const resp = await fetch(`${INGESTION_URL}/health`, {
        signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const body = await resp.json();
      console.log(`Server:   ${INGESTION_URL} — ${body.status}`);
    } catch (err) {
      console.log(`Server:   ${INGESTION_URL} — UNREACHABLE (${err.message})`);
    }
    break;
  }

  case "uninstall": {
    const { rmSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    // Remove hooks from Claude Code
    unregisterHooks();
    console.log("Claude Code hooks removed.");

    // Remove config directory
    const configDir = join(homedir(), ".config", "agent-logs");
    try {
      rmSync(configDir, { recursive: true });
      console.log(`Removed ${configDir}`);
    } catch {
      console.log(`${configDir} already removed.`);
    }

    // Remove launcher script
    const launcher = join(homedir(), ".local", "bin", "agent-logs");
    try {
      rmSync(launcher);
      console.log(`Removed ${launcher}`);
    } catch {
      console.log(`${launcher} already removed.`);
    }

    console.log("\nUninstall complete. Previously synced data remains on the server.");
    break;
  }

  default: {
    console.log(`Usage: agent-logs <command>

Commands:
  login          Authenticate and register Claude Code hooks
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
