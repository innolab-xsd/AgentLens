# @xiaolei.shawn/mcp-server

Local-first MCP server for AI agent session auditing.

- Records canonical session events via MCP tools
- Persists events as local JSONL files
- Serves a local web dashboard + API from the same process
- Data never leaves the machine unless you explicitly move files

## Open-source connector model

This package is intended to be the open-source MCP connector layer.

- Open source: MCP tools + canonical event capture + local storage/API serving
- Proprietary (optional): advanced analyzer dashboard/heuristics binaries can be served separately

You can point the built-in dashboard server to any static bundle via `AL_DASHBOARD_WEBAPP_DIR`.

## Features

- Canonical event capture with sequence ordering and timestamps
- Gateway tools for low-friction agent instrumentation
- Local dashboard server + API
- Session storage on local disk (`AL_SESSIONS_DIR`)
- Local gateway API for middleware (`/api/gateway/*`)
- Export session JSON with normalized snapshot (`agentlens export`)
- Raw log adapter ingestion (`agentlens ingest`, `/api/ingest`) with duplicate suppression
- Canonical MCP session import + raw merge (`/api/import/mcp`, `/api/import/raw-merge`)
- Local deterministic analysis endpoints (follow-up generation, token breakdown, subagent graph)

## Install

```bash
npm install @xiaolei.shawn/mcp-server
```

## Run

```bash
agentlens start --open
```

This starts the local dashboard + gateway API on `http://127.0.0.1:4317` and opens a browser tab.

MCP mode (for Cursor/Codex MCP config):

```bash
agentlens mcp
```

## MCP Tools

### Canonical recorders

- `record_session_start`
- `record_intent`
- `record_activity`
- `record_decision`
- `record_assumption`
- `record_verification`
- `record_artifact_created`
- `record_intent_transition`
- `record_risk_signal`
- `record_verification_run`
- `record_diff_summary`
- `record_decision_link`
- `record_assumption_lifecycle`
- `record_blocker`
- `record_token_usage_checkpoint`
- `record_session_quality`
- `record_replay_bookmark`
- `record_hotspot`
- `record_session_end`

### Gateway tools

- `gateway_begin_run`
- `gateway_act`
- `gateway_end_run`

## Local Dashboard

When the server starts, it also runs a local HTTP server (enabled by default).

Default URL:

- `http://127.0.0.1:4317`

API endpoints:

- `GET /api/health`
- `GET /api/sessions`
- `GET /api/sessions/:key`
- `GET /api/sessions/:key/export`
- `GET /api/sessions/:key/token-breakdown`
- `GET /api/sessions/:key/subagent-graph`
- `POST /api/gateway/begin`
- `POST /api/gateway/act`
- `POST /api/gateway/end`
- `POST /api/ingest`
- `POST /api/import/mcp`
- `POST /api/import/raw-merge`
- `POST /api/followup/generate`

When installed from npm, the dashboard UI is bundled and served automatically. When running from the repo, the server uses `../webapp/dist` if present (run `pnpm run build` in the webapp first). Override with `AL_DASHBOARD_WEBAPP_DIR`.

## Automatic instrumentation defaults

To reduce agent friction:

- `gateway_act` auto-creates a session if no active session exists.
- `gateway_act` auto-creates an intent when activity arrives without an active intent.
- `record_session_end` and `gateway_end_run` persist both raw JSONL and a normalized session snapshot.

## Environment Variables

- `AL_SESSIONS_DIR` (default: `./sessions`): local session file directory.
- `AL_DASHBOARD_ENABLED` (default: `true`): enable/disable dashboard server.
- `AL_DASHBOARD_HOST` (default: `127.0.0.1`): dashboard bind host.
- `AL_DASHBOARD_PORT` (default: `4317`): dashboard bind port.
- `AL_DASHBOARD_WEBAPP_DIR` (default: auto): static webapp build directory.
- `AL_WORKSPACE_ROOT` (default: `process.cwd()`): workspace root for safe path operations.
- `AL_AUTO_GOAL` (default: `Agent task execution`): fallback goal for auto-started sessions.
- `AL_AUTO_USER_PROMPT` (default: `Auto-instrumented run`): fallback prompt for auto-started sessions.
- `AL_AUTO_REPO` / `AL_AUTO_BRANCH`: optional repo/branch attached to auto-started sessions.
- `AL_INGEST_FINGERPRINT_MIN_CONFIDENCE` (default: `0.62`): min confidence for automatic merge matching.
- `AL_INGEST_FINGERPRINT_MAX_WINDOW_HOURS` (default: `72`): max time window for automatic merge matching.

