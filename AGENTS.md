# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

## Project in one line

opencode-only plugin. Three Notion cache tools + one cache-first context / spec-extraction skill. **Runtime is Bun (>=1.0). No Node. No build step (Bun runs TS directly).** Layout follows the [obra/superpowers](https://github.com/obra/superpowers) shape.

## Layout

- `.opencode/plugins/agent-toolkit.ts` — plugin entrypoint. `config` hook registers `skills/` and exposes the three tools (`notion_get` / `notion_refresh` / `notion_status`).
- `lib/notion-context.ts` — single-file TTL filesystem cache + `resolveCacheKey` + `notionToMarkdown`.
- `skills/notion-context/SKILL.md` — Notion cache-first read + Korean-language spec extraction skill.
- `.opencode/INSTALL.md` — install guide for opencode users.

## Common commands

```bash
bun install
bun test           # unit tests under lib/ + .opencode/plugins/
bun run typecheck  # tsc --noEmit
```

Only `AGENT_TOOLKIT_NOTION_MCP_URL` is required. See the README env-var table for the optional ones.

## Coding rules

- **Language**: TypeScript (`type: module`). Bun runs `.ts` directly — no build, no `dist/`.
- **Imports**: do not append `.js` / `.ts` extensions (`moduleResolution: Bundler` + `allowImportingTsExtensions`).
- **ESM safety**: never use `__dirname`. Use `import.meta.url` + `fileURLToPath`, or Bun's `import.meta.dir`.
- **JSDoc**: write JSDoc on exported functions / classes. Korean comments are fine for tricky logic.
- **Errors**: include context in messages (input value, timeout, status code, pageId mismatch, …).
- **Dependencies**: avoid adding any if possible. Prefer the standard library and Bun built-ins.
- **Tests**: keep `*.test.ts` next to the source and run with `bun test`. Isolate fs-dependent tests with `mkdtempSync`.

## MVP scope (hold the line)

**In**: single-page Notion read + cache + expiry, one skill, opencode-only.

**Out**: database queries, OAuth, child pages, multi-host plugin layouts (`.claude-plugin/`, etc.), UI, codex integration. Anything beyond this scope ships as a separate PR proposal.

## Change checklist

1. `bun run typecheck` passes
2. `bun test` passes
3. If the user-facing surface (tools / env vars) changes, sync `README.md` and `.opencode/INSTALL.md`
4. If a new env var is added, also update the plugin's `readEnv()`
5. If the plugin's tool contract changes, update the tool-usage rules in `skills/notion-context/SKILL.md`

## MCP servers

`.mcp.json` registers [`context7`](https://github.com/upstash/context7) at project scope. Use it to pull up-to-date documentation for external libraries (Bun, TypeScript, the opencode plugin API, etc.).

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
