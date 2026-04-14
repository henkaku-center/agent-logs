# Session Summary — 2026-04-14

## Research: Anthropic product surface logging capabilities

Surveyed all Anthropic product surfaces for session log capture:

| Product | OTel | Compliance API | Data export | Local JSONL |
|---|---|---|---|---|
| Claude Code CLI | Yes (opt-in) | No | No | `~/.claude/projects/` |
| Claude Code Web | **No** (open feature request) | No | No | No |
| Claude Cowork (Desktop) | Yes (Team/Enterprise) | **No** | **No** | Local only |
| Claude Chat (claude.ai) | No | Events only (no content) | Yes (manual) | No |
| Office Agents | Yes (Enterprise) | Partial | No | No |
| Claude API | N/A (you own data) | Yes | N/A | N/A |

Key finding: **assistant response text is not available via OTel on any surface** — only JSONL sync captures both sides of the conversation. OTel provides operational telemetry (cost, latency, tool decisions) but not what Claude actually said.

Recommendation: mandate Claude Code CLI for coursework (richest data), configure OTel for Cowork as backup, accept the gap for Chat and Code Web (not blockable without enterprise network infrastructure).

## JSONL vs OTel gap analysis

Validated against real JSONL files in `~/.claude/projects/`. Found record types not being synced:

| Type | Records (across all projects) | Previously synced? | Research value |
|---|---|---|---|
| `queue-operation` | 1,176 (2.3%) | No | High — student's queued follow-up messages |
| `permission-mode` | 8 (0.0%) | No | Moderate — trust level changes |
| `file-history-snapshot` | 2,398 (4.8%) | No | Low — undo bookkeeping |
| `last-prompt` | 140 (0.3%) | No | Low — UI state |
| `attachment` | 8 (0.0%) | No | Low — MCP instructions, could leak config |

Token counts (`message.usage`) are already captured on `assistant` records — no changes needed.

## Changes made

### CLI (`cli/sync.js`)

1. **Added `queue-operation` and `permission-mode` to `ALLOWED_TYPES`** (7 → 9 types)
2. **`stripToolResults` now preserves `toolUseResult` metadata** — keeps operational fields (`status`, `durationMs`, `bytes`, `code`, `codeText`, `interrupted`, `is_error`) and replaces content strings (`stdout`, `stderr`, `result`, `prompt`, `content`) with `*_length` integers

### CLI (`cli/index.js`)

3. **Added `agent-logs update` command** — runs the install script to fetch latest binary

### Server (`server/index.js`)

4. **Fixed data loss bug**: offset ledger was advanced in a Firestore transaction BEFORE BigQuery insert. If BQ returned 500, offset was committed — retries skipped lines permanently. Fix: BQ write happens first, offset advances only on success.
5. **Tightened concurrent request guard** from `freshOffset <= offset` to `freshOffset === offset` — prevents two simultaneous requests from both advancing the offset.
6. **Fixed research backfill dedup**: was session-level (`r.session_id IS NULL`), now row-level (`r.session_id AND r.file_name AND r.timestamp`). Partial dual-write failures are now recoverable on next consent toggle.
7. **Eliminated double `JSON.parse`** in ingest — parse once, reuse for BQ rows and title extraction.

### Docs (`docs/install.sh`)

8. Put `source` command on its own line in install output.

## Deployments

- **CLI v0.3.1** released — all 4 platform binaries (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
- **Server** redeployed twice to Cloud Run (revision 00043 for initial fix, 00044 for review fixes)
- Students update via `agent-logs update` or `curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash`

## Key learnings

- **JSONL is irreplaceable for research**: OTel gives operational telemetry but never includes assistant response text. For studying student-AI interaction patterns, the JSONL sync is the only source that captures both sides of the conversation.
- **Claude Code Web and Claude Chat are blind spots**: no logging mechanism exists for either. Enterprise tenant restrictions require network-level TLS inspection — impractical for a university. Policy ("use CLI for coursework") is the only viable control.
- **Cowork OTel is the only path for Desktop users**: Cowork activity doesn't appear in audit logs, Compliance API, or data exports. OTel is the sole capture mechanism, and it requires Team/Enterprise admin configuration.
- **The consent form already covers full content collection**: the ethics-approved language says "session logs capture the full content of your interactions." The `tool_result` stripping was an extra privacy safeguard beyond what was promised — useful context for any future "yolo mode" binary discussion.
- **Write-before-advance is the correct pattern for offset dedup**: the original code advanced the offset in a Firestore transaction before the BigQuery insert, creating a window where transient BQ failures permanently lost data. This is a common distributed systems bug — the ledger must only advance after the data write succeeds.
- **Session-level dedup is insufficient for research backfill**: a partial dual-write failure (some rows written, some not) leaves a session that "exists" in the research table but is incomplete. Row-level dedup on `(session_id, file_name, timestamp)` is needed to recover individual missing rows.
- **Client-side cursor contention is benign**: concurrent hook triggers racing on `cursors.json` can rewind a cursor, but server-side offset checks catch the duplicate — wasted work, not data loss.

## Known remaining risks

- **Concurrent sync cursor contention**: `cursors.json` read-modify-write is not locked. Two simultaneous hook triggers can overwrite each other's cursor progress. Server dedup prevents data loss but causes redundant retries.
- **Research dual-write is fire-and-forget**: if BQ insert fails after main write, research rows are lost until next consent toggle triggers backfill (now row-level).
- **No dead-letter queue**: failed syncs wait until the next hook trigger. JSONL files persist on disk so nothing is lost, just delayed.
- **Duplicate BQ rows on concurrent identical requests**: two requests with the same offset can both write to BQ before the transaction guard. Duplicates are safe and dedup-able in queries.

## Scalability assessment (300 participants × 3 concurrent sessions)

Pipeline is safe against data loss at this scale. Efficiency concerns:
- Each hook trigger scans all shared projects sequentially (no parallelism)
- Cursor file contention causes redundant retries under concurrent hooks
- Thundering herd during class periods (mitigatable with jitter in hook command)
- Cloud Run auto-scaling and Firestore per-document write limits are sufficient