Compatibility aliases:

- All `AL_*` variables above also accept `MCP_AL_*` aliases (for example `MCP_AL_SESSIONS_DIR`).

## Cursor/Codex MCP configuration example

```json
{
  "mcpServers": {
    "agentlens": {
      "command": "agentlens",
      "args": ["mcp"],
      "env": {
        "AL_SESSIONS_DIR": "/absolute/path/to/sessions"
      }
    }
  }
}
```

## Build from source

From the [monorepo root](https://github.com/Xiaolei-Shawn/AgentLens):

```bash
pnpm install
pnpm --filter @xiaolei.shawn/mcp-server build
pnpm --filter @xiaolei.shawn/mcp-server start
```

## Export session JSON

Export latest session:

```bash
agentlens export --latest --out ./latest.session.json
```

Export by session id:

```bash
agentlens export --session sess_1771256059058_2bd2bd8f --out ./session.json
```

## Ingest raw logs via adapters

Example: ingest Codex raw JSONL and convert to canonical events:

```bash
agentlens ingest --input /path/to/rollout.jsonl --adapter codex_jsonl
```

Example: ingest Cursor raw logs that contain `<user_query>`, `<think>`, and `Tool call/Tool result` blocks:

```bash
agentlens ingest --input /path/to/cursor-log.txt --adapter cursor_raw
```

Auto-detect adapter and merge into an existing session with dedupe:

```bash
agentlens ingest --input /path/to/raw.jsonl --adapter auto --merge-session sess_123
```

Notes:

- Ingest writes canonical events to `<session_id>.jsonl`.
- Original raw content is preserved in `<session_id>.<adapter>.raw.jsonl`.
- **Merge and dedupe**: When merging into an existing session (e.g. raw log + MCP-canonical events), ingest uses **semantic dedupe** so the same logical event (intent, tool call, artifact, etc.) is not duplicated even if timestamps or payload details differ. Merged events are written in **time order** with contiguous `seq` for accurate recommendations/risk/hotspot analysis.
- Duplicate events are skipped by default (exact or semantic key depending on merge).
- Codex adapter preserves user prompts, reasoning summaries, assistant outputs, tool calls/results, and normalized token checkpoints.
- Cursor adapter preserves user queries, `<think>` reasoning traces, tool call/result traces, and token counters when present.
- If `--merge-session` is omitted, ingest attempts **fingerprint match** automatically:
  - Primary signal: normalized user prompt / intent similarity
  - Secondary signal: timestamp proximity (recent sessions weighted higher)
  - Min confidence: `AL_INGEST_FINGERPRINT_MIN_CONFIDENCE` (default `0.62`)
  - Max time window (hours): `AL_INGEST_FINGERPRINT_MAX_WINDOW_HOURS` (default `72`)
- Ingest output includes `merge_strategy` (`explicit_merge`, `adapted_session_id`, `fingerprint_match`, `new_session`) and optional `merge_confidence`.

## Import and merge via dashboard API

1. Import one or more canonical MCP session logs:

```bash
curl -X POST http://127.0.0.1:4317/api/import/mcp \
  -H "content-type: application/json" \
  -d '{"files":[{"name":"session.jsonl","content":"...jsonl content..."}]}'
```

2. Merge supplemental raw logs into an imported session:

```bash
curl -X POST http://127.0.0.1:4317/api/import/raw-merge \
  -H "content-type: application/json" \
  -d '{"import_set_id":"iset_xxx","target_session_id":"sess_xxx","raw":"...raw log...","adapter":"auto","dedupe":true}'
```
