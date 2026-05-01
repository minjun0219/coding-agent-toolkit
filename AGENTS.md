# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

## Project in one line

opencode-only plugin. Three Notion cache tools + five OpenAPI tools (cache, search, environment registry) + two cache-first skills (`notion-context` for context / Korean specs, `openapi-client` for `fetch`/`axios` snippets) + one work-partner agent (`rocky`, naming convention borrowed from [OmO](https://github.com/code-yeongyu/oh-my-openagent)'s named-specialist pattern) acting as the toolkit's primary conductor and able to delegate to external sub-agents / skills when the work exceeds the toolkit. OpenAPI specs can be addressed by URL or by `host:env:spec` handles declared in `agent-toolkit.json` (project > user precedence). **Runtime is Bun (>=1.0). No Node. No build step (Bun runs TS directly).** Layout follows the [obra/superpowers](https://github.com/obra/superpowers) shape.

## Layout

- `.opencode/plugins/agent-toolkit.ts` — plugin entrypoint. `config` hook registers `skills/` and `agents/`, and exposes eight tools: `notion_get` / `notion_refresh` / `notion_status` plus `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` / `swagger_envs`.
- `lib/notion-context.ts` — single-file TTL filesystem cache for Notion pages + `resolveCacheKey` + `notionToMarkdown`.
- `lib/openapi-context.ts` — single-file TTL filesystem cache for OpenAPI / Swagger JSON specs + `resolveSpecKey` + `searchEndpoints` + shape validation.
- `lib/openapi-registry.ts` — `host:env:spec` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/toolkit-config.ts` — `agent-toolkit.json` loader (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`) with runtime shape validation.
- `agent-toolkit.schema.json` — JSON Schema for `agent-toolkit.json` (IDE autocomplete; runtime validation lives in `toolkit-config.ts`).
- `skills/notion-context/SKILL.md` — Notion cache-first read + Korean-language spec extraction skill.
- `skills/openapi-client/SKILL.md` — cached OpenAPI spec → `fetch` or `axios` call snippet skill.
- `agents/rocky.md` — work-partner agent (`mode: all`) that conducts the toolkit's `notion-context` + `openapi-client` flows for users and other primary agents (e.g. OmO Sisyphus), and may delegate to external sub-agents / skills when a task exceeds the toolkit. Frontend specialty, fullstack range.
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

**In**: single-page Notion read + cache + expiry, single OpenAPI / Swagger JSON spec cache + cross-spec endpoint search + `host:env:spec` registry (`agent-toolkit.json`, project > user precedence), two skills (`notion-context`, `openapi-client`), one work-partner agent (`rocky`) that conducts both skills as its primary contract and may delegate to external sub-agents / skills when the task exceeds the toolkit, opencode-only.

**Out**: database queries, OAuth, Notion child pages, OpenAPI YAML parsing, runtime base-URL override (use `spec.servers`), full SDK code generation, multi-spec merge, mock servers, multi-host plugin layouts (`.claude-plugin/`, etc.), UI, codex integration, **direct multi-step implementation by Rocky** (writing code, refactor, multi-file changes — Rocky may delegate these to a sub-agent / skill, or return them to the caller, but never runs them itself). Anything beyond this scope ships as a separate PR proposal.

The longer-term capability targets (auto memory, GitHub-issue tracking, OpenAPI client generation, …) live in [`ROADMAP.md`](./ROADMAP.md) — phase-by-phase, one PR at a time. Do not pull roadmap items into MVP unless the user explicitly asks.

## Change checklist

1. `bun run typecheck` passes
2. `bun test` passes
3. If the user-facing surface (tools / env vars) changes, sync `README.md` and `.opencode/INSTALL.md`
4. If a new env var is added, also update the plugin's `readEnv()`
5. If the plugin's tool contract changes, update the tool-usage rules in the relevant skill (`skills/notion-context/SKILL.md` for `notion_*`, `skills/openapi-client/SKILL.md` for `swagger_*`) **and** the corresponding routing / tool rules in `agents/rocky.md` (Rocky conducts both skills, so changes on either side propagate to it)
6. If `agent-toolkit.json` shape changes, update **both** `agent-toolkit.schema.json` (IDE autocomplete) **and** `lib/toolkit-config.ts` (runtime validation) — they must stay in lockstep

## MCP servers

`.mcp.json` registers [`context7`](https://github.com/upstash/context7) at project scope. Use it to pull up-to-date documentation for external libraries (Bun, TypeScript, the opencode plugin API, etc.).

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
