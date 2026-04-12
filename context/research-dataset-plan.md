# Research Dataset and Anonymization Pipeline

Plan for implementing the anonymized research dataset, Phase 1 structural anonymization, late opt-in backfill, authorized views, and GCP project separation.

## Prerequisites

- Research token with sealed identity mapping is implemented (done)
- `course.logs` BigQuery table is operational with identified session logs (done)
- Consent endpoint tracks `research_use` and `signed_at` (done)
- `anon_id` is available from the client's signed research token in every sync request (done)

## Current state

- `POST /ingest` receives `research_token` JWT containing `{anon_id, type: "research"}` and validates it, but does not use it for writes
- `consent/{email}` in Firestore tracks `research_use` boolean
- `course.logs` schema: `participant_id` (email), `project_path`, `session_id`, `file_name`, `record_type`, `timestamp`, `version`, `data` (JSON string), `revoked`
- No `research.logs` table exists yet
- No anonymization code exists

## 1. Create `research.logs` BigQuery table

Create a new table in the `course` dataset (same project for now — separation happens in step 5).

Schema — same as `course.logs` but with `anon_id` replacing `participant_id`:

```
anon_id         STRING      -- from research token, not email
project_hash    STRING      -- sha256 of project_path (not the path itself)
session_id      STRING      -- same as course.logs (UUID, not identifying)
file_name       STRING      -- same as course.logs
record_type     STRING
timestamp       TIMESTAMP
version         STRING
data            STRING      -- Phase 1 anonymized JSON
revoked         BOOLEAN
```

Create with:
```bash
bq mk --table agent-logging:course.research_logs /path/to/schema.json
```

Note: `project_path` is replaced with `project_hash` because the path contains the student's username (e.g., `/home/tanaka/coursework/web3-project`).

## 2. Phase 1 structural anonymization

Apply deterministic transformations to the `data` JSON string before writing to `research.logs`. These run at ingestion time in the server's `POST /ingest` handler.

### Fields to scrub

| Field | Location in `data` JSON | Transformation |
|-------|------------------------|----------------|
| `cwd` | Top-level field on `user`, `assistant`, `system` records | Replace `/home/{username}/` with `/home/anon/` |
| `sessionId` | Top-level | Keep as-is (UUID, not identifying) |
| `gitBranch` | Top-level on `user` records | Strip username prefixes: `tanaka/feature-x` → `anon/feature-x` |
| `requestId` | Top-level on `assistant` records | Replace with keyed HMAC (consistent within session, not reversible without key) |
| `message.content` text blocks | Inside `user` and `assistant` records | **Not scrubbed in Phase 1** — free text is deferred to Phase 2 LLM scrubbing |
| `tool_use` input fields | `file_path`, `command` in tool_use blocks | Replace `/home/{username}/` with `/home/anon/` in string values |

### Implementation

Add a function `anonymizeRecord(jsonString, anonId)` in `server/index.js`:

```js
function anonymizeRecord(jsonString) {
  const record = JSON.parse(jsonString);

  // Scrub cwd
  if (record.cwd) {
    record.cwd = record.cwd.replace(/\/home\/[^/]+\//, "/home/anon/");
  }

  // Scrub gitBranch
  if (record.gitBranch) {
    record.gitBranch = record.gitBranch.replace(/^[^/]+\//, "anon/");
  }

  // Scrub requestId with HMAC
  if (record.requestId) {
    record.requestId = createHmac("sha256", SEALED_MAPPING_KEY)
      .update(record.requestId).digest("hex").slice(0, 20);
  }

  // Scrub paths in tool_use input blocks
  if (record.message?.content && Array.isArray(record.message.content)) {
    for (const block of record.message.content) {
      if (block.type === "tool_use" && block.input) {
        for (const [key, val] of Object.entries(block.input)) {
          if (typeof val === "string") {
            block.input[key] = val.replace(/\/home\/[^/]+\//g, "/home/anon/");
          }
        }
      }
    }
  }

  return JSON.stringify(record);
}
```

Use `SEALED_MAPPING_KEY` (already available as env var) as the HMAC key for `requestId` hashing. This ensures consistency within a deployment but prevents reversal without the key.

## 3. Modify `POST /ingest` to write to research dataset

In the ingest handler, after writing to `course.logs`:

1. Check if participant has `research_use = true` in Firestore `consent/{email}`
2. If yes, and a valid `research_token` was provided:
   - Extract `anon_id` from the verified research token payload
   - For each line in `linesToInsert`:
     - Apply `anonymizeRecord()` to the `data` field
     - Replace `participant_id` with `anon_id`
     - Replace `project_path` with `sha256(project_path)`
   - Insert rows into `course.research_logs`

The consent check should be cached per-request (single Firestore read), not per-line.

### Handling `revoked` flag

