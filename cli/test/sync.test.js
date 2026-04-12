import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  ALLOWED_TYPES,
  stripToolResults,
  pathToProjectDir,
  tailHash,
  readFileSlice,
  discoverJsonlFiles,
} from "../sync.js";

// ── ALLOWED_TYPES ──

describe("ALLOWED_TYPES", () => {
  it("includes the 7 synced record types", () => {
    const expected = ["user", "assistant", "system", "progress", "summary", "custom-title", "ai-title"];
    for (const t of expected) {
      assert.ok(ALLOWED_TYPES.has(t), `missing: ${t}`);
    }
    assert.equal(ALLOWED_TYPES.size, 7);
  });

  it("excludes privacy-sensitive record types", () => {
    const excluded = [
      "file-history-snapshot",
      "last-prompt",
      "queue-operation",
      "attribution-snapshot",
      "content-replacement",
    ];
    for (const t of excluded) {
      assert.ok(!ALLOWED_TYPES.has(t), `should exclude: ${t}`);
    }
  });
});

// ── stripToolResults ──

describe("stripToolResults", () => {
  it("strips content from tool_result blocks, keeps stub", () => {
    const record = {
      type: "user",
      message: {
        content: [
          { type: "text", text: "hello" },
          {
            type: "tool_result",
            tool_use_id: "tu_123",
            content: [{ type: "text", text: "huge file contents..." }],
          },
          { type: "text", text: "next prompt" },
        ],
      },
    };

    const result = stripToolResults(record);
    assert.equal(result.message.content.length, 3);
    assert.deepEqual(result.message.content[0], { type: "text", text: "hello" });
    assert.deepEqual(result.message.content[1], { type: "tool_result", tool_use_id: "tu_123" });
    assert.equal(result.message.content[1].content, undefined);
    assert.deepEqual(result.message.content[2], { type: "text", text: "next prompt" });
  });

  it("handles multiple tool_result blocks", () => {
    const record = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "data1" },
          { type: "tool_result", tool_use_id: "b", content: "data2" },
        ],
      },
    };

    const result = stripToolResults(record);
    assert.deepEqual(result.message.content, [
      { type: "tool_result", tool_use_id: "a" },
      { type: "tool_result", tool_use_id: "b" },
    ]);
  });

  it("passes through records without message.content", () => {
    const record = { type: "system", subtype: "turn_duration", durationMs: 1500 };
    const result = stripToolResults(record);
    assert.deepEqual(result, record);
  });

  it("passes through records with string content (not array)", () => {
    const record = { type: "user", message: { content: "plain text prompt" } };
    const result = stripToolResults(record);
    assert.equal(result.message.content, "plain text prompt");
  });

  it("passes through records with null message", () => {
    const record = { type: "system", message: null };
    const result = stripToolResults(record);
    assert.deepEqual(result, { type: "system", message: null });
  });

  it("preserves tool_use blocks unchanged", () => {
    const record = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_456", name: "Read", input: { file_path: "/tmp/x" } },
          { type: "tool_result", tool_use_id: "tu_456", content: [{ type: "text", text: "file data" }] },
        ],
      },
    };

    const result = stripToolResults(record);
    assert.deepEqual(result.message.content[0], {
      type: "tool_use", id: "tu_456", name: "Read", input: { file_path: "/tmp/x" },
    });
    assert.deepEqual(result.message.content[1], { type: "tool_result", tool_use_id: "tu_456" });
  });
});

// ── pathToProjectDir ──

describe("pathToProjectDir", () => {
  it("converts absolute path to Claude project dir name", () => {
    assert.equal(pathToProjectDir("/home/tanaka/projects/my-project"), "-home-tanaka-projects-my-project");
  });

  it("handles root path", () => {
    assert.equal(pathToProjectDir("/"), "-");
  });

  it("handles single-level path", () => {
    assert.equal(pathToProjectDir("/tmp"), "-tmp");
  });

  it("handles deeply nested path", () => {
    const result = pathToProjectDir("/home/user/a/b/c/d");
    assert.equal(result, "-home-user-a-b-c-d");
  });
});

// ── tailHash ──

describe("tailHash", () => {
  it("returns null for offset 0", () => {
    const buf = Buffer.from("hello");
    assert.equal(tailHash(buf, 0), null);
  });

  it("returns null for negative offset", () => {
    const buf = Buffer.from("hello");
    assert.equal(tailHash(buf, -1), null);
  });

  it("hashes last bytes up to offset (small buffer)", () => {
    const buf = Buffer.from("hello world");
    const hash = tailHash(buf, 5);
    const expected = createHash("sha256").update(buf.subarray(0, 5)).digest("hex");
    assert.equal(hash, expected);
  });

  it("hashes last 1024 bytes before offset (large buffer)", () => {
    const buf = Buffer.alloc(2048, "x");
    buf.write("unique", 1000);
    const hash = tailHash(buf, 2048);
    const expected = createHash("sha256").update(buf.subarray(1024, 2048)).digest("hex");
    assert.equal(hash, expected);
  });

  it("handles offset smaller than 1024", () => {
    const buf = Buffer.from("short content");
    const hash = tailHash(buf, 5);
    const expected = createHash("sha256").update(buf.subarray(0, 5)).digest("hex");
    assert.equal(hash, expected);
  });
});

