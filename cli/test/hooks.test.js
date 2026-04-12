import { describe, it } from "node:test";
import assert from "node:assert/strict";

// hooks.js does file I/O to ~/.claude/settings.json, so we test the
// merge logic by reimplementing it on plain objects. This verifies the
// algorithm without touching the real filesystem.

describe("hook registration logic", () => {
  const AGENT_LOGS_HOOKS = {
    SessionStart: [
      { matcher: "startup", hooks: [{ type: "command", command: "agent-logs context", timeout: 5 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "agent-logs sync" }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: "agent-logs sync" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "agent-logs sync" }] }],
  };

  function registerHooks(settings) {
    if (!settings.hooks) settings.hooks = {};
    for (const [event, hookConfigs] of Object.entries(AGENT_LOGS_HOOKS)) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) => !entry.hooks?.some((h) => h.command?.startsWith("agent-logs "))
      );
      settings.hooks[event].push(...hookConfigs);
    }
    settings.statusLine = { type: "command", command: "agent-logs consent-status" };
    return settings;
  }

  function unregisterHooks(settings) {
    if (!settings.hooks) return settings;
    for (const event of Object.keys(AGENT_LOGS_HOOKS)) {
      if (!settings.hooks[event]) continue;
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) => !entry.hooks?.some((h) => h.command?.startsWith("agent-logs "))
      );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    if (settings.statusLine?.command?.startsWith("agent-logs ")) delete settings.statusLine;
    return settings;
  }

  function hooksRegistered(settings) {
    const hooks = settings.hooks || {};
    return Object.keys(AGENT_LOGS_HOOKS).every((event) =>
      hooks[event]?.some((e) => e.hooks?.some((h) => h.command?.startsWith("agent-logs ")))
    );
  }

  it("registers all four hook events on empty settings", () => {
    const settings = registerHooks({});
    assert.ok(settings.hooks.SessionStart);
    assert.ok(settings.hooks.Stop);
    assert.ok(settings.hooks.SubagentStop);
    assert.ok(settings.hooks.SessionEnd);
    assert.ok(settings.statusLine);
  });

  it("preserves existing user hooks", () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "my-custom-hook" }] }],
      },
    };
    registerHooks(settings);

    // Should have both custom hook and agent-logs hook
    assert.equal(settings.hooks.Stop.length, 2);
    assert.ok(settings.hooks.Stop.some((e) => e.hooks?.some((h) => h.command === "my-custom-hook")));
    assert.ok(settings.hooks.Stop.some((e) => e.hooks?.some((h) => h.command === "agent-logs sync")));
  });

  it("is idempotent (no duplicates on re-registration)", () => {
    const settings = {};
    registerHooks(settings);
    registerHooks(settings);

    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.SessionStart.length, 1);
  });

  it("unregisters all agent-logs hooks", () => {
    const settings = {};
    registerHooks(settings);
    unregisterHooks(settings);

    assert.equal(settings.hooks, undefined);
    assert.equal(settings.statusLine, undefined);
  });

  it("unregister preserves other hooks", () => {
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "my-hook" }] },
          { hooks: [{ type: "command", command: "agent-logs sync" }] },
        ],
      },
      statusLine: { type: "command", command: "agent-logs consent-status" },
    };
    unregisterHooks(settings);

    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "my-hook");
    assert.equal(settings.statusLine, undefined);
  });

  it("hooksRegistered returns true when all events present", () => {
    const settings = {};
    registerHooks(settings);
    assert.ok(hooksRegistered(settings));
  });

  it("hooksRegistered returns false when missing events", () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "agent-logs sync" }] }] } };
    assert.ok(!hooksRegistered(settings));
  });

  it("hooksRegistered returns false for empty settings", () => {
    assert.ok(!hooksRegistered({}));
  });

  it("SessionStart hook has startup matcher", () => {
    const settings = {};
    registerHooks(settings);
    const sessionStart = settings.hooks.SessionStart[0];
    assert.equal(sessionStart.matcher, "startup");
  });

  it("SessionStart hook has timeout", () => {
    const settings = {};
    registerHooks(settings);
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(hook.timeout, 5);
  });
});
