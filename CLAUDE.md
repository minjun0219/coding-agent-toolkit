@AGENTS.md

## Claude Code

- The `context7` and `agent-toolkit` MCP servers in `.mcp.json` show a trust prompt the first time Claude Code loads them — approve both to enable.
- `agent-toolkit` is a stdio MCP server (`bun run server/index.ts`) that exposes 15 of the toolkit's 28 tools to Claude Code (OpenAPI / MySQL / journal / `spec_pact_fragment`). The 13 omitted tools (`notion_*` ×4, `pr_*` ×6, `gh_run`, `issue_*` ×2) belong to removal-candidate domains tracked in [`REMOVAL_CANDIDATES.md`](./REMOVAL_CANDIDATES.md); they remain wired up to the opencode entrypoint for now.

## Dependency notes

The exact dependency policy is the single source of truth in [`AGENTS.md`](./AGENTS.md) under "Coding rules → Dependencies". TL;DR for this surface: `@modelcontextprotocol/sdk` + `zod` are explicit prod-dep exceptions required by `server/index.ts` (the MCP wire protocol is too large to hand-roll for the Claude Code entrypoint; zod is the SDK's blessed schema dialect). Any further runtime deps still need a separate scope discussion as documented in `AGENTS.md`.
