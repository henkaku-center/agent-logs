# CLAUDE.md

Session log collection system for Claude Code usage in CIT courses (APS-I, Web3/AI Gairon). Collects student-AI interaction data for instruction and optional anonymized research.

## Architecture

```
Student machine                     GCP (agent-logging project)
─────────────────                   ────────────────────────────
Claude Code (CLI/VS Code/JetBrains) Cloud Run (agent-logs-ingestion)
  ↓ SessionStart hook                 ↓
  auto-share (if consent signed)    POST /ingest → BigQuery course.logs
  ↓ Stop/SubagentStop/SessionEnd      ↓ (if research_use)
  agent-logs sync (byte-offset)     Phase 1 anonymize → BigQuery research_logs
                                      ↓
                                    Firestore (consent, sealed_mapping, offsets)

Web portal (GitHub Pages)           Same Cloud Run service
  docs/portal.html                  POST /portal/consent, /survey, /revoke
  docs/index.html (install docs)    GET /portal/sessions, /consent/pdf
```

## Key directories

- `server/` — Cloud Run ingestion service (Express, BigQuery, Firestore)
- `cli/` — Student-side CLI tool (login, sync, consent, hooks)
- `docs/` — GitHub Pages portal (consent form, surveys, session browser)
- `context/` — Research plan, ethics docs, meeting notes, session summaries (not deployed)

## Commands

```bash
# Server
cd server && npm test
cd server && gcloud run deploy agent-logs-ingestion --source . --project=agent-logging --region=asia-northeast1

# CLI
cd cli && npm test

# Admin (requires admin JWT)
agent-logs admin list                    # Show allowlist
agent-logs admin add-domain <domain>     # Allow email domain
agent-logs admin add-email <email>       # Allow specific email
agent-logs admin roles                   # Show instructor/researcher assignments
agent-logs admin add-instructor <email>  # Grant course.logs_view access
agent-logs admin add-researcher <email>  # Grant research_logs_view access
```

## Release process

**ALWAYS create a new tag — never reuse or overwrite existing tags.** GitHub caches release assets by tag name; reusing a tag can serve stale binaries to students.

```bash
cd cli && npm test                       # must pass
cd server && npm test                    # must pass if server changed
git push origin main
git tag v0.X.Y                           # increment from previous, never reuse
git push origin v0.X.Y                   # triggers .github/workflows/release.yml
```

The release workflow builds Node.js SEA binaries for 4 platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64) and uploads them as release assets with checksums.

After CLI release, students update via:
```bash
curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash
```

Or if they already have v0.3.2+:
```bash
agent-logs update
```

No re-login or re-consent needed — credentials and project sharing config persist.

Server changes require Cloud Run deployment (see deployment checklist below).

## GCP resources (all in `agent-logging` project, asia-northeast1)

- **BigQuery `course.logs`** — Identified session logs (participant_id = email)
- **BigQuery `course.research_logs`** — Anonymized logs (anon_id, Phase 1 scrubbed)
- **BigQuery `course.logs_view`** — `WHERE revoked = FALSE` (for instructors)
- **BigQuery `course.research_logs_view`** — `WHERE revoked = FALSE` (for researchers)
- **BigQuery `course.cowork_events`** — OTLP telemetry from Claude Cowork
- **Firestore `consent/{email}`** — Research-use toggle, signed_at, consented_at, consent_pdf
- **Firestore `sealed_mapping/{sha256(email)}`** — AES-256-GCM encrypted {email, anon_id}
- **Firestore `offsets/{participant}/{session}/{file}`** — Byte-offset dedup ledger
- **Firestore `roles/instructors`, `roles/researchers`** — BigQuery access lists
- **Firestore `allowlist/domains`, `allowlist/emails`** — Authorized participants
- **Cloud Run `agent-logs-ingestion`** — Serverless, scales to zero
- **Cloud Monitoring** — 5xx alert policy on agent-logs-ingestion (emails admin on sustained errors)

## Access control

Instructors get `bigquery.dataViewer` on `logs_view` only. Researchers get `bigquery.dataViewer` on `research_logs_view` only. Both get `bigquery.jobUser` at project level to run queries. Managed via `agent-logs admin add-instructor/add-researcher`. Any Google account (including @gmail.com) works.

