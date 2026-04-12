# agent-logs

Session log collection for Claude Code. Syncs participant coding sessions to BigQuery for course feedback at Chiba Tech / Henkaku Center.

## Architecture

Participants install a CLI (`agent-logs`) that registers hooks in Claude Code and wraps the `claude` command with a consent dialog. On each turn, hooks sync filtered JSONL session lines to a Cloud Run ingestion service. Record-type filtering and `tool_result` stripping happen client-side before upload. The server deduplicates via a Firestore offset ledger and writes to BigQuery.

```
claude (shell wrapper)
  │
  ├─▶ agent-logs consent-dialog  (interactive Y/N per folder)
  │
  └─▶ Claude Code
        │ hooks: Stop / SubagentStop / SessionEnd
        ▼
      agent-logs sync  ──▶  Cloud Run (asia-northeast1)
                              │
                              ├─▶ Firestore (offset ledger, consent, surveys)
                              └─▶ BigQuery course.logs
```

## Components

| Directory | Description |
|-----------|-------------|
| `cli/` | Participant-side CLI — login, sync, consent-dialog, consent-status, withdraw, doctor |
| `server/` | Cloud Run ingestion service — auth, dedup, BigQuery writes, portal API |
| `docs/` | GitHub Pages site — install guide, participant portal (consent, surveys, sessions) |
| `context/` | Meeting notes, IRB ethics documents, system design plan |

## Participant setup

```bash
curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
claude             # auto-login + consent dialog + Claude Code
```

## CLI commands

```
agent-logs consent          # share logs for the current project directory
agent-logs withdraw         # stop sharing logs for the current project
agent-logs doctor           # check configuration and connectivity
agent-logs login            # re-authenticate and register hooks
agent-logs uninstall        # remove hooks, config, wrapper, and CLI
```

## Participant portal

The web portal at [agent-logs.chibatech.dev/portal.html](https://agent-logs.chibatech.dev/portal.html) provides:

- **Dashboard** — overview of shared projects, sessions, consent status, survey progress
- **Consent** — toggle Research-use consent (Educational-use is course-mandatory)
- **Survey** — pre-study, mid-semester, and post-study questionnaires
- **Sessions** — view synced session logs grouped by project
- **Delete requests** — request deletion of specific project or session data

## GCP resources

All infrastructure runs in the `agent-logging` project (asia-northeast1):

- **Cloud Run** — `agent-logs-ingestion` (scales to zero)
- **BigQuery** — `course.logs` table (identified session logs)
- **Firestore** — `offsets/` (dedup), `consent/` (research-use state), `survey_responses/` (survey data), `allowlist/` (auth), `delete_requests/`

## What gets synced

Only these record types leave the participant's machine: `user`, `assistant`, `system`, `progress`, `summary`, `custom-title`, `ai-title`. The `tool_result` content blocks are stripped from all records. File snapshots (`file-history-snapshot`) and other record types are excluded entirely.
