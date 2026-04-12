import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// ── Mock GCP services before importing server ──

// In-memory stores
const firestoreData = {};
const bigqueryRows = [];
let bigqueryQueryResults = [];

function firestoreGet(path) {
  const data = firestoreData[path];
  return {
    exists: data != null,
    data: () => (data ? { ...data } : undefined),
    id: path.split("/").pop(),
  };
}

function firestoreSet(path, data, options) {
  if (options?.merge) {
    firestoreData[path] = { ...(firestoreData[path] || {}), ...data };
  } else {
    firestoreData[path] = { ...data };
  }
}

function firestoreDelete(path) {
  delete firestoreData[path];
}

// Mock Firestore document reference
function mockDocRef(path) {
  return {
    get: async () => firestoreGet(path),
    set: async (data, opts) => firestoreSet(path, data, opts),
    update: async (data) => firestoreSet(path, data, { merge: true }),
    delete: async () => firestoreDelete(path),
    id: path.split("/").pop(),
  };
}

// Mock Firestore collection reference
function mockCollectionRef(collPath) {
  return {
    doc: (id) => {
      if (id) return mockDocRef(`${collPath}/${id}`);
      const autoId = `auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return mockDocRef(`${collPath}/${autoId}`);
    },
    where: () => ({
      orderBy: () => ({
        get: async () => ({
          docs: Object.entries(firestoreData)
            .filter(([k]) => k.startsWith(collPath + "/"))
            .map(([k, v]) => ({
              id: k.split("/").pop(),
              data: () => ({ ...v }),
            })),
        }),
      }),
    }),
  };
}

const mockFirestore = {
  doc: (path) => mockDocRef(path),
  collection: (path) => mockCollectionRef(path),
  getAll: async (...refs) => {
    const results = [];
    for (const ref of refs) {
      results.push(await ref.get());
    }
    return results;
  },
  runTransaction: async (fn) => {
    const tx = {
      get: async (ref) => ref.get(),
      set: (ref, data) => ref.set(data),
    };
    return fn(tx);
  },
};

// Mock BigQuery
const mockBigQuery = {
  dataset: () => ({
    table: () => ({
      insert: async (rows) => {
        bigqueryRows.push(...rows);
      },
    }),
  }),
  query: async ({ query, params }) => {
    return [bigqueryQueryResults];
  },
};

// Now we mock the modules before importing the server
await mock.module("@google-cloud/firestore", {
  namedExports: {
    Firestore: class { constructor() { return mockFirestore; } },
  },
});

await mock.module("@google-cloud/bigquery", {
  namedExports: {
    BigQuery: class { constructor() { return mockBigQuery; } },
  },
});

await mock.module("googleapis", {
  namedExports: {
    google: {
      auth: {
        GoogleAuth: class {
          async getClient() { return {}; }
          async getCredentials() { return { client_email: "sa@test.iam" }; }
        },
        OAuth2: class {
          setCredentials() {}
        },
      },
      gmail: () => ({ users: { messages: { send: async () => {} } } }),
      iam: () => ({ projects: { serviceAccounts: { signBlob: async () => ({ data: { signature: "dGVzdA" } }) } } }),
    },
  },
});

// Set env before importing
process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_EMAILS = "admin@test.com";
process.env.OTLP_SECRET = "otlp-test-secret";

const { app, resetSurveyCache } = await import("../../server/index.js");

// ── Test helpers ──

const JWT_SECRET = "test-secret";

function makeToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: "1h" });
}

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const key of Object.keys(firestoreData)) delete firestoreData[key];
  bigqueryRows.length = 0;
  bigqueryQueryResults = [];
  resetSurveyCache();
});

/** Run fn with globalThis.fetch mocked to intercept Google OAuth token exchange */
async function withOAuthMock(fn) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === "string" && url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "mock-token" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return savedFetch(url, opts);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
  }
}

async function req(path, options = {}) {
  const { method = "GET", body, token, headers = {} } = options;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, data };
}

// ── Health ──

describe("GET /health", () => {
  it("returns ok", async () => {
    const { status, data } = await req("/health");
    assert.equal(status, 200);
    assert.equal(data.status, "ok");
  });
});

// ── Auth endpoints ──

describe("POST /auth/send-code", () => {
  it("rejects missing email", async () => {
    const { status } = await req("/auth/send-code", { method: "POST", body: {} });
    assert.equal(status, 400);
  });

  it("rejects unauthorized email", async () => {
    const { status, data } = await req("/auth/send-code", {
      method: "POST",
      body: { email: "nobody@unknown.com" },
    });
    assert.equal(status, 403);
  });

  it("accepts admin email and stores code", async () => {
    await withOAuthMock(async () => {
      const { status, data } = await req("/auth/send-code", {
        method: "POST",
        body: { email: "admin@test.com" },
      });
      assert.equal(status, 200);
      assert.equal(data.status, "ok");
      const stored = firestoreData["auth_codes/admin@test.com"];
      assert.ok(stored);
      assert.ok(stored.code);
      assert.equal(stored.code.length, 6);
    });
  });

  it("accepts email from allowed domain", async () => {
    firestoreData["allowlist/domains"] = { list: ["chibatech.dev"] };
    await withOAuthMock(async () => {
      const { status } = await req("/auth/send-code", {
        method: "POST",
        body: { email: "student@chibatech.dev" },
      });
      assert.equal(status, 200);
    });
  });

  it("accepts individually allowed email", async () => {
    firestoreData["allowlist/emails"] = { list: ["external@gmail.com"] };
    await withOAuthMock(async () => {
      const { status } = await req("/auth/send-code", {
        method: "POST",
        body: { email: "external@gmail.com" },
      });
      assert.equal(status, 200);
    });
  });
});

describe("POST /auth/verify-code", () => {
  it("rejects when no code exists", async () => {
    const { status } = await req("/auth/verify-code", {
      method: "POST",
      body: { email: "admin@test.com", code: "123456" },
    });
    assert.equal(status, 401);
  });

  it("rejects incorrect code", async () => {
    firestoreData["auth_codes/admin@test.com"] = {
      code: "999999",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 0,
    };
    const { status, data } = await req("/auth/verify-code", {
      method: "POST",
      body: { email: "admin@test.com", code: "000000" },
    });
    assert.equal(status, 401);
    assert.ok(data.error.includes("Incorrect"));
  });

  it("issues JWT on correct code", async () => {
    firestoreData["auth_codes/admin@test.com"] = {
      code: "123456",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 0,
    };
    const { status, data } = await req("/auth/verify-code", {
      method: "POST",
      body: { email: "admin@test.com", code: "123456" },
    });
    assert.equal(status, 200);
    assert.ok(data.token);
    assert.equal(data.email, "admin@test.com");

    // Verify JWT is valid
    const payload = jwt.verify(data.token, JWT_SECRET);
    assert.equal(payload.email, "admin@test.com");
  });

  it("rate limits after 5 attempts", async () => {
    firestoreData["auth_codes/admin@test.com"] = {
      code: "123456",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 5,
    };
    const { status } = await req("/auth/verify-code", {
      method: "POST",
      body: { email: "admin@test.com", code: "123456" },
    });
    assert.equal(status, 429);
  });
});

// ── Ingest endpoint ──

describe("POST /ingest", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await req("/ingest", { method: "POST", body: {} });
    assert.equal(status, 401);
  });

  it("rejects missing fields", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/ingest", {
      method: "POST",
      token,
      body: { project_path: "/test" },
    });
    assert.equal(status, 400);
  });

  it("accepts empty lines array", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: 0,
        lines: [],
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 0);
  });

  it("ingests lines and updates offset", async () => {
    const token = makeToken("student@chibatech.dev");
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "hello" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: "hi" } }),
    ];
    const fileOffset = lines.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/home/student/project",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: fileOffset,
        lines,
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 2);
    assert.equal(data.lines_skipped, 0);
    assert.equal(data.server_offset, fileOffset);

    // Verify BigQuery rows
    assert.equal(bigqueryRows.length, 2);
    assert.equal(bigqueryRows[0].participant_id, "student@chibatech.dev");
    assert.equal(bigqueryRows[0].record_type, "user");
  });

  it("skips already-synced lines (dedup)", async () => {
    const token = makeToken("student@chibatech.dev");
    const line1 = JSON.stringify({ type: "user", message: { content: "first" } });
    const line2 = JSON.stringify({ type: "user", message: { content: "second" } });
    const offset1 = Buffer.byteLength(line1, "utf8") + 1;
    const offset2 = offset1 + Buffer.byteLength(line2, "utf8") + 1;

    // First upload
    await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: offset1,
        lines: [line1],
      },
    });

    bigqueryRows.length = 0; // Clear to track second upload

    // Re-upload from offset 0 (cursor reset scenario) — server already at offset1
    const { data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: offset2,
        lines: [line1, line2],
      },
    });

    assert.equal(data.lines_accepted, 0);
    assert.equal(data.lines_skipped, 2);
    assert.equal(bigqueryRows.length, 0);
  });

  it("returns 409 on offset gap", async () => {
    const token = makeToken("student@chibatech.dev");

    // Ingest first line to set server offset
    const line = JSON.stringify({ type: "user", message: { content: "x" } });
    const lineOffset = Buffer.byteLength(line, "utf8") + 1;
    await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: lineOffset,
        lines: [line],
      },
    });

    // Try with offset much higher than server expects
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 999999,
        file_offset: 999999 + lineOffset,
        lines: [line],
      },
    });

    assert.equal(status, 409);
    assert.ok(data.server_offset != null);
  });
});

// ── Portal: Consent ──

describe("GET /portal/consent", () => {
  it("returns default state when no consent exists", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/consent", { token });
    assert.equal(status, 200);
    assert.equal(data.research_use, false);
  });
});

describe("POST /portal/consent", () => {
  it("enables research-use and generates anon_id", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/consent", {
      method: "POST",
      token,
      body: { research_use: true },
    });
    assert.equal(status, 200);
    assert.equal(data.research_use, true);
    assert.ok(data.anon_id);
  });

  it("preserves anon_id on re-consent", async () => {
    const token = makeToken("student@chibatech.dev");

    // First opt-in
    const { data: first } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: true },
    });
    const anonId = first.anon_id;

    // Opt out
    await req("/portal/consent", {
      method: "POST", token, body: { research_use: false },
    });

    // Re opt-in
    const { data: second } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: true },
    });
    assert.equal(second.anon_id, anonId);
  });

  it("rejects non-boolean research_use", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: "yes" },
    });
    assert.equal(status, 400);
  });
});

// ── Portal: Consent signing ──

describe("POST /portal/consent/sign", () => {
  it("signs consent form", async () => {
    const token = makeToken("student@chibatech.dev");
    // Set consent first
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });

    const { status, data } = await req("/portal/consent/sign", { method: "POST", token, body: {} });
    assert.equal(status, 200);
    assert.ok(data.signed_at);
  });

  it("rejects double-signing", async () => {
    const token = makeToken("student@chibatech.dev");
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    await req("/portal/consent/sign", { method: "POST", token, body: {} });

    const { status } = await req("/portal/consent/sign", { method: "POST", token, body: {} });
    assert.equal(status, 403);
  });

  it("rejects signing without consent record", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/consent/sign", { method: "POST", token, body: {} });
    assert.equal(status, 400);
  });
});

// ── Portal: Survey ──

describe("POST /portal/survey", () => {
  it("saves survey responses", async () => {
    const token = makeToken("student@chibatech.dev");
    // Unlock pre_course survey
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };

    const { status, data } = await req("/portal/survey", {
      method: "POST",
      token,
      body: {
        survey_id: "pre_course",
        responses: { q1: "answer1", q2: 5 },
        completed: false,
      },
    });
    assert.equal(status, 200);
    assert.equal(data.survey_status, "in_progress");
  });

  it("rejects locked survey", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };

    const { status } = await req("/portal/survey", {
      method: "POST",
      token,
      body: { survey_id: "post_course", responses: { q1: "a" } },
    });
    assert.equal(status, 403);
  });

  it("rejects changes after signing", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };

    // Submit and sign
    await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q1: "a" }, completed: true },
    });
    await req("/portal/survey/sign", {
      method: "POST", token,
      body: { survey_id: "pre_course" },
    });

    // Try to modify
    const { status } = await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q1: "changed" } },
    });
    assert.equal(status, 403);
  });
});

// ── Portal: Delete requests ──

describe("POST /portal/delete-request", () => {
  it("creates a delete request", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/delete-request", {
      method: "POST",
      token,
      body: {
        project_path: "/home/student/project",
        session_id: "sess-123",
        reason: "Accidentally shared private project",
      },
    });
    assert.equal(status, 200);
    assert.ok(data.request_id);
    assert.equal(data.state, "pending");
  });

  it("rejects missing project_path", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/delete-request", {
      method: "POST", token, body: { reason: "no path" },
    });
    assert.equal(status, 400);
  });
});

// ── Admin endpoints ──

describe("admin allowlist", () => {
  it("rejects non-admin", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/admin/allowlist", { token });
    assert.equal(status, 403);
  });

  it("admin can list allowlist", async () => {
    const token = makeToken("admin@test.com");
    firestoreData["allowlist/domains"] = { list: ["chibatech.dev"] };
    firestoreData["allowlist/emails"] = { list: ["ext@gmail.com"] };

    const { status, data } = await req("/admin/allowlist", { token });
    assert.equal(status, 200);
    assert.deepEqual(data.domains, ["chibatech.dev"]);
    assert.deepEqual(data.emails, ["ext@gmail.com"]);
  });

  it("admin can add domain", async () => {
    const token = makeToken("admin@test.com");
    const { status, data } = await req("/admin/allowlist/domain", {
      method: "POST", token, body: { domain: "newdomain.com" },
    });
    assert.equal(status, 200);
    assert.ok(data.domains.includes("newdomain.com"));
  });

  it("admin can add email", async () => {
    const token = makeToken("admin@test.com");
    const { status, data } = await req("/admin/allowlist/email", {
      method: "POST", token, body: { allow_email: "new@example.com" },
    });
    assert.equal(status, 200);
    assert.ok(data.emails.includes("new@example.com"));
  });
});

// ── OTLP endpoint ──

describe("POST /v1/logs", () => {
  it("rejects wrong secret", async () => {
    const { status } = await req("/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: { resourceLogs: [] },
    });
    assert.equal(status, 401);
  });

  it("ingests OTLP log records", async () => {
    bigqueryRows.length = 0;
    const { status, data } = await req("/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer otlp-test-secret", "Content-Type": "application/json" },
      body: {
        resourceLogs: [
          {
            resource: { attributes: [{ key: "user.email", value: { stringValue: "s@test.com" } }] },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1700000000000000000",
                    severityText: "INFO",
                    attributes: [{ key: "event.name", value: { stringValue: "user_prompt" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(status, 200);
    assert.equal(bigqueryRows.length, 1);
    assert.equal(bigqueryRows[0].user_email, "s@test.com");
    assert.equal(bigqueryRows[0].event_type, "user_prompt");
  });
});

// ── CORS ──

describe("CORS", () => {
  it("allows portal origin", async () => {
    const resp = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://agent-logs.chibatech.dev" },
    });
    assert.equal(resp.headers.get("access-control-allow-origin"), "https://agent-logs.chibatech.dev");
  });

  it("allows localhost", async () => {
    const resp = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(resp.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  it("handles OPTIONS preflight", async () => {
    const resp = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://agent-logs.chibatech.dev" },
    });
    assert.equal(resp.status, 204);
  });
});
