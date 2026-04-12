# CLAUDE.md

Session log collection system for Claude Code usage in CIT courses (APS-I, Web3/AI Gairon). Collects student-AI interaction data for instruction and optional anonymized research.

## Architecture

```
Student machine                     GCP (agent-logging project)
─────────────────                   ────────────────────────────
Claude Code + agent-logs CLI        Cloud Run (agent-logs-ingestion)
  ↓ SessionStart hook                 ↓
  consent-dialog (forced Y/N)       POST /ingest → BigQuery course.logs
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
- `context/` — Research plan, ethics docs, meeting notes (not deployed)

## Commands

```bash
# Server
cd server && npm test                    # 93 tests, node:test with mocked GCP
cd server && gcloud run deploy agent-logs-ingestion --source . --project=agent-logging --region=asia-northeast1

# CLI
cd cli && npm test                       # ~63 tests

# Admin (requires admin JWT)
agent-logs admin list                    # Show allowlist
agent-logs admin add-domain <domain>     # Allow email domain
agent-logs admin add-email <email>       # Allow specific email
agent-logs admin roles                   # Show instructor/researcher assignments
agent-logs admin add-instructor <email>  # Grant course.logs_view access
agent-logs admin add-researcher <email>  # Grant research_logs_view access
```

## GCP resources (all in `agent-logging` project, asia-northeast1)

- **BigQuery `course.logs`** — Identified session logs (participant_id = email)
- **BigQuery `course.research_logs`** — Anonymized logs (anon_id, Phase 1 scrubbed)
- **BigQuery `course.logs_view`** — `WHERE revoked = FALSE` (for instructors)
- **BigQuery `course.research_logs_view`** — `WHERE revoked = FALSE` (for researchers)
- **BigQuery `course.cowork_events`** — OTLP telemetry from Claude Cowork
- **Firestore `consent/{email}`** — Research-use toggle, signed_at
- **Firestore `sealed_mapping/{sha256(email)}`** — AES-256-GCM encrypted {email, anon_id}
- **Firestore `offsets/{participant}/{session}/{file}`** — Byte-offset dedup ledger
- **Firestore `roles/instructors`, `roles/researchers`** — BigQuery access lists
- **Firestore `allowlist/domains`, `allowlist/emails`** — Authorized participants
- **Cloud Run `agent-logs-ingestion`** — Serverless, scales to zero

## Access control

Instructors get `bigquery.dataViewer` on `logs_view` only. Researchers get `bigquery.dataViewer` on `research_logs_view` only. Both get `bigquery.jobUser` at project level to run queries. Managed via `agent-logs admin add-instructor/add-researcher`. Any Google account (including @gmail.com) works.

The `SEALED_MAPPING_KEY` env var on Cloud Run is the only way to link anon_id to email. Destroyed 1 month post-course.

## Data flow: sync

1. Claude Code hooks (`Stop`, `SubagentStop`, `SessionEnd`) trigger `agent-logs sync`
2. CLI reads JSONL from `~/.claude/projects/{dir}/`, filters by record type, strips `tool_result` content
3. POSTs to `/ingest` with JWT auth + research token
4. Server writes to `course.logs`, optionally dual-writes to `research_logs` (if research_use=true)
5. Offset ledger in Firestore prevents duplicates

## Data flow: consent toggle

- **Opt-in** (`POST /portal/consent {research_use: true}`): restores any previously revoked research rows, then backfills course.logs rows not yet in research.logs (LEFT JOIN dedup, Phase 1 anonymization)
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

## Deployment checklist

After any server change:
1. `cd server && npm test` — all tests must pass
2. `git push origin main` — updates GitHub Pages portal
3. `gcloud run deploy agent-logs-ingestion --source . --project=agent-logging --region=asia-northeast1`

After CLI changes that affect hooks or commands:
- Students must re-run `agent-logs login` or reinstall via `install.sh`

## Environment variables (Cloud Run)

- `JWT_SECRET` — Signs auth + research tokens
- `SEALED_MAPPING_KEY` — 64-char hex, AES-256-GCM key for identity mapping
- `GMAIL_SENDER` — Email sender address (claude@chibatech.dev)
- `ADMIN_EMAILS` — Comma-separated admin emails
- `OTLP_SECRET` — Shared secret for OTLP telemetry ingestion
- `GCP_PROJECT` — Default: agent-logging
