import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

/** The hooks that agent-logs registers in Claude Code */
const AGENT_LOGS_HOOKS = {
  SessionStart: [
    {
      matcher: "startup",
      hooks: [
        {
          type: "command",
          command: "agent-logs consent-check",
          timeout: 60,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: "agent-logs sync",
        },
      ],
    },
  ],
  SubagentStop: [
    {
      hooks: [
        {
          type: "command",
          command: "agent-logs sync",
        },
      ],
    },
  ],
  SessionEnd: [
    {
      hooks: [
        {
          type: "command",
          command: "agent-logs sync",
        },
      ],
    },
  ],
};

/**
 * Register agent-logs hooks in Claude Code's settings.json.
 * Merges with existing hooks without overwriting user-defined ones.
 */
export function registerHooks() {
  let settings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  for (const [event, hookConfigs] of Object.entries(AGENT_LOGS_HOOKS)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove any existing agent-logs hooks (by command prefix match)
    settings.hooks[event] = settings.hooks[event].filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command?.startsWith("agent-logs "))
    );

    // Add our hooks
    settings.hooks[event].push(...hookConfigs);
  }

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

/** Check if agent-logs hooks are registered */
export function hooksRegistered() {
  if (!existsSync(CLAUDE_SETTINGS)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    const hooks = settings.hooks || {};
    return (
      hooks.Stop?.some((e) => e.hooks?.some((h) => h.command?.startsWith("agent-logs "))) &&
      hooks.SubagentStop?.some((e) => e.hooks?.some((h) => h.command?.startsWith("agent-logs "))) &&
      hooks.SessionEnd?.some((e) => e.hooks?.some((h) => h.command?.startsWith("agent-logs ")))
    );
  } catch {
    return false;
  }
}
