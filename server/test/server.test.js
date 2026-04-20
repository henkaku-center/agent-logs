import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { createHash, createCipheriv, randomBytes } from "crypto";

// ── Mock GCP services before importing server ──

// In-memory stores
const firestoreData = {};
const bigqueryRows = [];
const researchRows = [];
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
const bigqueryQueries = [];
const mockBigQuery = {
  dataset: () => ({
    table: (name) => ({
      insert: async (rows) => {
        if (name === "research_logs") researchRows.push(...rows);
        else bigqueryRows.push(...rows);
      },
    }),
  }),
  query: async ({ query, params, types }) => {
    bigqueryQueries.push({ query, params, types });
    // Mirror real BigQuery: null values must have an explicit type in `types`.
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null && !(types && types[key])) {
        throw new Error("Parameter types must be provided for null values via the 'types' field in query options.");
      }
    }
    // Route DML INSERTs to the in-memory row stores so test assertions work
    if (query.startsWith("INSERT INTO")) {
      const isResearch = query.includes("research_logs");
      const isCowork = query.includes("cowork_events");
      // Extract column names from INSERT INTO `...` (col1, col2, ...) VALUES
      const colMatch = query.match(/\(([^)]+)\)\s+VALUES/);
      if (colMatch) {
        const columns = colMatch[1].split(",").map((c) => c.trim());
        // Extract row values from named params @r0_col, @r1_col, ...
        const rowCount = Object.keys(params).filter((k) => k.startsWith("r0_")).length > 0
          ? Math.max(...Object.keys(params).map((k) => parseInt(k.match(/^r(\d+)_/)?.[1] ?? "-1"))) + 1
          : 0;
        for (let i = 0; i < rowCount; i++) {
          const row = {};
          for (const col of columns) {
            const key = `r${i}_${col}`;
            row[col] = params[key] ?? null;
          }
          if (isResearch) researchRows.push(row);
          else if (isCowork) bigqueryRows.push(row);
          else bigqueryRows.push(row);
        }
      }
    }
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
process.env.SEALED_MAPPING_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { app, resetSurveyCache, anonymizeRecord } = await import("../../server/index.js");

// ── Test helpers ──

const JWT_SECRET = "test-secret";

function makeToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: "1h" });
}