The Cloud Run service account requires `roles/resourcemanager.projectIamAdmin` (to manage project-level `bigquery.jobUser` bindings) and `roles/bigquery.dataOwner` (to set view-level IAM policies). Without these, the role-sync silently fails — the CLI now exits with code 2 and prints the error if this happens.

The `SEALED_MAPPING_KEY` env var on Cloud Run is the only way to link anon_id to email. Destroyed 1 month post-course.

## Data flow: sync

1. Claude Code hooks (`Stop`, `SubagentStop`, `SessionEnd`) trigger `agent-logs sync`
2. CLI reads JSONL from `~/.claude/projects/{dir}/`, filters by `ALLOWED_TYPES`, strips `tool_result` content, preserves `toolUseResult` metadata (size/status signals only)
3. Per-line consent filter: records with `timestamp < consented_at` for that project are dropped
4. POSTs to `/ingest` with JWT auth + research token
5. Server writes to `course.logs` (BigQuery) in chunked batches (≤9,000 params per query to stay under BigQuery's 10k limit), then advances offset in Firestore (write-before-advance pattern — critical for data loss prevention)
6. Optionally dual-writes to `research_logs` (if research_use=true), using the same pre-computed timestamps to ensure the (session_id, file_name, timestamp) dedup key is consistent across both tables

### JSONL record types synced (ALLOWED_TYPES in cli/sync.js)

`user`, `assistant`, `system`, `progress`, `summary`, `custom-title`, `ai-title`, `queue-operation`, `permission-mode`

### What gets stripped

- `tool_result` content blocks inside `message.content` — replaced with stub `{type, tool_use_id}`
- `toolUseResult` top-level field — content strings (stdout, stderr, result, prompt, content) replaced with `*_length` integers; operational metadata preserved (status, durationMs, bytes, code, codeText, interrupted, is_error)

### What is NOT synced

- `file-history-snapshot` — undo bookkeeping, no research value
- `last-prompt` — UI state only
- `attachment` — MCP instructions, could leak system config

## Data flow: consent toggle

- **Opt-in** (`POST /portal/consent {research_use: true}`): restores any previously revoked research rows, then backfills course.logs rows not yet in research.logs (LEFT JOIN dedup at row level on session_id + file_name + timestamp, Phase 1 anonymization)
- **Opt-out** (`POST /portal/consent {research_use: false}`): flags all research rows as `revoked = true` (hidden from authorized views, permanently deleted 1 month post-course)
- **Revoke session** (`POST /portal/revoke`): cascades to both course.logs and research.logs

## Consent form

The portal consent form (`docs/portal.html` sections 1-11) is the document students sign. It describes the actual system (sealed mapping + email auth). The submitted PDF to the ethics committee (2026-03-17) has older language (client-side key pairs) that was updated in the portal before launch.

Key promises:
- Research participation is voluntary, no effect on grades
- Withdrawal hides data immediately, permanent deletion 1 month post-course
- No audio/video/keystroke/browsing data — only AI session logs
- `tool_result` content stripped before data leaves student machine
- Phase 1 structural anonymization at ingestion; Phase 2 LLM scrub post-course (not yet built)

Note: the consent form language ("session logs capture the full content of your interactions") already covers collecting more than what is currently synced. The `tool_result` stripping is a privacy safeguard beyond what was promised.

## Shell wrapper, consent-dialog, and auto-share

The install script adds a shell function to `.bashrc`/`.zshrc`:
```bash
claude() { if command -v agent-logs &>/dev/null; then agent-logs consent-dialog; [ $? -eq 3 ] && return 0; fi; command claude "$@"; }
```

This wrapper only fires for terminal launches. VS Code and JetBrains extensions call the `claude` binary directly, bypassing it. To ensure all surfaces are covered, the `SessionStart` hook (`agent-logs context`) auto-shares folders for students who have signed the consent form but haven't explicitly shared or withdrawn the current folder. The auto-share uses the portal `signed_at` timestamp as `consented_at`, so historical records from after the student signed consent are synced — not just future ones.

A self-healing repair step also runs on each SessionStart: if any shared folder has `consented_at` newer than `signed_at` (from a previous bug), it is backdated to `signed_at`.

Exit code semantics for `consent-dialog`:
- **Exit 0**: consent already decided (shared or withdrawn) — proceed to launch Claude
- **Exit 3**: intentional block (consent form not signed, user pressed Esc) — don't launch Claude
- **Any other exit** (1, 139/SIGSEGV, etc.): unexpected error/crash — launch Claude anyway

CLI exit codes (all commands):
- **0**: success
- **1**: usage error or authentication failure
- **2**: partial failure (e.g. role saved but IAM sync failed)
- **3**: consent pending — do not launch Claude

## Known data integrity risks

1. **Concurrent sync cursor contention**: `cursors.json` read-modify-write on the client is not locked. Two simultaneous hook triggers can overwrite each other's cursor progress. Server dedup prevents data loss but causes redundant retries.
2. **Research dual-write is fire-and-forget**: if BigQuery insert fails after main write, research rows are lost until next consent toggle triggers backfill (now row-level dedup).
3. **Duplicate BQ rows on concurrent identical requests**: two requests with the same offset can both write to BigQuery before the Firestore transaction guard. Duplicates are safe and dedup-able in queries.
4. **No dead-letter queue**: failed syncs wait until the next hook trigger. JSONL files persist on disk so nothing is lost, just delayed.
5. **Chunked INSERT partial success**: large batches are split into sub-queries. If chunk N fails after chunks 1..N-1 succeeded, those rows are in BigQuery but the offset doesn't advance. Client retries the full batch, producing duplicates of earlier chunks. Failure is logged with chunk index and row range for traceability.

## Scalability (tested for 300 participants × 3 concurrent sessions)

- Cloud Run auto-scales; Firestore per-document write limits are sufficient
- Each hook trigger scans all shared projects sequentially (no parallelism)
- Thundering herd during class periods mitigatable with jitter in hook command
- Pipeline is safe against data loss at this scale; efficiency concerns are minor

## Anthropic product surface coverage

| Product | Log capture method | What's missing |
|---|---|---|
| Claude Code CLI | JSONL sync (richest) + optional OTel | Nothing — full conversation both sides |
| Claude Code VS Code extension | JSONL sync (same as CLI) + SessionStart auto-share | Nothing — hooks fire on all surfaces |
| Claude Code JetBrains extension | JSONL sync (same as CLI) + SessionStart auto-share | Nothing — hooks fire on all surfaces |
| Claude Cowork (Desktop) | OTel only (Team/Enterprise admin config) | Assistant response text not in OTel |
| Claude Code Web | **No mechanism** (open feature request) | Complete blind spot |
| Claude Chat (claude.ai) | Enterprise data export only (manual) | No programmatic access to content |
| Office Agents | OTel traces (Enterprise) | Assistant response text excluded from spans |

JSONL sync is irreplaceable for research — it's the only source capturing both sides of the conversation. OTel provides operational telemetry (cost, latency, tool decisions) but never assistant response text.

## Deployment checklist

After any server change:
1. `cd server && npm test` — all tests must pass
2. `git push origin main` — updates GitHub Pages portal
3. `gcloud run deploy agent-logs-ingestion --source . --project=agent-logging --region=asia-northeast1`
4. Verify no 5xx errors in Cloud Run logs for the new revision

After CLI changes:
1. `cd cli && npm test` — all tests must pass
2. `git push origin main`
3. Create new tag: `git tag v0.X.Y && git push origin v0.X.Y`
4. Students update via `agent-logs update` or `curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash`

## Environment variables (Cloud Run)

- `JWT_SECRET` — Signs auth + research tokens
- `SEALED_MAPPING_KEY` — 64-char hex, AES-256-GCM key for identity mapping
- `GMAIL_SENDER` — Email sender address (claude@chibatech.dev)
- `ADMIN_EMAILS` — Comma-separated admin emails
- `OTLP_SECRET` — Shared secret for OTLP telemetry ingestion
- `GCP_PROJECT` — Default: agent-logging

## Service account permissions

The Cloud Run default compute service account requires:
- `roles/bigquery.dataOwner` — set IAM policies on views for instructor/researcher grants
- `roles/bigquery.jobUser` — run queries (inserts, backfill)
- `roles/datastore.user` — read/write Firestore (consent, offsets, roles)
- `roles/resourcemanager.projectIamAdmin` — manage project-level IAM (bigquery.jobUser bindings)
- `roles/iam.serviceAccountTokenCreator` — sign JWTs for Gmail API delegation
- `roles/artifactregistry.writer`, `roles/storage.objectAdmin` — Cloud Build artifacts
