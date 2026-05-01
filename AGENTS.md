# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

## Project in one line

opencode-only plugin. Three Notion cache tools + five OpenAPI tools (cache, search, environment registry) + four append-only journal tools (turn-spanning agent memory) + two cache-first skills (`notion-context` for context / Korean specs, `openapi-client` for `fetch`/`axios` snippets) + one SPEC-합의 lifecycle skill (`spec-pact`, four modes: DRAFT / VERIFY / DRIFT-CHECK / AMEND on top of an LLM-wiki-inspired INDEX) + one work-partner primary agent (`rocky`, naming convention borrowed from [OmO](https://github.com/code-yeongyu/oh-my-openagent)'s named-specialist pattern) acting as the toolkit's primary conductor + one sub-agent (`grace`, Project Hail Mary 의 Ryland Grace) owning the SPEC-합의 lifecycle, both able to delegate to external sub-agents / skills when the work exceeds the toolkit. OpenAPI specs can be addressed by URL or by `host:env:spec` handles declared in `agent-toolkit.json` (project > user precedence); SPEC files live under `.agent/specs/<slug>.md` (default) or `**/SPEC.md` (directory-scoped, AGENTS.md 스타일), discovered through `.agent/specs/INDEX.md`. **Runtime is Bun (>=1.0). No Node. No build step (Bun runs TS directly).** Layout follows the [obra/superpowers](https://github.com/obra/superpowers) shape.

## Layout

- `.opencode/plugins/agent-toolkit.ts` — plugin entrypoint. `config` hook registers `skills/` and `agents/`, and exposes twelve tools: `notion_get` / `notion_refresh` / `notion_status` + `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` / `swagger_envs` + `journal_append` / `journal_read` / `journal_search` / `journal_status`.
- `lib/notion-context.ts` — single-file TTL filesystem cache for Notion pages + `resolveCacheKey` + `notionToMarkdown`.
- `lib/openapi-context.ts` — single-file TTL filesystem cache for OpenAPI / Swagger JSON specs + `resolveSpecKey` + `searchEndpoints` + shape validation.
- `lib/openapi-registry.ts` — `host:env:spec` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/toolkit-config.ts` — `agent-toolkit.json` loader (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`) with runtime shape validation.
- `lib/agent-journal.ts` — append-only JSONL agent journal (decisions / blockers / answers / notes). No TTL; corruption-tolerant on read.
- `agent-toolkit.schema.json` — JSON Schema for `agent-toolkit.json` (IDE autocomplete; runtime validation lives in `toolkit-config.ts`).
- `lib/check-comments.ts` — JSDoc 누락 / 한글 주석 부재를 잡아내는 lint-단 검증기 (단위 테스트는 `check-comments.test.ts`, 통합 테스트는 `check-comments.integration.test.ts` 가 repo 전체를 훑는다).
- `tools/check-comments.ts` — `bun run lint:comments` 진입점. `lib/check-comments.ts` 의 `checkSource` 를 `lib/`, `.opencode/plugins/`, `tools/` 의 모든 `*.ts` 에 적용하고 위반 시 exit 1.
- `skills/notion-context/SKILL.md` — Notion cache-first read + Korean-language spec extraction skill.
- `skills/openapi-client/SKILL.md` — cached OpenAPI spec → `fetch` or `axios` call snippet skill.
- `skills/spec-pact/SKILL.md` — SPEC-합의 lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of an LLM-wiki-inspired entry point at `<spec.dir>/<spec.indexFile>` (default `.agent/specs/INDEX.md`) and per-page SPEC files at `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`, slug 모드) or `**/SPEC.md` (directory 모드). Conducted exclusively by `agents/grace.md`.
- `agents/rocky.md` — work-partner primary agent (`mode: all`) that conducts the toolkit's `notion-context` + `openapi-client` flows and the journal for users (and for any external primary agent that happens to share the environment, e.g. OmO Sisyphus or Superpowers — synergy when present, not a dependency), routes the SPEC-합의 lifecycle to `@grace`, and may delegate to external sub-agents / skills when a task exceeds the toolkit. Frontend specialty, fullstack range.
- `agents/grace.md` — SPEC-합의 sub-agent (`mode: subagent`) that conducts the `spec-pact` skill end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` and SPEC files. Invoked directly (`@grace`) or via Rocky's routing rule.
- `.opencode/INSTALL.md` — install guide for opencode users.

## Common commands

```bash
bun install
bun test                # unit tests under lib/ + .opencode/plugins/
bun run typecheck       # tsc --noEmit
bun run lint:comments   # JSDoc + 한글 주석 정책 검증 (tools/check-comments.ts)
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

