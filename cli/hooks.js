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
          command: "agent-logs context",
          timeout: 5,
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

  // Register statusLine
  settings.statusLine = {
    type: "command",
    command: "agent-logs consent-status",
  };

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

/** Remove all agent-logs hooks from Claude Code's settings.json */
export function unregisterHooks() {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  let settings;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch {
    return;
  }
  if (!settings.hooks) return;

  for (const event of Object.keys(AGENT_LOGS_HOOKS)) {
    if (!settings.hooks[event]) continue;
    settings.hooks[event] = settings.hooks[event].filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command?.startsWith("agent-logs "))
    );
    // Clean up empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  // Remove statusLine if it's ours
  if (settings.statusLine?.command?.startsWith("agent-logs ")) {
    delete settings.statusLine;
  }

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
}

/** Check if agent-logs hooks are registered */
export function hooksRegistered() {
  if (!existsSync(CLAUDE_SETTINGS)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    const hooks = settings.hooks || {};
    return Object.keys(AGENT_LOGS_HOOKS).every((event) =>
      hooks[event]?.some((e) => e.hooks?.some((h) => h.command?.startsWith("agent-logs ")))
    );
  } catch {
    return false;
  }
}
