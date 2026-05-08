@AGENTS.md

## Claude Code

- The `context7` and `agent-toolkit` MCP servers in `.mcp.json` show a trust prompt the first time Claude Code loads them — approve both to enable.
- `agent-toolkit` is a stdio MCP server (`bun run server/index.ts`) that exposes 19 of the toolkit's 28 tools to Claude Code (Notion / OpenAPI / MySQL / journal / `spec_pact_fragment`). The 9 omitted tools belong to removal-candidate domains tracked in [`REMOVAL_CANDIDATES.md`](./REMOVAL_CANDIDATES.md); they remain wired up to the opencode entrypoint for now.

## Dependency notes (deviation from the "no new deps" rule)

`@modelcontextprotocol/sdk` and `zod` are runtime deps required by `server/index.ts`. The MCP wire protocol (JSON-RPC framing, capability negotiation, content-block shape) is too large to hand-roll for the Claude Code surface; zod ships as the SDK's blessed schema dialect. This is the second deliberate exception to the "avoid runtime dependencies" rule (the first being `mysql2`). Any further runtime deps still need a separate scope discussion.