When a student toggles Research-use off via the portal:
- `POST /portal/consent` sets `research_use = false`
- New sync requests stop writing to `research.logs` (the ingest handler checks `research_use`)
- Existing research rows are flagged `revoked = true` via `POST /portal/revoke` (already implemented for course.logs — extend to research.logs)

## 4. Backfill on late opt-in

When a student opts into Research-use mid-semester, their existing `course.logs` rows (from `consented_at` onward) need to be anonymized and copied to `research.logs`.

### Trigger

In `POST /portal/consent`, when `research_use` changes from `false` to `true`:

1. Read the student's `consented_at` timestamp
2. Query `course.logs` for all rows where `participant_id = email AND timestamp >= consented_at`
3. For each row, apply `anonymizeRecord()` and insert into `research.logs` with `anon_id`

### Implementation approach

Run as a background job triggered by the consent toggle — not inline in the HTTP response. Options:

**Option A: Inline in the consent endpoint** (simplest, acceptable for <1000 rows per student)
- Query BigQuery, transform, insert. May take 5-10 seconds for large histories.
- Return 200 immediately, run backfill after response via `setImmediate` or `res.json()` then continue.

**Option B: Cloud Tasks queue** (more robust)
- Enqueue a backfill task with `{email, anon_id, consented_at}`
- A separate Cloud Run endpoint processes the task
- Better for large backlogs, but adds infrastructure complexity

Recommend **Option A** for MVP — the backfill runs after the response is sent. If a student has >1000 rows, the backfill may time out (Cloud Run default 300s) but can be retried by toggling research off and on again.

### Deduplication

Before inserting backfilled rows, check if `research.logs` already has rows for this `anon_id` + `session_id`. Skip if they exist (idempotent).

## 5. BigQuery authorized views

Create views that filter `WHERE revoked = false` for research queries:

```sql
CREATE VIEW `agent-logging.course.research_logs_authorized` AS
SELECT * FROM `agent-logging.course.research_logs`
WHERE revoked = FALSE OR revoked IS NULL;
```

All research analysis queries should use the authorized view, not the underlying table. This ensures revoked data is never included in results even if a researcher queries directly.

For the course dataset, create a similar view if needed:
```sql
CREATE VIEW `agent-logging.course.logs_authorized` AS
SELECT * FROM `agent-logging.course.logs`
WHERE revoked = FALSE OR revoked IS NULL;
```

Grant research team members access to the views only, not the underlying tables.

## 6. GCP project separation

Split the current single `agent-logging` project into three projects with structural IAM boundaries:

| Project | Resources | Access |
|---------|-----------|--------|
| `agent-logs-course` | BigQuery `course.logs`, `course.logs_authorized` view | Course instructors (BigQuery Data Viewer) |
| `agent-logs-research` | BigQuery `research.logs`, `research_logs_authorized` view | Research team only (BigQuery Data Viewer) |
| `agent-logs-admin` | Firestore (consent, sealed_mapping, offsets, surveys, allowlist), Cloud Run ingestion service | Ingestion service account only |

### Migration steps

1. Create the three GCP projects under the `@chibatech.dev` organization
2. Create BigQuery datasets in `agent-logs-course` and `agent-logs-research`
3. Move Firestore collections to `agent-logs-admin` (or create new Firestore instance)
4. Update Cloud Run service to use cross-project BigQuery writes
5. Update IAM: ingestion service account gets BigQuery Data Editor on both dataset projects, Firestore access on admin project
6. Update `GCP_PROJECT` env var (or add separate vars for each project)
7. Move `SEALED_MAPPING_KEY` to Secret Manager in `agent-logs-admin`
8. Test end-to-end: sync → course.logs write → research.logs write → authorized view query
9. Cut over: update DNS/service URL if needed, verify portal and CLI work

### IAM boundaries

- Instructors can query `course.logs_authorized` but cannot access `research.logs` or Firestore
- Researchers can query `research_logs_authorized` but cannot access `course.logs` or Firestore
- The ingestion service account is the only identity that can write to both datasets and read/write Firestore
- No human has direct access to `sealed_mapping/` — only the service account with `SEALED_MAPPING_KEY`

## Verification checklist

- [ ] `research.logs` table created with correct schema
- [ ] `anonymizeRecord()` scrubs `cwd`, `gitBranch`, `requestId`, tool_use paths
- [ ] Ingest writes to `research.logs` when `research_use = true` and valid research token present
- [ ] Ingest skips `research.logs` when `research_use = false`
- [ ] Backfill copies existing rows on late opt-in
- [ ] Backfill is idempotent (re-running doesn't duplicate)
- [ ] Authorized views filter revoked rows
- [ ] Revoke/restore on portal updates both `course.logs` and `research.logs`
- [ ] All existing tests still pass
- [ ] New tests for anonymization, research writes, backfill, views
- [ ] GCP projects created with correct IAM
- [ ] Cross-project writes work from Cloud Run
- [ ] Instructors can query course view but not research view
- [ ] Researchers can query research view but not course view