// ── readFileSlice ──

describe("readFileSlice", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("reads from cursor to EOF including tail for hash", () => {
    const filePath = join(tmpDir, "test.jsonl");
    const content = "line1\nline2\nline3\n";
    writeFileSync(filePath, content);

    const { buf, tailStart } = readFileSlice(filePath, 6, content.length);
    assert.equal(tailStart, 0); // 6 - 1024 clamped to 0
    assert.equal(buf.toString("utf8"), content);
  });

  it("reads tail correctly for large offset", () => {
    const filePath = join(tmpDir, "large.jsonl");
    const content = "x".repeat(3000);
    writeFileSync(filePath, content);

    const { buf, tailStart } = readFileSlice(filePath, 2000, 3000);
    assert.equal(tailStart, 2000 - 1024); // 976
    assert.equal(buf.length, 3000 - 976);
  });
});

// ── discoverJsonlFiles ──

describe("discoverJsonlFiles", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-logs-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array for non-existent directory", () => {
    const result = discoverJsonlFiles("/tmp/definitely-not-a-dir-" + Date.now());
    assert.deepEqual(result, []);
  });

  it("discovers main session JSONL files", () => {
    writeFileSync(join(tmpDir, "abc123.jsonl"), "{}");
    writeFileSync(join(tmpDir, "def456.jsonl"), "{}");
    writeFileSync(join(tmpDir, "readme.txt"), "ignore");

    const files = discoverJsonlFiles(tmpDir);
    const relPaths = files.map((f) => f.relative).sort();

    assert.equal(files.length, 2);
    assert.ok(relPaths.includes("abc123.jsonl"));
    assert.ok(relPaths.includes("def456.jsonl"));
  });

  it("discovers subagent JSONL files", () => {
    writeFileSync(join(tmpDir, "session1.jsonl"), "{}");

    const subDir = join(tmpDir, "session1", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-aaa.jsonl"), "{}");
    writeFileSync(join(subDir, "agent-bbb.jsonl"), "{}");

    const files = discoverJsonlFiles(tmpDir);
    const relPaths = files.map((f) => f.relative).sort();

    assert.equal(files.length, 3);
    assert.ok(relPaths.includes("session1.jsonl"));
    assert.ok(relPaths.some((p) => p.includes("agent-aaa.jsonl")));
    assert.ok(relPaths.some((p) => p.includes("agent-bbb.jsonl")));
  });
});

// ── Line filtering logic (simulated) ──

