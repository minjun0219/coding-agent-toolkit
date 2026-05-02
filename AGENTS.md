# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

## Project in one line

opencode-only plugin. Three Notion cache tools + five OpenAPI tools (cache, search, environment registry) + four append-only journal tools (turn-spanning agent memory) + five MySQL read-only tools (envs / status / tables / schema / query) + three cache-first skills (`notion-context` for context / Korean specs, `openapi-client` for `fetch`/`axios` snippets, `mysql-query` for read-only schema / table / SELECT inspection) + one SPEC-합의 lifecycle skill (`spec-pact`, four modes: DRAFT / VERIFY / DRIFT-CHECK / AMEND on top of an LLM-wiki-inspired INDEX) + one work-partner primary agent (`rocky`, naming convention borrowed from [OmO](https://github.com/code-yeongyu/oh-my-openagent)'s named-specialist pattern) acting as the toolkit's primary conductor + one sub-agent (`grace`, Project Hail Mary 의 Ryland Grace) owning the SPEC-합의 lifecycle, both able to delegate to external sub-agents / skills when the work exceeds the toolkit. OpenAPI specs and MySQL connections can be addressed by URL / fields or by `host:env:spec` / `host:env:db` handles declared in `agent-toolkit.json` (project > user precedence); SPEC files live under `.agent/specs/<slug>.md` (default) or `**/SPEC.md` (directory-scoped, AGENTS.md 스타일), discovered through `.agent/specs/INDEX.md`. **Runtime is Bun (>=1.0). No Node. No build step (Bun runs TS directly).** Layout follows the [obra/superpowers](https://github.com/obra/superpowers) shape.

## Layout

- `.opencode/plugins/agent-toolkit.ts` — plugin entrypoint. `config` hook registers `skills/` and `agents/`, and exposes seventeen tools: `notion_get` / `notion_refresh` / `notion_status` + `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` / `swagger_envs` + `journal_append` / `journal_read` / `journal_search` / `journal_status` + `mysql_envs` / `mysql_status` / `mysql_tables` / `mysql_schema` / `mysql_query`.
- `lib/notion-context.ts` — single-file TTL filesystem cache for Notion pages + `resolveCacheKey` + `notionToMarkdown`.
- `lib/openapi-context.ts` — single-file TTL filesystem cache for OpenAPI / Swagger JSON specs + `resolveSpecKey` + `searchEndpoints` + shape validation.
- `lib/openapi-registry.ts` — `host:env:spec` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/toolkit-config.ts` — `agent-toolkit.json` loader (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`) with runtime shape validation.
- `lib/agent-journal.ts` — append-only JSONL agent journal (decisions / blockers / answers / notes). No TTL; corruption-tolerant on read.
- `lib/mysql-readonly.ts` — SQL guards: comment-stripping `assertReadOnlySql` (allow-list of `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH` + deny-list for write/DDL/multi-statement) + `enforceLimit` (auto / cap row limit on row-returning statements). No DB connection.
- `lib/mysql-registry.ts` — `host:env:db` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/mysql-context.ts` — MySQL connection factory (`mysql2/promise` pool, `multipleStatements: false`, fixed connect / query timeouts) + `MysqlExecutor` interface (fakeable in tests) + `pingHandle` / `listTables` / `describeTable` / `runReadonlyQuery`. Single prod dep (`mysql2`) — DB clients are too heavy to hand-roll.
- `agent-toolkit.schema.json` — JSON Schema for `agent-toolkit.json` (IDE autocomplete; runtime validation lives in `toolkit-config.ts`).
- `skills/notion-context/SKILL.md` — Notion cache-first read + Korean-language spec extraction skill.
- `skills/openapi-client/SKILL.md` — cached OpenAPI spec → `fetch` or `axios` call snippet skill.
- `skills/mysql-query/SKILL.md` — read-only MySQL inspection skill (envs → status → tables → schema → query). No write / DDL / multi-statement, ever.
- `skills/spec-pact/SKILL.md` — SPEC-합의 lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of an LLM-wiki-inspired entry point at `<spec.dir>/<spec.indexFile>` (default `.agent/specs/INDEX.md`) and per-page SPEC files at `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`, slug 모드) or `**/SPEC.md` (directory 모드). Conducted exclusively by `agents/grace.md`.
- `agents/rocky.md` — work-partner primary agent (`mode: all`) that conducts the toolkit's `notion-context` + `openapi-client` + `mysql-query` flows and the journal for users (and for any external primary agent that happens to share the environment, e.g. OmO Sisyphus or Superpowers — synergy when present, not a dependency), routes the SPEC-합의 lifecycle to `@grace`, and may delegate to external sub-agents / skills when a task exceeds the toolkit. Frontend specialty, fullstack range.
- `agents/grace.md` — SPEC-합의 sub-agent (`mode: subagent`) that conducts the `spec-pact` skill end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` and SPEC files. Invoked directly (`@grace`) or via Rocky's routing rule.
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
- **Repo-local JSDoc**: write JSDoc on exported functions / classes when touching this repository, but do not treat it as a custom hard-lint gate. Korean comments are fine for tricky logic.
- **Errors**: include context in messages (input value, timeout, status code, pageId mismatch, …).
- **Dependencies**: avoid adding any if possible. Prefer the standard library and Bun built-ins. **Single explicit exception: `mysql2`** (prod dep) — MySQL has no native Bun client and the wire protocol / TLS / auth-plugin handling is too large to hand-roll for a "read-only inspection" surface. New deps beyond this require a separate scope discussion.
- **Tests**: keep `*.test.ts` next to the source and run with `bun test`. Isolate fs-dependent tests with `mkdtempSync`.

## MVP scope (hold the line)

**In**: single-page Notion read + cache + expiry, single OpenAPI / Swagger JSON spec cache + cross-spec endpoint search + `host:env:spec` registry (`agent-toolkit.json`, project > user precedence), append-only agent journal (turn-spanning memory: decisions / blockers / answers / notes — disk only, no TTL, time / page-key / kind / tag-shaped lookup + substring search), **MySQL read-only inspection** (`mysql-query` skill + five `mysql_*` tools, `host:env:db` handles in `agent-toolkit.json` with `passwordEnv` 또는 `dsnEnv` only — config 파일 평문 비밀번호 금지, allow-list of `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`, deny-list for write/DDL/`SET`/`CALL`/`LOAD`/`INTO OUTFILE` and multi-statement, automatic / capped `LIMIT` on row-returning queries, single sub-agent split deferred — the skill is conducted directly by `rocky` for now), SPEC 합의 lifecycle (`spec-pact` skill, four modes — DRAFT / VERIFY / DRIFT-CHECK / AMEND — on top of an LLM-wiki-inspired INDEX at `.agent/specs/INDEX.md` and per-page SPEC files at `.agent/specs/<slug>.md` slug 모드 또는 `**/SPEC.md` directory 모드; four new reserved journal kinds — `spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result` — plus the existing `note` kind reused for the DRIFT-CHECK clean case under the `spec-pact` / `drift-clear` tags, so lifecycle history is recovered through the tag-shaped query `journal_search "spec-pact"` rather than a kind-only filter), four skills (`notion-context`, `openapi-client`, `mysql-query`, `spec-pact`), one work-partner primary agent (`rocky`) that conducts the three cache-first skills (Notion / OpenAPI / MySQL) + journal and routes the SPEC lifecycle to the `grace` sub-agent, one sub-agent (`grace`) that owns the SPEC lifecycle as its sole contract, both able to delegate to external sub-agents / skills when the task exceeds the toolkit, opencode-only.

**Out**: **Notion database queries** (Notion DB 객체 / child pages — single-page only), **MySQL writes / DDL / multi-statement / stored-procedure calls / `SET` / `LOAD` / `INTO OUTFILE` / `INTO DUMPFILE`**, MySQL TLS / SSH tunnel options, OS keychain integration, other DBMSs (Postgres / SQLite / Oracle / MSSQL), MySQL result disk caching, OAuth, OpenAPI YAML parsing, runtime base-URL override (use `spec.servers`), full SDK code generation, multi-spec merge, mock servers, multi-host plugin layouts (`.claude-plugin/`, etc.), UI, codex integration, **direct multi-step implementation by Rocky / Grace** (writing code, refactor, multi-file changes — both may delegate these to a sub-agent / skill, or return them to the caller, but never run them itself), cross-machine journal sync, embedding / natural-language journal search, journal compaction or summarization, **automatic drift polling** (`spec-pact` DRIFT-CHECK is explicit only), **automatic INDEX commit / push**, cross-machine SPEC sync, embedding-based SPEC search. Anything beyond this scope ships as a separate PR proposal.

The longer-term capability targets (auto memory, GitHub-issue tracking, OpenAPI client generation, …) live in [`ROADMAP.md`](./ROADMAP.md) — phase-by-phase, one PR at a time. Do not pull roadmap items into MVP unless the user explicitly asks.

## Runtime project comment guidance

When this toolkit is used against a runtime / downstream project, JSDoc and Korean comments are **agent guidance**, not a lint contract.

- Add JSDoc for important public / shared methods, code with domain rules or edge cases, contracts that another agent / caller must understand, or when the user / reviewer explicitly asks for explanation.
- Skip JSDoc for private helpers, obvious one-file glue code, local callbacks, and test fixtures when names and types already explain the behavior.
- Prefer Korean for explanatory prose comments. Keep code identifiers, file paths, commands, URLs, API paths, and library / framework names in their original English form.
- Never generate a runtime project lint config solely to enforce JSDoc or Korean-comment policy unless the user explicitly asks for that project's lint setup.

## Change checklist

1. `bun run typecheck` passes
2. `bun test` passes
3. If the user-facing surface (tools / env vars) changes, sync `README.md` and `.opencode/INSTALL.md`
4. If a new env var is added, also update the plugin's `readEnv()`
5. If the plugin's tool contract changes, update the tool-usage rules in the relevant skill (`skills/notion-context/SKILL.md` for `notion_*`, `skills/openapi-client/SKILL.md` for `swagger_*`, `skills/mysql-query/SKILL.md` for `mysql_*`, `skills/spec-pact/SKILL.md` for the lifecycle modes that touch `notion_*` / `journal_*` / file IO) **and** the corresponding routing / tool rules in `agents/rocky.md` (Rocky conducts the three cache-first skills + journal and routes the lifecycle, so changes on either side propagate to it; `journal_*` is owned by `rocky` directly — no separate skill) **and** `agents/grace.md` (Grace conducts `spec-pact` end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` + SPEC files)
6. If `agent-toolkit.json` shape changes, update **both** `agent-toolkit.schema.json` (IDE autocomplete) **and** `lib/toolkit-config.ts` (runtime validation) — they must stay in lockstep. Currently the `openapi.registry`, the `spec` (dir / scanDirectorySpec / indexFile), and the `mysql.connections` (host / env / db → host / port / user / database / passwordEnv / dsnEnv) objects are the three top-level keys with explicit validation

## MCP servers

`.mcp.json` registers [`context7`](https://github.com/upstash/context7) at project scope. Use it to pull up-to-date documentation for external libraries (Bun, TypeScript, the opencode plugin API, etc.).

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
- Write code review outputs (summary/inline/suggestions) in Korean by default.
- When requesting a PR review, explicitly ask for Korean review comments (e.g. `모든 리뷰 코멘트는 한국어로 작성해 주세요.`).
- PR titles must follow Conventional Commits style (`type(scope): Korean summary` or `type: Korean summary`; e.g. `docs: runtime 주석 guidance 정리`).
- PR title/body and user-facing change descriptions should also be written in Korean.