function seedSealedMapping(email, anonId) {
  const sealKey = Buffer.from(process.env.SEALED_MAPPING_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
  const plaintext = JSON.stringify({ email, anon_id: anonId });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const emailHash = createHash("sha256").update(email).digest("hex");
  firestoreData[`sealed_mapping/${emailHash}`] = {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
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
  researchRows.length = 0;
  bigqueryQueries.length = 0;
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

  it("chunks large batches under BigQuery's 10k parameter limit (regression)", async () => {
    const token = makeToken("student@chibatech.dev");
    // 1500 rows × 8 columns = 12,000 params — previously one query, now must split.
    const lines = Array.from({ length: 1500 }, (_, i) =>
      JSON.stringify({ type: "user", timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, message: { content: `msg ${i}` } })
    );
    const fileOffset = lines.reduce((s, l) => s + Buffer.byteLength(l, "utf8") + 1, 0);

    const qCountBefore = bigqueryQueries.length;
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/chunk-test",
        session_id: "big_session",
        file_name: "big.jsonl",
        offset: 0,
        file_offset: fileOffset,
        lines,
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1500);

    const inserts = bigqueryQueries.slice(qCountBefore).filter((q) => q.query.startsWith("INSERT INTO") && q.query.includes("course.logs"));
    assert.ok(inserts.length >= 2, `expected multiple INSERTs, got ${inserts.length}`);
    for (const q of inserts) {
      assert.ok(Object.keys(q.params).length <= 10000, `chunk exceeds BigQuery 10k param limit: ${Object.keys(q.params).length}`);
    }
  });

  it("accepts records with missing/null nullable fields (regression: BigQuery parameter types)", async () => {
    const token = makeToken("student@chibatech.dev");
    // Record with no `version` field — previously this made insertRows pass null
    // without a types hint, triggering a BigQuery 500 on every /ingest call.
    const line = JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "hello" } });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "null_version_session",
        file_name: "null_version_session.jsonl",
        offset: 0,
        file_offset: fileOffset,
        lines: [line],
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1);

    const insert = bigqueryQueries.find((q) => q.query.startsWith("INSERT INTO") && q.query.includes("course.logs"));
    assert.ok(insert, "expected an INSERT INTO course.logs");
    assert.equal(insert.params.r0_version, null);
    assert.equal(insert.types.r0_version, "STRING", "null version param must carry a STRING type hint");
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
  it("enables research-use", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/consent", {
      method: "POST",
      token,
      body: { research_use: true },
    });
    assert.equal(status, 200);
    assert.equal(data.research_use, true);
    assert.equal(data.anon_id, undefined, "anon_id no longer returned from consent endpoint");
  });

  it("sets consented_at on first opt-in only", async () => {
    const token = makeToken("student@chibatech.dev");

    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    const first = firestoreData["consent/student@chibatech.dev"];
    const firstConsented = first.consented_at;

    // Opt out and re-opt-in
    await req("/portal/consent", { method: "POST", token, body: { research_use: false } });
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    const second = firestoreData["consent/student@chibatech.dev"];
    assert.equal(second.consented_at, firstConsented, "consented_at should not change on re-opt-in");
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
  it("signs consent form and stores PDF archive", async () => {
    const token = makeToken("student@chibatech.dev");
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });

    const { status, data } = await req("/portal/consent/sign", {
      method: "POST", token,
      body: { consent_html: "<p>Test consent content</p>", research_use: true },
    });
    assert.equal(status, 200);
    assert.ok(data.signed_at);

    // Verify PDF archive stored in Firestore
    const stored = firestoreData["consent/student@chibatech.dev"];
    assert.ok(stored.consent_pdf);
    const html = Buffer.from(stored.consent_pdf, "base64").toString("utf8");
    assert.ok(html.includes("Test consent content"));
    assert.ok(html.includes("student@chibatech.dev"));
    assert.ok(html.includes("✓ Opted in"));
  });

  it("rejects double-signing", async () => {
    const token = makeToken("student@chibatech.dev");
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    await req("/portal/consent/sign", { method: "POST", token, body: { consent_html: "<p>x</p>", research_use: true } });

    const { status } = await req("/portal/consent/sign", { method: "POST", token, body: {} });
    assert.equal(status, 403);
  });

  it("creates consent record on sign if none exists", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/consent/sign", {
      method: "POST", token,
      body: { consent_html: "<p>form</p>", research_use: true },
    });
    assert.equal(status, 200);
    assert.ok(data.signed_at);
    const stored = firestoreData["consent/student@chibatech.dev"];
    assert.equal(stored.research_use, true);
    assert.ok(stored.consented_at);
  });
});

// ── Portal: Consent PDF download ──

