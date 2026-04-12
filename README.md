# agent-logs

Session log collection for Claude Code. Syncs participant coding sessions to BigQuery for evaluation and feedback at Chiba Tech / Henkaku Center.

## Architecture

Participants install a CLI (`agent-logs`) that registers hooks in Claude Code and wraps the `claude` command with a consent dialog. Before launching Claude, the wrapper checks that the participant has signed the informed consent form on the web portal. On each turn, hooks sync filtered JSONL session lines to a Cloud Run ingestion service. Record-type filtering and `tool_result` stripping happen client-side before upload. The server deduplicates via a Firestore offset ledger and writes to BigQuery.

At login, each participant receives a **research token** — a signed JWT containing a random anonymous identifier. The email-to-anon_id mapping is stored encrypted (AES-256-GCM) in Firestore. The server never stores this link in plaintext.

```
claude (shell wrapper)
  │
  ├─▶ agent-logs consent-dialog
  │     1. Login (email verification code → JWT + research token)
  │     2. Check consent form signed (cached locally after first check)
  │     3. Per-folder consent prompt (interactive Y/N)
  │
  └─▶ Claude Code
        │ hooks: Stop / SubagentStop / SessionEnd
        ▼
      agent-logs sync  ──▶  Cloud Run (asia-northeast1)
        (auth JWT +            │
         research token)       ├─▶ Firestore (offset ledger, consent, sealed mapping)
                               └─▶ BigQuery course.logs
```

## Components

| Directory | Description |
|-----------|-------------|
| `cli/` | Participant-side CLI — login, sync, consent-dialog, consent-status, withdraw, doctor |
| `server/` | Cloud Run ingestion service — auth, dedup, BigQuery writes, portal API, research token issuance |
| `docs/` | GitHub Pages site — install guide, participant portal (consent, surveys, logs, insights) |
| `context/` | Meeting notes, IRB ethics documents, system design plan |

## Participant setup

```bash
curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
claude             # login → sign consent form → folder consent → Claude Code
```

## CLI commands

```
agent-logs consent          # share logs for the current project directory
agent-logs withdraw         # stop sharing logs for the current project
agent-logs doctor           # check configuration and connectivity
agent-logs login            # re-authenticate, register hooks, reissue research token
agent-logs opt-in           # enable research-use (anonymised logs for research)
agent-logs opt-out          # disable research-use
agent-logs uninstall        # remove hooks, config, wrapper, and CLI
```

## Participant portal

The web portal at [agent-logs.chibatech.dev/portal.html](https://agent-logs.chibatech.dev/portal.html) provides:

- **Consent** (default tab) — informed consent form with Educational-use and Research-use toggles, sign and export PDF
- **Survey** — pre-course, mid-course, and post-course questionnaires
- **Logs** — synced session logs grouped by project, with withdraw/restore toggle
- **Insights** — overview of shared projects, sessions, consent status, survey progress

## GCP resources

All infrastructure runs in the `agent-logging` project (asia-northeast1):

- **Cloud Run** — `agent-logs-ingestion` (scales to zero)
- **BigQuery** — `course.logs` (identified session logs), `cowork_events` (OTLP telemetry)
- **Firestore** — `offsets/` (dedup), `consent/` (research-use state, signed_at), `sealed_mapping/` (encrypted identity mapping), `survey_responses/`, `allowlist/` (auth), `delete_requests/`, `session_titles/`, `auth_codes/` (temporary verification codes)

## Identity and privacy

- **Auth**: email magic code verification → JWT (90-day expiry) + research token (no expiry, reissued on login)
- **Research token**: signed JWT `{anon_id, type: "research"}` stored at `~/.config/agent-logs/token.json`
- **Sealed mapping**: `sealed_mapping/{sha256(email)}` in Firestore — AES-256-GCM encrypted `{email, anon_id}`, decryptable only by the ingestion service via `SEALED_MAPPING_KEY` env var
- **Consent**: Educational-use locked after signing; Research-use can be changed anytime
- **Retention**: sealed mapping key destroyed 1 month post-course → mapping becomes irrecoverable

## What gets synced

Only these record types leave the participant's machine: `user`, `assistant`, `system`, `progress`, `summary`, `custom-title`, `ai-title`. The `tool_result` content blocks are stripped from all records (stub with `tool_use_id` retained). File snapshots (`file-history-snapshot`), `last-prompt`, `queue-operation`, `attribution-snapshot`, `content-replacement`, `permission-mode`, `attachment`, and `pr-link` are excluded entirely. Only records timestamped at or after the project's consent time are synced.

## Testing

```bash
cd cli && npm test       # 63 tests — filtering, stripping, cursors, config, hooks
cd server && npm test    # 75 tests — auth, ingest, portal, admin, OTLP, CORS
```

## Environment variables (Cloud Run)

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Signs auth JWTs and research tokens |
| `SEALED_MAPPING_KEY` | 32-byte hex key for AES-256-GCM encryption of identity mapping |
| `GMAIL_SENDER` | Email address for verification codes (domain-wide delegation) |
| `OTLP_SECRET` | Shared secret for OTLP telemetry ingestion |
| `ADMIN_EMAILS` | Comma-separated admin emails for allowlist management |
| `GCP_PROJECT` | BigQuery/Firestore project ID |
