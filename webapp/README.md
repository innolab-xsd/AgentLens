# AgentLens Web App

Local replay and audit UI for AgentLens sessions.

The app focuses on reviewing real session outcomes, including:

- session import and raw-log merge workflows
- orchestration timeline and flow playback
- reviewer highlights and risk/verification focus
- deliverable-centric "what/why/cost" views
- context-path and pivot flow exploration
- local follow-up rule/skill draft generation from session evidence

## Run

From the monorepo root:

```bash
pnpm install
pnpm --filter @xiaolei.shawn/mcp-server start
pnpm --filter webapp dev
```

Open the Vite URL (for example `http://localhost:5173`).

## Recommended workflow

1. Start the MCP server dashboard API (`agentlens start` or `pnpm --filter @xiaolei.shawn/mcp-server start`).
2. In the web app, import canonical MCP logs (one or many files).
3. Optionally merge supplemental raw Codex/Cursor logs into the imported target session.
4. Launch the session and inspect it through the available views.

## API dependency

The loader integrates with the local dashboard API for:

- `GET /api/sessions`
- `GET /api/sessions/:key`
- `POST /api/import/mcp`
- `POST /api/import/raw-merge`

If API import is unavailable, canonical session files can still be loaded locally as a fallback, but import-set persistence and raw-merge workflows require the dashboard API.

## Environment variables

- `VITE_AUDIT_API_BASE` (optional): base URL for API requests. Default: same origin.
- `VITE_APP_VERSION` (optional): version label shown in the footer.

## Build

From the monorepo root:

```bash
pnpm --filter webapp build
```

Output is in `webapp/dist/`. The MCP server can serve this directory directly.