describe("GET /portal/consent/pdf", () => {
  it("returns stored consent PDF as HTML", async () => {
    const token = makeToken("student@chibatech.dev");
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    await req("/portal/consent/sign", {
      method: "POST", token,
      body: { consent_html: "<p>Full consent document</p>", research_use: true },
    });

    const resp = await fetch(`${baseUrl}/portal/consent/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await resp.text();
    assert.ok(html.includes("Full consent document"));
    assert.ok(html.includes("student@chibatech.dev"));
  });

  it("returns 404 if consent not signed", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/consent/pdf", { token });
    assert.equal(status, 404);
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

// ── Auth edge cases ──

describe("auth edge cases", () => {
  it("rejects expired JWT", async () => {
    const expired = jwt.sign({ email: "student@chibatech.dev" }, JWT_SECRET, { expiresIn: "-1s" });
    const { status } = await req("/portal/consent", { token: expired });
    assert.equal(status, 401);
  });

  it("rejects malformed JWT", async () => {
    const { status } = await req("/portal/consent", { token: "not.a.jwt" });
    assert.equal(status, 401);
  });

  it("rejects expired verification code", async () => {
    firestoreData["auth_codes/admin@test.com"] = {
      code: "123456",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() - 1000) }, // expired 1s ago
      attempts: 0,
    };
    const { status, data } = await req("/auth/verify-code", {
      method: "POST",
      body: { email: "admin@test.com", code: "123456" },
    });
    assert.equal(status, 401);
    assert.ok(data.error.includes("expired"));
  });

  it("normalizes email case", async () => {
    firestoreData["allowlist/emails"] = { list: ["user@test.com"] };
    await withOAuthMock(async () => {
      const { status } = await req("/auth/send-code", {
        method: "POST",
        body: { email: "USER@TEST.COM" },
      });
      assert.equal(status, 200);
      // Code stored under lowercase key
      assert.ok(firestoreData["auth_codes/user@test.com"]);
    });
  });
});

// ── Research token issuance ──

describe("research token", () => {
  it("verify-code returns research_token", async () => {
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
    assert.ok(data.research_token);

    // Verify research token contains anon_id
    const payload = jwt.verify(data.research_token, JWT_SECRET);
    assert.equal(payload.type, "research");
    assert.ok(payload.anon_id);
  });

  it("creates sealed_mapping document on login", async () => {
    firestoreData["auth_codes/admin@test.com"] = {
      code: "111111",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 0,
    };
    await req("/auth/verify-code", { method: "POST", body: { email: "admin@test.com", code: "111111" } });

    // Find the sealed mapping doc (keyed by sha256 of email)
    const hash = Object.keys(firestoreData).find((k) => k.startsWith("sealed_mapping/"));
    assert.ok(hash, "sealed_mapping document should exist");
    const sealed = firestoreData[hash];
    assert.ok(sealed.iv);
    assert.ok(sealed.ciphertext);
    assert.ok(sealed.tag);
    assert.ok(sealed.updated_at);
  });

  it("reissues same anon_id on re-login", async () => {
    // First login
    firestoreData["auth_codes/admin@test.com"] = {
      code: "111111",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 0,
    };
    const { data: first } = await req("/auth/verify-code", {
      method: "POST", body: { email: "admin@test.com", code: "111111" },
    });
    const firstAnonId = jwt.verify(first.research_token, JWT_SECRET).anon_id;

    // Second login (sealed mapping already exists)
    firestoreData["auth_codes/admin@test.com"] = {
      code: "222222",
      created_at: new Date(),
      expires_at: { toDate: () => new Date(Date.now() + 600000) },
      attempts: 0,
    };
    const { data: second } = await req("/auth/verify-code", {
      method: "POST", body: { email: "admin@test.com", code: "222222" },
    });
    const secondAnonId = jwt.verify(second.research_token, JWT_SECRET).anon_id;

    assert.equal(firstAnonId, secondAnonId, "same anon_id should be reissued");
  });

  it("ingest accepts request with valid research_token", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = jwt.sign({ anon_id: "test-anon-id", type: "research" }, JWT_SECRET);
    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const { status, data } = await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/test", session_id: "s1", file_name: "s1.jsonl",
        offset: 0, file_offset: Buffer.byteLength(line, "utf8") + 1,
        lines: [line], research_token: researchToken,
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1);
  });

  it("ingest works without research_token (backwards compatible)", async () => {
    const token = makeToken("student@chibatech.dev");
    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const { status, data } = await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/test", session_id: "s2", file_name: "s2.jsonl",
        offset: 0, file_offset: Buffer.byteLength(line, "utf8") + 1,
        lines: [line],
      },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1);
  });
});

// ── Ingest edge cases ──

describe("ingest edge cases", () => {
  it("handles malformed JSON in lines array", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/ingest", {
      method: "POST",
      token,
      body: {
        project_path: "/test",
        session_id: "sess1",
        file_name: "sess1.jsonl",
        offset: 0,
        file_offset: 20,
        lines: ["not valid json", "{also broken"],
      },
    });
    // Server parses lines for record_type but catches parse errors
    assert.equal(status, 200);
    assert.equal(bigqueryRows.length, 2);
    assert.equal(bigqueryRows[0].record_type, "unknown");
  });

  it("isolates offsets between different participants", async () => {
    const token1 = makeToken("alice@chibatech.dev");
    const token2 = makeToken("bob@chibatech.dev");
    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token: token1,
      body: { project_path: "/proj", session_id: "s1", file_name: "s1.jsonl", offset: 0, file_offset: fileOffset, lines: [line] },
    });
    // Bob's upload to same session_id/file_name should not conflict
    const { status, data } = await req("/ingest", {
      method: "POST", token: token2,
      body: { project_path: "/proj", session_id: "s1", file_name: "s1.jsonl", offset: 0, file_offset: fileOffset, lines: [line] },
    });
    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1);
  });
});

// ── Portal: Revoke ──

describe("POST /portal/revoke", () => {
  it("revokes a specific session", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/revoke", {
      method: "POST", token,
      body: { project_path: "/home/student/project", session_id: "sess-1", revoked: true },
    });
    assert.equal(status, 200);
    assert.equal(data.revoked, true);
  });

  it("un-revokes a session", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/revoke", {
      method: "POST", token,
      body: { project_path: "/home/student/project", session_id: "sess-1", revoked: false },
    });
    assert.equal(status, 200);
    assert.equal(data.revoked, false);
  });

  it("revokes entire project (no session_id)", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status, data } = await req("/portal/revoke", {
      method: "POST", token,
      body: { project_path: "/home/student/project", revoked: true },
    });
    assert.equal(status, 200);
    assert.equal(data.revoked, true);
  });

  it("rejects missing project_path", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/revoke", {
      method: "POST", token, body: { revoked: true },
    });
    assert.equal(status, 400);
  });

  it("rejects missing revoked boolean", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/revoke", {
      method: "POST", token, body: { project_path: "/test" },
    });
    assert.equal(status, 400);
  });

  it("rejects non-boolean revoked", async () => {
    const token = makeToken("student@chibatech.dev");
    const { status } = await req("/portal/revoke", {
      method: "POST", token, body: { project_path: "/test", revoked: "yes" },
    });
    assert.equal(status, 400);
  });

  it("rejects unauthenticated request", async () => {
    const { status } = await req("/portal/revoke", {
      method: "POST", body: { project_path: "/test", revoked: true },
    });
    assert.equal(status, 401);
  });

  it("cascades revoke to research.logs via sealed mapping", async () => {
    const email = "cascade@chibatech.dev";
    const token = makeToken(email);
    const anonId = "anon-uuid-1234";

    seedSealedMapping(email, anonId);

    bigqueryQueries.length = 0;
    const { status, data } = await req("/portal/revoke", {
      method: "POST", token,
      body: { project_path: "/home/student/project", session_id: "sess-1", revoked: true },
    });
    assert.equal(status, 200);
    assert.equal(data.revoked, true);

    // Should have two UPDATE queries: one for course.logs, one for research.logs
    assert.equal(bigqueryQueries.length, 2);
    assert.ok(bigqueryQueries[0].query.includes("course.logs"));
    assert.ok(bigqueryQueries[1].query.includes("research_logs"));
    assert.equal(bigqueryQueries[1].params.anon_id, anonId);
    assert.equal(bigqueryQueries[1].params.revoked, true);
    // project_hash should be sha256 of project_path
    const expectedHash = createHash("sha256").update("/home/student/project").digest("hex");
    assert.equal(bigqueryQueries[1].params.project_hash, expectedHash);
  });
});

// ── Portal: Sessions ──

describe("GET /portal/sessions", () => {
  it("returns empty projects for new participant", async () => {
    const token = makeToken("new@chibatech.dev");
    bigqueryQueryResults = [];
    const { status, data } = await req("/portal/sessions", { token });
    assert.equal(status, 200);
    assert.deepEqual(data.projects, []);
    assert.equal(data.has_more, false);
  });

  it("returns sessions grouped by project", async () => {
    const token = makeToken("student@chibatech.dev");
    bigqueryQueryResults = [
      { project_path: "/proj-a", session_id: "s1", first_timestamp: { value: "2026-01-01" }, last_timestamp: { value: "2026-01-02" }, record_count: 10, user_count: 5, assistant_count: 5, revoked: false },
      { project_path: "/proj-a", session_id: "s2", first_timestamp: { value: "2026-01-03" }, last_timestamp: { value: "2026-01-04" }, record_count: 8, user_count: 4, assistant_count: 4, revoked: false },
      { project_path: "/proj-b", session_id: "s3", first_timestamp: { value: "2026-01-05" }, last_timestamp: { value: "2026-01-06" }, record_count: 3, user_count: 1, assistant_count: 2, revoked: true },
    ];
    const { status, data } = await req("/portal/sessions", { token });
    assert.equal(status, 200);
    assert.equal(data.projects.length, 2);
    const projA = data.projects.find((p) => p.project_path === "/proj-a");
    assert.equal(projA.sessions.length, 2);
    const projB = data.projects.find((p) => p.project_path === "/proj-b");
    assert.equal(projB.sessions[0].revoked, true);
  });

  it("respects pagination limit", async () => {
    const token = makeToken("student@chibatech.dev");
    // Return limit+1 rows to trigger has_more
    bigqueryQueryResults = Array.from({ length: 3 }, (_, i) => ({
      project_path: "/proj", session_id: `s${i}`,
      first_timestamp: { value: "2026-01-01" }, last_timestamp: { value: "2026-01-01" },
      record_count: 1, user_count: 1, assistant_count: 0, revoked: false,
    }));
    const { data } = await req("/portal/sessions?limit=2", { token });
    assert.equal(data.has_more, true);
    assert.equal(data.limit, 2);
    // Should only return 2 sessions (not the 3rd overflow row)
    const totalSessions = data.projects.reduce((sum, p) => sum + p.sessions.length, 0);
    assert.equal(totalSessions, 2);
  });

  it("includes session titles from Firestore", async () => {
    const token = makeToken("student@chibatech.dev");
    bigqueryQueryResults = [
      { project_path: "/proj", session_id: "s1", first_timestamp: { value: "2026-01-01" }, last_timestamp: { value: "2026-01-01" }, record_count: 5, user_count: 2, assistant_count: 3, revoked: false },
    ];
    firestoreData["session_titles/student@chibatech.dev/s1/meta"] = { title: "Fix login bug" };
    const { data } = await req("/portal/sessions", { token });
    assert.equal(data.projects[0].sessions[0].title, "Fix login bug");
  });
});

// ── Portal: Delete requests (GET) ──

describe("GET /portal/delete-requests", () => {
  it("returns empty list for new participant", async () => {
    const token = makeToken("new@chibatech.dev");
    const { status, data } = await req("/portal/delete-requests", { token });
    assert.equal(status, 200);
    assert.deepEqual(data.requests, []);
  });

  it("returns requests after creating them", async () => {
    const token = makeToken("student@chibatech.dev");
    // Create a request first
    await req("/portal/delete-request", {
      method: "POST", token,
      body: { project_path: "/proj", session_id: "s1", reason: "test" },
    });
    const { status, data } = await req("/portal/delete-requests", { token });
    assert.equal(status, 200);
    assert.ok(data.requests.length >= 1);
    assert.ok(data.requests.some((r) => r.project_path === "/proj"));
  });
});

// ── Portal: Survey edge cases ──

describe("survey edge cases", () => {
  it("rejects empty completed survey", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };
    const { status } = await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: {}, completed: true },
    });
    assert.equal(status, 400);
  });

  it("rejects unknown survey_id", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };
    const { status } = await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "nonexistent_survey", responses: { q1: "a" } },
    });
    assert.equal(status, 403);
  });

  it("merges partial responses across submissions", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };

    // First partial submission
    await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q1: "a" }, completed: false },
    });
    // Second partial submission
    await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q2: "b" }, completed: false },
    });
    // Check merged state
    const stored = firestoreData["survey_responses/student@chibatech.dev/pre_course/data"];
    assert.equal(stored.responses.q1, "a");
    assert.equal(stored.responses.q2, "b");
  });

  it("rejects signing an incomplete survey", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };
    // Submit but don't complete
    await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q1: "a" }, completed: false },
    });
    const { status } = await req("/portal/survey/sign", {
      method: "POST", token, body: { survey_id: "pre_course" },
    });
    assert.equal(status, 400);
  });

  it("rejects double-signing a survey", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["survey_config/current"] = { unlocked: ["pre_course"] };
    await req("/portal/survey", {
      method: "POST", token,
      body: { survey_id: "pre_course", responses: { q1: "a" }, completed: true },
    });
    await req("/portal/survey/sign", { method: "POST", token, body: { survey_id: "pre_course" } });
    const { status } = await req("/portal/survey/sign", {
      method: "POST", token, body: { survey_id: "pre_course" },
    });
    assert.equal(status, 403);
  });
});

// ── Portal: Consent edge cases ──

describe("consent edge cases", () => {
  it("consent toggle still works after signing", async () => {
    const token = makeToken("student@chibatech.dev");
    await req("/portal/consent", { method: "POST", token, body: { research_use: true } });
    await req("/portal/consent/sign", { method: "POST", token, body: {} });
    const { status, data } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: false },
    });
    assert.equal(status, 200);
    assert.equal(data.research_use, false);
    // Verify signing is preserved in stored state
    const stored = firestoreData["consent/student@chibatech.dev"];
    assert.ok(stored.signed_at, "signed_at should be preserved after toggle");
    assert.equal(stored.research_use, false);
  });
  it("backfills course.logs to research.logs on opt-in", async () => {
    const email = "backfill@chibatech.dev";
    const token = makeToken(email);
    const anonId = "backfill-anon-uuid";

    seedSealedMapping(email, anonId);

    const courseRow = {
      project_path: "/home/student/proj",
      session_id: "s1",
      file_name: "s1.jsonl",
      record_type: "user",
      timestamp: { value: "2026-04-01T00:00:00Z" },
      version: "2.1.92",
      data: JSON.stringify({ type: "user", cwd: "/home/student/proj", message: { content: "hello" } }),
    };
    const origQuery = mockBigQuery.query;
    mockBigQuery.query = async (opts) => {
      // Backfill LEFT JOIN query returns rows not yet in research.logs
      if (opts.query.includes("LEFT JOIN")) {
        bigqueryQueries.push(opts);
        return [[courseRow]];
      }
      // Delegate all other queries (including INSERTs) to the real mock
      return origQuery(opts);
    };

    researchRows.length = 0;
    const { status, data } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: true },
    });

    mockBigQuery.query = origQuery;

    assert.equal(status, 200);
    assert.equal(data.research_use, true);
    assert.equal(data.backfill_count, 1);
    assert.equal(researchRows.length, 1);
    assert.equal(researchRows[0].anon_id, anonId);
    // Verify anonymization was applied
    const backfilledData = JSON.parse(researchRows[0].data);
    assert.equal(backfilledData.cwd, "/home/anon/proj");
  });

  it("revokes all research rows on opt-out", async () => {
    const email = "optout@chibatech.dev";
    const token = makeToken(email);
    const anonId = "optout-anon-uuid";

    seedSealedMapping(email, anonId);

    // Set existing consent as opted-in
    firestoreData[`consent/${email}`] = { research_use: true, consented_at: new Date() };

    bigqueryQueries.length = 0;
    const { status, data } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: false },
    });

    assert.equal(status, 200);
    assert.equal(data.research_use, false);

    // Should have an UPDATE setting revoked = true on research_logs
    const revokeQuery = bigqueryQueries.find((q) => q.query.includes("research_logs") && q.query.includes("UPDATE"));
    assert.ok(revokeQuery, "should UPDATE research_logs");
    assert.equal(revokeQuery.params.anon_id, anonId);
  });

  it("restores revoked research rows on re-opt-in", async () => {
    const email = "reoptin@chibatech.dev";
    const token = makeToken(email);
    const anonId = "reoptin-anon-uuid";

    seedSealedMapping(email, anonId);

    // Set existing consent as opted-out (was previously in)
    firestoreData[`consent/${email}`] = { research_use: false, consented_at: new Date() };

    bigqueryQueries.length = 0;
    // Mock query to return empty for backfill SELECT
    const origQuery = mockBigQuery.query;
    mockBigQuery.query = async ({ query, params }) => {
      bigqueryQueries.push({ query, params });
      return [[]];
    };

    const { status, data } = await req("/portal/consent", {
      method: "POST", token, body: { research_use: true },
    });

    mockBigQuery.query = origQuery;

    assert.equal(status, 200);

    // Should have an UPDATE setting revoked = false on research_logs
    const restoreQuery = bigqueryQueries.find((q) => q.query.includes("research_logs") && q.query.includes("UPDATE"));
    assert.ok(restoreQuery, "should UPDATE research_logs to restore");
  });
});

// ── Admin edge cases ──

describe("admin allowlist edge cases", () => {
  it("admin can remove domain", async () => {
    const token = makeToken("admin@test.com");
    firestoreData["allowlist/domains"] = { list: ["old.com", "keep.com"] };
    const { status, data } = await req("/admin/allowlist/domain", {
      method: "DELETE", token, body: { domain: "old.com" },
    });
    assert.equal(status, 200);
    assert.ok(!data.domains.includes("old.com"));
    assert.ok(data.domains.includes("keep.com"));
  });

  it("admin can remove email", async () => {
    const token = makeToken("admin@test.com");
    firestoreData["allowlist/emails"] = { list: ["remove@test.com", "keep@test.com"] };
    const { status, data } = await req("/admin/allowlist/email", {
      method: "DELETE", token, body: { allow_email: "remove@test.com" },
    });
    assert.equal(status, 200);
    assert.ok(!data.emails.includes("remove@test.com"));
    assert.ok(data.emails.includes("keep@test.com"));
  });

  it("adding duplicate domain is idempotent", async () => {
    const token = makeToken("admin@test.com");
    firestoreData["allowlist/domains"] = { list: ["existing.com"] };
    const { data } = await req("/admin/allowlist/domain", {
      method: "POST", token, body: { domain: "existing.com" },
    });
    assert.equal(data.domains.filter((d) => d === "existing.com").length, 1);
  });

  it("returns empty lists when no allowlist exists", async () => {
    const token = makeToken("admin@test.com");
    const { data } = await req("/admin/allowlist", { token });
    assert.deepEqual(data.domains, []);
    assert.deepEqual(data.emails, []);
  });
});

// ── OTLP edge cases ──

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

  it("handles empty resourceLogs array", async () => {
    const { status } = await req("/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer otlp-test-secret", "Content-Type": "application/json" },
      body: { resourceLogs: [] },
    });
    assert.equal(status, 200);
    assert.equal(bigqueryRows.length, 0);
  });

  it("handles missing attributes gracefully", async () => {
    const { status } = await req("/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer otlp-test-secret", "Content-Type": "application/json" },
      body: {
        resourceLogs: [{
          resource: {},
          scopeLogs: [{
            logRecords: [{ timeUnixNano: "1700000000000000000", severityText: "WARN", attributes: [] }],
          }],
        }],
      },
    });
    assert.equal(status, 200);
    assert.equal(bigqueryRows.length, 1);
    assert.equal(bigqueryRows[0].user_email, "");
    assert.equal(bigqueryRows[0].event_type, "WARN"); // falls back to severityText
  });

  it("accepts traces and metrics as no-ops", async () => {
    const traces = await req("/v1/traces", { method: "POST", body: {} });
    assert.equal(traces.status, 200);
    const metrics = await req("/v1/metrics", { method: "POST", body: {} });
    assert.equal(metrics.status, 200);
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

// ── anonymizeRecord ──

describe("anonymizeRecord", () => {
  it("scrubs cwd path", () => {
    const input = JSON.stringify({ cwd: "/home/tanaka/coursework/web3" });
    const result = JSON.parse(anonymizeRecord(input));
    assert.equal(result.cwd, "/home/anon/coursework/web3");
  });

  it("scrubs gitBranch username prefix", () => {
    const input = JSON.stringify({ gitBranch: "tanaka/feature-x" });
    const result = JSON.parse(anonymizeRecord(input));
    assert.equal(result.gitBranch, "anon/feature-x");
  });

  it("leaves branchless gitBranch unchanged", () => {
    const input = JSON.stringify({ gitBranch: "main" });
    const result = JSON.parse(anonymizeRecord(input));
    assert.equal(result.gitBranch, "main");
  });

  it("hashes requestId with HMAC", () => {
    const input = JSON.stringify({ requestId: "req-abc-123" });
    const result = JSON.parse(anonymizeRecord(input));
    assert.notEqual(result.requestId, "req-abc-123");
    assert.equal(result.requestId.length, 20);
    // Deterministic: same input → same output
    const result2 = JSON.parse(anonymizeRecord(input));
    assert.equal(result.requestId, result2.requestId);
  });

  it("scrubs paths in tool_use input blocks", () => {
    const input = JSON.stringify({
      message: {
        content: [
          {
            type: "tool_use",
            input: {
              file_path: "/home/tanaka/project/src/main.js",
              command: "cat /home/tanaka/project/README.md",
            },
          },
        ],
      },
    });
    const result = JSON.parse(anonymizeRecord(input));
    const toolInput = result.message.content[0].input;
    assert.equal(toolInput.file_path, "/home/anon/project/src/main.js");
    assert.equal(toolInput.command, "cat /home/anon/project/README.md");
  });

  it("leaves non-tool_use content blocks unchanged", () => {
    const input = JSON.stringify({
      message: {
        content: [
          { type: "text", text: "hello /home/tanaka/test" },
        ],
      },
    });
    const result = JSON.parse(anonymizeRecord(input));
    assert.equal(result.message.content[0].text, "hello /home/tanaka/test");
  });

  it("handles records with no scrubable fields", () => {
    const input = JSON.stringify({ type: "system", sessionId: "abc-123" });
    const result = JSON.parse(anonymizeRecord(input));
    assert.equal(result.type, "system");
    assert.equal(result.sessionId, "abc-123");
  });
});

// ── Research logs dual-write ──

describe("research logs dual-write", () => {
  function makeResearchToken(anonId) {
    return jwt.sign({ anon_id: anonId, type: "research" }, JWT_SECRET);
  }

  it("writes to research_logs when research_use is true", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = makeResearchToken("anon-abc");
    firestoreData["consent/student@chibatech.dev"] = { research_use: true };

    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/home/student/project",
      message: { content: "hello" },
    });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    const { status, data } = await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/home/student/project",
        session_id: "rs1", file_name: "rs1.jsonl",
        offset: 0, file_offset: fileOffset,
        lines: [line], research_token: researchToken,
      },
    });

    assert.equal(status, 200);
    assert.equal(data.lines_accepted, 1);
    // course.logs written
    assert.equal(bigqueryRows.length, 1);
    assert.equal(bigqueryRows[0].participant_id, "student@chibatech.dev");
    // research.logs written
    assert.equal(researchRows.length, 1);
    assert.equal(researchRows[0].anon_id, "anon-abc");
    assert.ok(researchRows[0].project_hash);
    assert.notEqual(researchRows[0].project_hash, "/home/student/project");
    // cwd should be anonymized in research data
    const researchData = JSON.parse(researchRows[0].data);
    assert.equal(researchData.cwd, "/home/anon/project");
    assert.equal(researchRows[0].revoked, false);
  });

  it("skips research_logs when research_use is false", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = makeResearchToken("anon-abc");
    firestoreData["consent/student@chibatech.dev"] = { research_use: false };

    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/test", session_id: "rs2", file_name: "rs2.jsonl",
        offset: 0, file_offset: fileOffset,
        lines: [line], research_token: researchToken,
      },
    });

    assert.equal(bigqueryRows.length, 1);
    assert.equal(researchRows.length, 0);
  });

  it("skips research_logs when no consent record exists", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = makeResearchToken("anon-abc");

    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/test", session_id: "rs3", file_name: "rs3.jsonl",
        offset: 0, file_offset: fileOffset,
        lines: [line], research_token: researchToken,
      },
    });

    assert.equal(bigqueryRows.length, 1);
    assert.equal(researchRows.length, 0);
  });

  it("skips research_logs when no research_token provided", async () => {
    const token = makeToken("student@chibatech.dev");
    firestoreData["consent/student@chibatech.dev"] = { research_use: true };

    const line = JSON.stringify({ type: "user", message: { content: "hi" } });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/test", session_id: "rs4", file_name: "rs4.jsonl",
        offset: 0, file_offset: fileOffset,
        lines: [line],
      },
    });

    assert.equal(bigqueryRows.length, 1);
    assert.equal(researchRows.length, 0);
  });

  it("anonymizes tool_use paths in research data", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = makeResearchToken("anon-xyz");
    firestoreData["consent/student@chibatech.dev"] = { research_use: true };

    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      requestId: "req-123",
      message: {
        content: [
          { type: "tool_use", input: { file_path: "/home/student/src/app.js", command: "ls /home/student/" } },
        ],
      },
    });
    const fileOffset = Buffer.byteLength(line, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/home/student/project",
        session_id: "rs5", file_name: "rs5.jsonl",
        offset: 0, file_offset: fileOffset,
        lines: [line], research_token: researchToken,
      },
    });

    assert.equal(researchRows.length, 1);
    const rd = JSON.parse(researchRows[0].data);
    assert.equal(rd.message.content[0].input.file_path, "/home/anon/src/app.js");
    assert.equal(rd.message.content[0].input.command, "ls /home/anon/");
    // requestId should be hashed
    assert.notEqual(rd.requestId, "req-123");
    assert.equal(rd.requestId.length, 20);
  });

  it("produces consistent project_hash for same project_path", async () => {
    const token = makeToken("student@chibatech.dev");
    const researchToken = makeResearchToken("anon-hash");
    firestoreData["consent/student@chibatech.dev"] = { research_use: true };

    const line1 = JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "a" } });
    const line2 = JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:01Z", message: { content: "b" } });
    const off1 = Buffer.byteLength(line1, "utf8") + 1;
    const off2 = off1 + Buffer.byteLength(line2, "utf8") + 1;

    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/home/student/project",
        session_id: "rs6", file_name: "rs6.jsonl",
        offset: 0, file_offset: off1,
        lines: [line1], research_token: researchToken,
      },
    });
    await req("/ingest", {
      method: "POST", token,
      body: {
        project_path: "/home/student/project",
        session_id: "rs6", file_name: "rs6.jsonl",
        offset: off1, file_offset: off2,
        lines: [line2], research_token: researchToken,
      },
    });

    assert.equal(researchRows.length, 2);
    assert.equal(researchRows[0].project_hash, researchRows[1].project_hash);
    assert.equal(researchRows[0].project_hash.length, 64); // sha256 hex
  });
});
