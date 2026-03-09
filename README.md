# AgentLens

AgentLens (AL) is a local-first audit toolkit for AI agent sessions.

- **[GitHub](https://github.com/Xiaolei-Shawn/AgentLens)** — source and issues

## Packages

- **[@xiaolei.shawn/schema](schema/)** — canonical event envelope and session schema validation.
- **[@xiaolei.shawn/mcp-server](mcp-server/)** — MCP gateway server + local dashboard API for recording, importing, and analyzing agent sessions.
- **[webapp](webapp/)** — local replay/audit UI (orchestration, reviewer, deliverables, context, and pivot flow views).

## Install

```bash
npm install @xiaolei.shawn/schema
npm install @xiaolei.shawn/mcp-server
```

## Quick start (MCP server)

Run without installing (dashboard at http://127.0.0.1:4317):

```bash
npx @xiaolei.shawn/mcp-server start --open
```

MCP mode for Cursor/Codex integration:

```bash
npx @xiaolei.shawn/mcp-server mcp
```

After install you can use the `agentlens` (or `al-mcp`) binary instead of `npx @xiaolei.shawn/mcp-server`.

## Monorepo development

From the repo root:

```bash
pnpm install
pnpm -r build
```

Run local services:

```bash
pnpm --filter @xiaolei.shawn/mcp-server start
pnpm --filter webapp dev
```

See [mcp-server/README.md](mcp-server/README.md) and [webapp/README.md](webapp/README.md) for package-level details.

## Integration check

Build all packages, start the MCP server, and verify API and dashboard:

```bash
pnpm run verify:integration
```