describe("line filtering", () => {
  function filterLines(lines, consentedAtMs = 0) {
    const filtered = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || !ALLOWED_TYPES.has(parsed.type)) continue;
      if (parsed.timestamp && new Date(parsed.timestamp).getTime() < consentedAtMs) continue;
      filtered.push(JSON.stringify(stripToolResults(parsed)));
    }
    return filtered;
  }

  it("includes allowed record types", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { content: "hi" } }),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 3);
  });

  it("excludes all disallowed record types seen in real data", () => {
    const excluded = [
      { type: "file-history-snapshot", messageId: "abc", snapshot: {"/tmp/x": "huge"}, isSnapshotUpdate: false },
      { type: "last-prompt", lastPrompt: "cached prompt", sessionId: "sess1" },
      { type: "queue-operation", operation: "dequeue", timestamp: "2026-01-01T00:00:00Z", sessionId: "sess1" },
      { type: "attribution-snapshot" },
      { type: "content-replacement" },
      { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "sess1" },
      { type: "attachment", attachment: { type: "mcp_instructions_delta" }, parentUuid: "xxx" },
      { type: "pr-link", sessionId: "sess1", prNumber: 42, prUrl: "https://github.com/org/repo/pull/42", prRepository: "org/repo" },
    ];
    const lines = excluded.map((r) => JSON.stringify(r));
    const result = filterLines(lines);
    assert.equal(result.length, 0);
  });

  it("skips invalid JSON lines", () => {
    const lines = [
      "not json at all",
      "{broken json",
      JSON.stringify({ type: "user", message: { content: "valid" } }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 1);
  });

  it("skips blank lines", () => {
    const lines = ["", "  ", "\t", JSON.stringify({ type: "user", message: { content: "x" } })];
    const result = filterLines(lines);
    assert.equal(result.length, 1);
  });

  it("filters by consent timestamp", () => {
    const before = new Date("2026-01-01T00:00:00Z").toISOString();
    const after = new Date("2026-06-01T00:00:00Z").toISOString();
    const consentedAt = new Date("2026-03-01T00:00:00Z").getTime();

    const lines = [
      JSON.stringify({ type: "user", timestamp: before, message: { content: "old" } }),
      JSON.stringify({ type: "user", timestamp: after, message: { content: "new" } }),
    ];
    const result = filterLines(lines, consentedAt);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes("new"));
  });

  it("includes records with no timestamp (consent check passes)", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
    ];
    const consentedAt = new Date("2026-03-01T00:00:00Z").getTime();
    const result = filterLines(lines, consentedAt);
    assert.equal(result.length, 1);
  });

  it("strips tool_result blocks during filtering", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "secret file data" }] },
          ],
        },
      }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 1);
    const parsed = JSON.parse(result[0]);
    assert.deepEqual(parsed.message.content[0], { type: "tool_result", tool_use_id: "tu_1" });
    assert.equal(parsed.message.content[0].content, undefined);
  });

  it("handles mixed allowed and disallowed types", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "q" } }),
      JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
      JSON.stringify({ type: "assistant", message: { content: "a" } }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "x" }),
      JSON.stringify({ type: "summary", summary: "s" }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 3);
  });

  it("includes progress records", () => {
    const lines = [
      JSON.stringify({
        type: "progress",
        data: { type: "hook_output", hookEvent: "Stop", hookName: "agent-logs sync", command: "agent-logs sync" },
        toolUseID: "toolu_abc",
        timestamp: "2026-04-01T00:00:00Z",
      }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 1);
  });

  it("consent timestamp boundary: exact match passes through", () => {
    const exactTime = "2026-03-01T12:00:00.000Z";
    const consentedAt = new Date(exactTime).getTime();
    const lines = [
      JSON.stringify({ type: "user", timestamp: exactTime, message: { content: "at boundary" } }),
    ];
    // timestamp == consentedAt → NOT less than → passes through
    const result = filterLines(lines, consentedAt);
    assert.equal(result.length, 1, "record at exact consent time should be included");
  });

  it("excludes records with missing type field", () => {
    const lines = [
      JSON.stringify({ message: { content: "no type field" } }),
      JSON.stringify({ type: null, message: { content: "null type" } }),
    ];
    const result = filterLines(lines);
    assert.equal(result.length, 0);
  });

  it("excludes non-object JSON lines", () => {
    const lines = ["42", '"a string"', "[1,2,3]", "true", "null"];
    const result = filterLines(lines);
    assert.equal(result.length, 0);
  });
});

// ── Real-world record shapes ──

describe("stripToolResults with real-world content shapes", () => {
  it("strips tool_result with base64 image content", () => {
    const record = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_img",
            content: [
              { type: "text", text: "Screenshot of page" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo".repeat(1000) } },
            ],
          },
        ],
      },
    };
    const result = stripToolResults(record);
    assert.deepEqual(result.message.content[0], { type: "tool_result", tool_use_id: "toolu_img" });
    assert.equal(result.message.content[0].content, undefined);
  });

  it("strips tool_result with string content (not array)", () => {
    const record = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_bash", content: "$ ls\nfile1.js\nfile2.js" },
        ],
      },
    };
    const result = stripToolResults(record);
    assert.deepEqual(result.message.content[0], { type: "tool_result", tool_use_id: "toolu_bash" });
  });

  it("preserves tool_use blocks with full input (Bash command)", () => {
    const record = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_abc", name: "Bash", input: { command: "npm test", description: "run tests" } },
        ],
      },
    };
    const result = stripToolResults(record);
    assert.equal(result.message.content[0].name, "Bash");
    assert.equal(result.message.content[0].input.command, "npm test");
  });

  it("preserves tool_use blocks with full input (Edit)", () => {
    const record = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_def", name: "Edit", input: { file_path: "/tmp/x.js", old_string: "foo", new_string: "bar", replace_all: false } },
        ],
      },
    };
    const result = stripToolResults(record);
    assert.deepEqual(result.message.content[0].input, { file_path: "/tmp/x.js", old_string: "foo", new_string: "bar", replace_all: false });
  });

  it("handles empty content array", () => {
    const record = { type: "assistant", message: { content: [] } };
    const result = stripToolResults(record);
    assert.deepEqual(result.message.content, []);
  });

  it("mutates the input record (not a copy)", () => {
    const record = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "data" },
        ],
      },
    };
    const result = stripToolResults(record);
    assert.equal(result, record); // same reference
    assert.equal(record.message.content[0].content, undefined);
  });
});


