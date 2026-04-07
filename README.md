# agent-logs

Session log collection for Claude Code. Syncs student coding sessions to BigQuery for course feedback at Chiba Tech School of Design & Science.

## Architecture

Students install a CLI (`agent-logs`) that reads Claude Code's local JSONL session files and syncs filtered lines to a Cloud Run ingestion service. Record-type filtering and `tool_result` stripping happen client-side before upload. The server deduplicates via a Firestore offset ledger and writes to BigQuery.

```
Claude Code JSONL files
        │
        ▼
  agent-logs sync          Cloud Run (asia-northeast1)
  (Stop / SubagentStop /  ──▶  Ingestion Service
   SessionEnd hooks)           │
                               ├─▶ Firestore (offset ledger, dedup)
                               └─▶ BigQuery course.logs
```

## Components

| Directory | Description |
|-----------|-------------|
| `cli/` | Student-side CLI — login, sync, consent, withdraw, doctor |
| `server/` | Cloud Run ingestion service — auth, dedup, BigQuery writes |
| `docs/` | Student portal — install guide, commands reference, troubleshooting |
| `install/` | Install script for student distribution |
| `plan.md` | Full system design document |

## Student setup

```bash
curl -fsSL https://logs.chibatech.dev/install.sh | bash
agent-logs login
cd ~/coursework/my-project
agent-logs consent
```

## CLI commands

```
agent-logs login       # authenticate and register Claude Code hooks
agent-logs consent     # share logs for the current project directory
agent-logs withdraw    # stop sharing logs for the current project
agent-logs doctor      # check configuration and connectivity
```

## GCP resources

All infrastructure runs in the `agent-logging` project (asia-northeast1):

- **Cloud Run** — `agent-logs-ingestion` (scales to zero)
- **BigQuery** — `course.logs` table (identified session logs)
- **Firestore** — `offsets/` collection (dedup ledger)

## What gets synced

Only these record types leave the student's machine: `user`, `assistant`, `system`, `progress`, `summary`, `custom-title`, `ai-title`. The `tool_result` content blocks are stripped from all records. File snapshots (`file-history-snapshot`) and other record types are excluded entirely.
