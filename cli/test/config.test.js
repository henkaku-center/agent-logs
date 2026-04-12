import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { addShared, removeShared, isShared } from "../config.js";

// ── isShared ──

describe("isShared", () => {
  it("returns true for a shared path", () => {
    const projects = {
      shared: [{ path: "/home/user/project", consented_at: "2026-01-01T00:00:00Z" }],
      withdrawn: [],
    };
    assert.equal(isShared(projects, "/home/user/project"), true);
  });

  it("returns false for a withdrawn path", () => {
    const projects = {
      shared: [],
      withdrawn: ["/home/user/project"],
    };
    assert.equal(isShared(projects, "/home/user/project"), false);
  });

  it("returns false for an unknown path", () => {
    const projects = { shared: [], withdrawn: [] };
    assert.equal(isShared(projects, "/home/user/unknown"), false);
  });

  it("matches exact paths only", () => {
    const projects = {
      shared: [{ path: "/home/user/project", consented_at: "2026-01-01T00:00:00Z" }],
      withdrawn: [],
    };
    assert.equal(isShared(projects, "/home/user/project-extra"), false);
    assert.equal(isShared(projects, "/home/user/projec"), false);
  });
});

// ── addShared ──

describe("addShared", () => {
  it("adds a new path to shared with timestamp", () => {
    const projects = { shared: [], withdrawn: [] };
    addShared(projects, "/home/user/new-project");

    assert.equal(projects.shared.length, 1);
    assert.equal(projects.shared[0].path, "/home/user/new-project");
    assert.ok(projects.shared[0].consented_at);
    // Verify timestamp is recent (within last 5 seconds)
    const ts = new Date(projects.shared[0].consented_at).getTime();
    assert.ok(Date.now() - ts < 5000);
  });

  it("removes path from withdrawn when adding to shared", () => {
    const projects = {
      shared: [],
      withdrawn: ["/home/user/project", "/home/user/other"],
    };
    addShared(projects, "/home/user/project");

    assert.equal(projects.shared.length, 1);
    assert.equal(projects.shared[0].path, "/home/user/project");
    assert.ok(!projects.withdrawn.includes("/home/user/project"));
    assert.ok(projects.withdrawn.includes("/home/user/other"));
  });

  it("replaces existing shared entry (updates timestamp)", () => {
    const projects = {
      shared: [{ path: "/home/user/project", consented_at: "2020-01-01T00:00:00Z" }],
      withdrawn: [],
    };
    addShared(projects, "/home/user/project");

    assert.equal(projects.shared.length, 1);
    assert.notEqual(projects.shared[0].consented_at, "2020-01-01T00:00:00Z");
  });

  it("does not duplicate entries", () => {
    const projects = { shared: [], withdrawn: [] };
    addShared(projects, "/home/user/project");
    addShared(projects, "/home/user/project");
    assert.equal(projects.shared.length, 1);
  });
});

// ── removeShared ──

describe("removeShared", () => {
  it("removes from shared and adds to withdrawn", () => {
    const projects = {
      shared: [{ path: "/home/user/project", consented_at: "2026-01-01T00:00:00Z" }],
      withdrawn: [],
    };
    removeShared(projects, "/home/user/project");

    assert.equal(projects.shared.length, 0);
    assert.ok(projects.withdrawn.includes("/home/user/project"));
  });

  it("does not duplicate in withdrawn list", () => {
    const projects = {
      shared: [{ path: "/home/user/project", consented_at: "2026-01-01T00:00:00Z" }],
      withdrawn: ["/home/user/project"],
    };
    removeShared(projects, "/home/user/project");

    assert.equal(projects.withdrawn.filter((p) => p === "/home/user/project").length, 1);
  });

  it("handles removing a path that is not shared", () => {
    const projects = { shared: [], withdrawn: [] };
    removeShared(projects, "/home/user/project");

    assert.equal(projects.shared.length, 0);
    assert.ok(projects.withdrawn.includes("/home/user/project"));
  });

  it("preserves other shared entries", () => {
    const projects = {
      shared: [
        { path: "/home/user/a", consented_at: "2026-01-01T00:00:00Z" },
        { path: "/home/user/b", consented_at: "2026-01-01T00:00:00Z" },
      ],
      withdrawn: [],
    };
    removeShared(projects, "/home/user/a");

    assert.equal(projects.shared.length, 1);
    assert.equal(projects.shared[0].path, "/home/user/b");
  });
});

// ── Consent flow round-trip ──

describe("consent → withdraw → re-consent flow", () => {
  it("handles full lifecycle", () => {
    const projects = { participant_id: "user@example.com", research_use: false, shared: [], withdrawn: [] };

    // Consent to project
    addShared(projects, "/home/user/project");
    assert.ok(isShared(projects, "/home/user/project"));
    assert.equal(projects.withdrawn.length, 0);

    // Withdraw
    removeShared(projects, "/home/user/project");
    assert.ok(!isShared(projects, "/home/user/project"));
    assert.ok(projects.withdrawn.includes("/home/user/project"));

    // Re-consent
    addShared(projects, "/home/user/project");
    assert.ok(isShared(projects, "/home/user/project"));
    assert.ok(!projects.withdrawn.includes("/home/user/project"));
  });
});