**In**: single-page Notion read + cache + expiry, single OpenAPI / Swagger JSON spec cache + cross-spec endpoint search + `host:env:spec` registry (`agent-toolkit.json`, project > user precedence), append-only agent journal (turn-spanning memory: decisions / blockers / answers / notes — disk only, no TTL, time / page-key / kind / tag-shaped lookup + substring search), SPEC 합의 lifecycle (`spec-pact` skill, four modes — DRAFT / VERIFY / DRIFT-CHECK / AMEND — on top of an LLM-wiki-inspired INDEX at `.agent/specs/INDEX.md` and per-page SPEC files at `.agent/specs/<slug>.md` slug 모드 또는 `**/SPEC.md` directory 모드; four new reserved journal kinds — `spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result` — plus the existing `note` kind reused for the DRIFT-CHECK clean case under the `spec-pact` / `drift-clear` tags, so lifecycle history is recovered through the tag-shaped query `journal_search "spec-pact"` rather than a kind-only filter), three skills (`notion-context`, `openapi-client`, `spec-pact`), one work-partner primary agent (`rocky`) that conducts the two cache-first skills + journal and routes the SPEC lifecycle to the `grace` sub-agent, one sub-agent (`grace`) that owns the SPEC lifecycle as its sole contract, both able to delegate to external sub-agents / skills when the task exceeds the toolkit, opencode-only.

**Out**: database queries, OAuth, Notion child pages, OpenAPI YAML parsing, runtime base-URL override (use `spec.servers`), full SDK code generation, multi-spec merge, mock servers, multi-host plugin layouts (`.claude-plugin/`, etc.), UI, codex integration, **direct multi-step implementation by Rocky / Grace** (writing code, refactor, multi-file changes — both may delegate these to a sub-agent / skill, or return them to the caller, but never run them itself), cross-machine journal sync, embedding / natural-language journal search, journal compaction or summarization, **automatic drift polling** (`spec-pact` DRIFT-CHECK is explicit only), **automatic INDEX commit / push**, cross-machine SPEC sync, embedding-based SPEC search. Anything beyond this scope ships as a separate PR proposal.

The longer-term capability targets (auto memory, GitHub-issue tracking, OpenAPI client generation, …) live in [`ROADMAP.md`](./ROADMAP.md) — phase-by-phase, one PR at a time. Do not pull roadmap items into MVP unless the user explicitly asks.

## Change checklist

1. `bun run typecheck` passes
2. `bun test` passes (통합 테스트 `lib/check-comments.integration.test.ts` 가 한글 주석 / JSDoc 정책을 자동으로 검증한다 — 별도로 `bun run lint:comments` 로도 호출 가능)
3. If the user-facing surface (tools / env vars) changes, sync `README.md` and `.opencode/INSTALL.md`
4. If a new env var is added, also update the plugin's `readEnv()`
5. If the plugin's tool contract changes, update the tool-usage rules in the relevant skill (`skills/notion-context/SKILL.md` for `notion_*`, `skills/openapi-client/SKILL.md` for `swagger_*`, `skills/spec-pact/SKILL.md` for the lifecycle modes that touch `notion_*` / `journal_*` / file IO) **and** the corresponding routing / tool rules in `agents/rocky.md` (Rocky conducts the two cache-first skills + journal and routes the lifecycle, so changes on either side propagate to it; `journal_*` is owned by `rocky` directly — no separate skill) **and** `agents/grace.md` (Grace conducts `spec-pact` end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` + SPEC files)
6. If `agent-toolkit.json` shape changes, update **both** `agent-toolkit.schema.json` (IDE autocomplete) **and** `lib/toolkit-config.ts` (runtime validation) — they must stay in lockstep. Currently the `openapi.registry` and the `spec` (dir / scanDirectorySpec / indexFile) objects are the two top-level keys with explicit validation

## MCP servers

`.mcp.json` registers [`context7`](https://github.com/upstash/context7) at project scope. Use it to pull up-to-date documentation for external libraries (Bun, TypeScript, the opencode plugin API, etc.).

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
- Write code review outputs (summary/inline/suggestions) in Korean by default.
- When requesting a PR review, explicitly ask for Korean review comments (e.g. `모든 리뷰 코멘트는 한국어로 작성해 주세요.`).
- PR title/body and user-facing change descriptions should also be written in Korean.
