# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

> **Single sources of truth.** Humans read [`FEATURES.md`](./FEATURES.md) (Korean — tools / config / Quick start). Agents read this file (English — Layout / MVP scope / coding rules / change checklist). [`README.md`](./README.md) is a one-page entry that links to both.

## Project in one line

**Bun-workspaces monorepo** with one OpenAPI core (`@minjun0219/openapi-core`) shared by three distribution targets — `openapi-mcp` (standalone stdio CLI, npm), `@minjun0219/agent-toolkit-claude-code` (Claude Code plugin, marketplace), `@minjun0219/agent-toolkit-opencode` (opencode plugin, git URL / npm). All three expose the **same 7-tool surface** (`openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs` / `openapi_endpoint` / `openapi_tags`).

Previous toolkit surfaces (journal / mysql / notion / spec-pact / pr-watch + rocky / grace / mindy agents + 5 skills) live on [`archive/pre-openapi-only-slim`](https://github.com/minjun0219/agent-toolkit/tree/archive/pre-openapi-only-slim) and re-enter in follow-up PRs via three possible shapes (plugin-bound / per-domain subset MCP / `packages/agent-toolkit-mcp/` umbrella MCP). The shape is decided per domain at re-introduction time — the 4-package monorepo accommodates all three.

## Layout

```
agent-toolkit/                               workspace root, private: true
├── package.json                              { workspaces: ["packages/*"] }
├── tsconfig.base.json                        공통 컴파일러 옵션 (각 패키지가 extends)
├── tsconfig.json                             aggregate include (`packages/*/src/**/*.ts`)
├── biome.json                                전 패키지 lint / format
├── agent-toolkit.schema.json                 `agent-toolkit.json` JSON Schema (IDE autocomplete)
├── .mcp.json                                 dev-time Claude Code trust (`agent-toolkit-claude-code/src/index.ts`)
├── README.md / FEATURES.md / AGENTS.md / ROADMAP.md / REVIEW.md / LICENSE
├── docs/openapi-mcp.md                       standalone CLI 보조 문서
└── packages/
    ├── openapi-core/                         @minjun0219/openapi-core (workspace-internal)
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── adapter.ts                    `agent-toolkit.json` registry → SpecRegistry + 핸들 평탄화
    │       ├── cache.ts                      sha1-keyed disk cache (`schemaVersion: 1`, TTL, conditional GET)
    │       ├── config-loader.ts              standalone `openapi-mcp.json` 로더 (XDG, YAML/JSON)
    │       ├── fetcher.ts                    Bun `fetch` 기반 HTTP + conditional GET + TLS opt
    │       ├── filter.ts                     점수화 검색 (operationId>path>summary>description)
    │       ├── handlers.ts                   ★ 7 plugin handler 공유 (`handleSwagger*`)
    │       ├── indexer.ts                    IndexedSpec / EndpointDetail / TagSummary
    │       ├── logger.ts                     pino → stderr only
    │       ├── openapi-registry.ts           host:env:spec 핸들 / 스코프 / 평탄화
    │       ├── parser.ts                     yaml + swagger2→3 + `$ref` deref (swagger-parser)
    │       ├── registry.ts                   메모리 + 디스크 registry + TTL + 백그라운드 revalidate
    │       ├── schema.ts                     `openapi-mcp.json` zod schema
    │       ├── toolkit-config.ts             `agent-toolkit.json` 로더 (project > user, openapi-only)
    │       ├── url.ts                        URL join / synthetic operationId
    │       ├── __fixtures__/                 petstore 2.0 / 3.0 (JSON + YAML)
    │       └── *.test.ts                     unit tests + handlers.test.ts
    │
    ├── openapi-mcp/                          openapi-mcp (npm publish)
    │   ├── package.json                      { bin: { "openapi-mcp": "./bin/openapi-mcp" } }
    │   ├── tsconfig.json
    │   ├── bin/openapi-mcp                   `#!/usr/bin/env bun` shebang, arg parsing
    │   └── src/index.ts                      standalone stdio MCP — 7 tool 등록 + `SpecRegistry`
    │
    ├── agent-toolkit-claude-code/            @minjun0219/agent-toolkit-claude-code (marketplace)
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── .claude-plugin/plugin.json        marketplace metadata
    │   ├── .mcp.json                         plugin install 후 Claude Code 가 읽음
    │   └── src/
    │       ├── index.ts                      thin MCP wrapper (등록만, handler 호출은 openapi-core)
    │       └── index.test.ts                 in-memory MCP smoke (7 tool, 누수 가드)
    │
    └── agent-toolkit-opencode/               @minjun0219/agent-toolkit-opencode (git URL / npm)
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts                      re-export shim (`./plugin` default 그대로)
            ├── plugin.ts                     thin opencode plugin (등록만, handler 호출은 openapi-core)
            ├── plugin.test.ts                plugin shape smoke (7 tool, 누수 가드, skill/agent 부재)
            └── install.test.ts               main / exports / spawn `bun` 으로 import 검증
```

## MVP scope (hold the line)

**In**: OpenAPI / Swagger spec 캐시 + endpoint search + tag list + cross-spec scoped search + `host:env:spec` registry (`agent-toolkit.json`, project > user precedence), 단일 7-tool surface 를 3 host (standalone CLI + Claude Code plugin + opencode plugin) 에 공유, Bun workspaces monorepo 로 host 별 `package.json` 분리. 모든 handler 는 `@minjun0219/openapi-core/handlers` 한 곳에 정의 — host 간 drift 방지.

**Out**: journal / mysql / notion / spec-pact / pr-watch / agents / skills (전부 archive 브랜치 박제), 도메인 재추가 (별도 PR), npm publish 자동화 (별도 PR — changeset 도입 시점에), repo rename (보류 — `agent-toolkit` 정체성 유지). OpenAPI YAML stream parsing, full SDK code generation, multi-spec merge, mock servers, UI 도 모두 out.

## Reintroduction strategy (archive → main)

Re-adding a domain (journal / mysql / notion / spec-pact / pr-watch) is **always a separate PR** that follows this template:

1. **Decision**: 도메인을 (a) 두 plugin 에 직접 합류 (b) `packages/<domain>-mcp/` 단독 subset MCP (c) `packages/agent-toolkit-mcp/` umbrella MCP 셋 중 하나로 정한다. 결정 기록은 PR description 에 한 줄.
2. **Port from archive**: `git checkout archive/pre-openapi-only-slim -- <files>` 로 lib / skill / agent 가져온다. 이전 `lib/<domain>.ts` 는 새 패키지 (`packages/<domain>-core/src/<domain>.ts` 형태) 로 옮긴다.
3. **Shared handler 자리**: 도메인이 두 plugin 에 모두 합류한다면 `packages/<domain>-core/src/handlers.ts` 에 둔다 (openapi-core 와 동일 패턴). 단독 subset MCP 만 만든다면 그 패키지 내부에 둔다.
4. **Config shape**: `agent-toolkit.json` 에 도메인 키를 다시 넣는다면 `packages/openapi-core/src/toolkit-config.ts` 의 `ToolkitConfig` 와 `agent-toolkit.schema.json` 을 lockstep 으로 갱신.
5. **두 plugin 의 surface**: 도메인이 plugin 에 합류하면 `agent-toolkit-claude-code/src/index.ts` 와 `agent-toolkit-opencode/src/plugin.ts` 두 곳에서 도구를 등록한다 — 누수 회귀 가드 (`REMOVED_TOOLS` 배열) 도 함께 갱신.
6. **Docs**: `FEATURES.md` 의 tool 표 / config 표 갱신. `README.md` 의 surface 카운트 갱신. `AGENTS.md` (이 파일) 의 Layout / *Project in one line* 갱신.

## Common commands

```bash
bun install         # workspaces 의존성 + node_modules symlink
bun run check       # Biome verify (no write)
bun run fix         # Biome safe fix + format
bun run lint        # Biome lint only
bun run lint:fix    # Biome lint write
bun run format      # Biome format only
bun run typecheck   # tsc --noEmit aggregate (all packages)
bun test            # 모든 packages/*/src/*.test.ts
```

## Coding rules

- **Language**: TypeScript (`type: module`). Bun runs `.ts` directly — no build, no `dist/`.
- **Imports**: do not append `.js` / `.ts` extensions (`moduleResolution: Bundler` + `allowImportingTsExtensions`). Cross-package imports use the workspace name (`@minjun0219/openapi-core` 또는 subpath `@minjun0219/openapi-core/handlers`). Same-package imports use relative paths.
- **ESM safety**: never use `__dirname`. Use `import.meta.url` + `fileURLToPath`, or Bun's `import.meta.dir`.
- **Repo-local JSDoc**: write JSDoc on exported functions / classes when touching this repository, but do not treat it as a custom hard-lint gate. Korean comments are fine for tricky logic.
- **Errors**: include context in messages (input value, timeout, status code, handle mismatch, …).
- **Dependencies**: avoid adding any if possible. Prefer the standard library and Bun built-ins. **Explicit prod-dep exceptions:** `@modelcontextprotocol/sdk` + `zod` (MCP wire protocol + blessed schema dialect), `@apidevtools/swagger-parser` + `swagger2openapi` + `js-yaml` + `openapi-types` + `pino` (OpenAPI parsing / conversion / structured stderr logging), `@opencode-ai/plugin` (opencode plugin API). HTTP transport는 Bun의 native `fetch` (with `tls` option) 직접 사용. Dev-only tooling (linters / formatters) 는 OK. New runtime deps 는 별도 scope 논의.
- **Tests**: keep `*.test.ts` next to the source and run with `bun test`. Isolate fs-dependent tests with `mkdtempSync`. 핸들러 동작 자체는 `packages/openapi-core/src/handlers.test.ts` 에서 검증, 두 plugin 의 `*.test.ts` 는 surface (tool 개수 / 누수 회귀) 만 검증.

## Runtime project comment guidance

When this toolkit is used against a runtime / downstream project, JSDoc and Korean comments are **agent guidance**, not a lint contract.

- Add JSDoc for important public / shared methods, code with domain rules or edge cases, contracts that another agent / caller must understand, or when the user / reviewer explicitly asks for explanation.
- Skip JSDoc for private helpers, obvious one-file glue code, local callbacks, and test fixtures when names and types already explain the behavior.
- Prefer Korean for explanatory prose comments. Keep code identifiers, file paths, commands, URLs, API paths, and library / framework names in their original English form.
- Never generate a runtime project lint config solely to enforce JSDoc or Korean-comment policy unless the user explicitly asks for that project's lint setup.

## Change checklist

1. `bun run check` passes
2. `bun run typecheck` passes
3. `bun test` passes
4. If the user-facing surface (tools / env vars / handles) changes, sync the **two single sources** — `FEATURES.md` (Korean, humans) and `AGENTS.md` (English, agents — this file's *Project in one line* + *Layout*) — and the entry pages: `README.md` always, package-level READMEs (`packages/openapi-mcp/README.md`, `packages/agent-toolkit-claude-code/README.md`, `packages/agent-toolkit-opencode/INSTALL.md`) only when that host's surface changes, `packages/agent-toolkit-claude-code/.claude-plugin/plugin.json` only when the Claude Code surface changes.
5. If a new env var is added, update the env-reading site that consumes it (`packages/openapi-core/src/cache.ts` / `config-loader.ts` / `toolkit-config.ts`). Update the `FEATURES.md` env-var table on every addition.
6. If a plugin tool contract changes, update **both** `packages/agent-toolkit-claude-code/src/index.ts` and `packages/agent-toolkit-opencode/src/plugin.ts` (registrations), and the shared handler in `packages/openapi-core/src/handlers.ts` (implementation).
7. If `agent-toolkit.json` shape changes, update **both** `agent-toolkit.schema.json` (IDE autocomplete) **and** `packages/openapi-core/src/toolkit-config.ts` (runtime validation) — they must stay in lockstep.
8. If a removed-domain tool name needs to surface again, update the `REMOVED_TOOLS` arrays in `packages/agent-toolkit-claude-code/src/index.test.ts` and `packages/agent-toolkit-opencode/src/plugin.test.ts` — both currently guard against journal / mysql / notion / spec-pact / pr-watch leakage.

## MCP servers

`.mcp.json` at repo root registers two MCP servers for dev-time use of Claude Code against this repo. Approve both on first trust prompt:

- [`context7`](https://github.com/upstash/context7) — up-to-date documentation for external libraries.
- `agent-toolkit` — `bun run packages/agent-toolkit-claude-code/src/index.ts`. Exposes the 7-tool plugin surface.

End users install the plugin via marketplace (Claude Code) or git URL / npm (opencode); they do not use the repo-root `.mcp.json`.

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
- Write code review outputs (summary / inline / suggestions) in Korean by default.
- When requesting a PR review, explicitly ask for Korean review comments (`모든 리뷰 코멘트는 한국어로 작성해 주세요.`).
- PR titles must follow Conventional Commits style (`type(scope): Korean summary` or `type: Korean summary`).
- PR title / body and user-facing change descriptions should also be written in Korean.
- **Single sources**: humans = `FEATURES.md` (Korean), agents = this `AGENTS.md` (English). Do not introduce a new sibling doc — fold new content into one of the two.
