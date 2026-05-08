# AGENTS.md

Shared guide for AI coding agents (Claude Code, opencode, codex, etc.) working in this repository.

> **Single sources of truth.** Humans read [`FEATURES.md`](./FEATURES.md) (Korean — tools / skills / agents / config / Quick start). Agents read this file (English — Layout / MVP scope / coding rules / change checklist). [`README.md`](./README.md) is a one-page entry that links to both.

## Project in one line

Dual-host MCP / plugin toolkit: **Claude Code is the primary host** (15-tool surface via `server/index.ts` registered through `.claude-plugin/plugin.json` + `.mcp.json`), **opencode is the secondary host** (28-tool surface via `.opencode/plugins/agent-toolkit-server.ts`). Both hosts share the same `skills/` and `agents/` trees.

- **Claude Code surface (15 tools, primary)**: `openapi_*` (5) + `journal_*` (4) + `mysql_*` (5) + `spec_pact_fragment` (1).
- **opencode-only (10 tools, removal candidates)**: `notion_*` (4) + `pr_*` (6). Tracked under *MVP scope → Removal candidates* below.
- **Skills (5)**: `notion-context`, `openapi-client`, `mysql-query`, `spec-pact`, `pr-review-watch`.
- **Agents (3)**: `rocky` (work-partner primary, frontend specialty / fullstack range — naming convention from [OmO](https://github.com/code-yeongyu/oh-my-openagent)) routes the SPEC lifecycle to `grace` (Project Hail Mary 의 Ryland Grace) and the PR review watch lifecycle to `mindy` (The Martian 의 Mindy Park). All three may delegate to external sub-agents / skills when work exceeds the toolkit.
- **Handles & config**: OpenAPI specs / MySQL connections addressable by URL / fields or by `host:env:spec` / `host:env:db` handles in `agent-toolkit.json` (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`). GitHub repositories declared as `owner/repo` keys under `github.repositories` (no tokens — PR-watch credentials live in the external GitHub MCP). SPEC files at `.agent/specs/<slug>.md` (default) or `**/SPEC.md` (directory-scoped), discovered through `.agent/specs/INDEX.md`.
- **Runtime is Bun (>=1.0). No Node. No build step (Bun runs TS directly).** Layout follows the [obra/superpowers](https://github.com/obra/superpowers) shape.

## Layout

- `server/index.ts` — **Claude Code MCP entrypoint** (primary). Stdio MCP server (`bun run server/index.ts`) registered by `.claude-plugin/plugin.json` + `.mcp.json`. Imports handlers from `.opencode/plugins/agent-toolkit.ts` (the opencode implementation file) and registers 15 tools: `openapi_*` (5) + `journal_*` (4) + `mysql_*` (5) + `spec_pact_fragment` (1). The other 10 tools (`notion_*` ×4, `pr_*` ×6) are intentionally omitted — see *MVP scope → Removal candidates*.
- `.opencode/plugins/agent-toolkit-server.ts` — **opencode plugin entrypoint** (secondary, `package.json` `main`). Thin re-export shim — `export default from "./agent-toolkit"`. Loads the actual plugin definition from the implementation file below.
- `.opencode/plugins/agent-toolkit.ts` — **opencode plugin implementation**. `config` hook registers `skills/` and `agents/`, and exposes all twenty-five tools: `notion_get` / `notion_refresh` / `notion_status` / `notion_extract` + `openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs` + `journal_append` / `journal_read` / `journal_search` / `journal_status` + `mysql_envs` / `mysql_status` / `mysql_tables` / `mysql_schema` / `mysql_query` + `pr_watch_start` / `pr_watch_stop` / `pr_watch_status` / `pr_event_record` / `pr_event_pending` / `pr_event_resolve` + `spec_pact_fragment`. Handler functions are exported (`handleSwagger*`, `handleNotion*`, …) so the Claude Code entrypoint can reuse them. The `handleSwagger*` legacy handler-name prefix is kept for git-history continuity; the public tool names are `openapi_*`.
- `lib/notion-context.ts` — single-file TTL filesystem cache for Notion pages + `resolveCacheKey` + `notionToMarkdown`.
- `lib/spec-pact-fragments.ts` — `SpecPactMode` enum + `assertSpecPactMode` + `loadSpecPactFragment(skillsDir, mode)`. Resolves the fragment file under `<skillsDir>/spec-pact/fragments/<mode>.md` against an absolute base — used by the `spec_pact_fragment` plugin tool so external installs work.
- `lib/openapi-context.ts` — single-file TTL filesystem cache for OpenAPI / Swagger JSON specs + `resolveSpecKey` + `searchEndpoints` + shape validation.
- `lib/openapi-registry.ts` — `host:env:spec` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/toolkit-config.ts` — `agent-toolkit.json` loader (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`) with runtime shape validation.
- `lib/agent-journal.ts` — append-only JSONL agent journal (decisions / blockers / answers / notes). No TTL; corruption-tolerant on read.
- `lib/mysql-readonly.ts` — SQL guards: comment-stripping `assertReadOnlySql` (allow-list of `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH` + deny-list for write/DDL/multi-statement) + `enforceLimit` (auto / cap row limit on row-returning statements). No DB connection.
- `lib/mysql-registry.ts` — `host:env:db` handle parsing, scope resolution, and registry flattening on top of the toolkit config.
- `lib/mysql-context.ts` — MySQL connection factory (`mysql2/promise` pool, `multipleStatements: false`, fixed connect / query timeouts) + `MysqlExecutor` interface (fakeable in tests) + `pingHandle` / `listTables` / `describeTable` / `runReadonlyQuery`. Single prod dep (`mysql2`) — DB clients are too heavy to hand-roll.
- `lib/pr-watch.ts` — PR review watch primitives. `parsePrHandle` / `normalizeEventRef` / `reduceActiveWatches` / `reducePendingEvents` / `selectByHandle` / `buildAppend` (= 4 종 reserved kind 의 `JournalAppendInput` 표준화). Reducer-only — no GitHub network, no token, no `agent-journal.ts` modification. PR handle 은 `pageId` 슬롯 대신 `tag: "pr:owner/repo#NUMBER"` 으로 박힌다.
- `agent-toolkit.schema.json` — JSON Schema for `agent-toolkit.json` (IDE autocomplete; runtime validation lives in `toolkit-config.ts`).
- `.claude-plugin/plugin.json` — Claude Code marketplace metadata for the primary host.
- `skills/notion-context/SKILL.md` — Notion cache-first read + Korean-language spec extraction skill.
- `skills/openapi-client/SKILL.md` — cached OpenAPI spec → `fetch` or `axios` call snippet skill.
- `skills/mysql-query/SKILL.md` — read-only MySQL inspection skill (envs → status → tables → schema → query). No write / DDL / multi-statement, ever.
- `skills/spec-pact/SKILL.md` — SPEC-합의 lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of an LLM-wiki-inspired entry point at `<spec.dir>/<spec.indexFile>` (default `.agent/specs/INDEX.md`) and per-page SPEC files at `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`, slug 모드) or `**/SPEC.md` (directory 모드). Conducted exclusively by `agents/grace.md`.
- `skills/pr-review-watch/SKILL.md` — PR review watch lifecycle (WATCH-START / PULL / VALIDATE / WATCH-STOP) on top of an existing GitHub PR. Polling-only — toolkit never calls the GitHub API itself for PR comments; PR meta / comments / replies / merge-state queries all go through an external GitHub MCP server. Conducted exclusively by `agents/mindy.md`.
- `agents/rocky.md` — work-partner primary agent (`mode: all`) that conducts the toolkit's `notion-context` + `openapi-client` + `mysql-query` flows and the journal for users (and for any external primary agent that happens to share the environment, e.g. OmO Sisyphus or Superpowers — synergy when present, not a dependency), routes the SPEC-합의 lifecycle to `@grace`, routes the PR review watch lifecycle to `@mindy`, and may delegate to external sub-agents / skills when a task exceeds the toolkit. Frontend specialty, fullstack range.
- `agents/grace.md` — SPEC-합의 sub-agent (`mode: subagent`) that conducts the `spec-pact` skill end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` and SPEC files. Invoked directly (`@grace`) or via Rocky's routing rule.
- `agents/mindy.md` — PR review watch sub-agent (`mode: subagent`, `permission.edit: deny`, `permission.bash: deny`) that conducts the `pr-review-watch` skill end-to-end and is the single finalize authority over `pr_event_resolved` journal entries. Invoked directly (`@mindy`) or via Rocky's routing rule. Never edits code, never runs tests / typecheck / lint, never creates / merges PRs — those return to the caller. External GitHub MCP must be registered in the opencode session for mindy to fetch PR meta / comments.
- `.opencode/INSTALL.md` — install guide for the secondary (opencode) host.
- `README.md` — one-page entry. Claude Code Quick start + opencode pointer + link to `FEATURES.md`.
- `FEATURES.md` — humans-facing single source of truth (Korean). Tools / skills / agents / config / Quick start / smoke.

## Common commands

```bash
bun install
bun run check     # verify Biome formatter / linter / import organizer without writing changes
bun run fix       # apply Biome safe fixes and formatting
bun run lint      # verify Biome lint rules without writing changes
bun run lint:fix  # apply Biome lint safe fixes
bun run format    # apply Biome formatting
bun test           # unit tests under lib/ + .opencode/plugins/ + server/
bun run typecheck  # tsc --noEmit
```

Only `AGENT_TOOLKIT_NOTION_MCP_URL` is required (and only when the `notion_*` tools are reachable — i.e. on opencode). See the `FEATURES.md` env-var table for the optional ones.

## Coding rules

- **Language**: TypeScript (`type: module`). Bun runs `.ts` directly — no build, no `dist/`.
- **Imports**: do not append `.js` / `.ts` extensions (`moduleResolution: Bundler` + `allowImportingTsExtensions`).
- **ESM safety**: never use `__dirname`. Use `import.meta.url` + `fileURLToPath`, or Bun's `import.meta.dir`.
- **Repo-local JSDoc**: write JSDoc on exported functions / classes when touching this repository, but do not treat it as a custom hard-lint gate. Korean comments are fine for tricky logic.
- **Errors**: include context in messages (input value, timeout, status code, pageId mismatch, …).
- **Dependencies**: avoid adding any if possible. Prefer the standard library and Bun built-ins. **Explicit prod-dep exceptions:** (1) `mysql2` — MySQL has no native Bun client and the wire protocol / TLS / auth-plugin handling is too large to hand-roll for a "read-only inspection" surface; (2) `@modelcontextprotocol/sdk` + `zod` — required by `server/index.ts` (Claude Code MCP entrypoint). The MCP wire protocol (JSON-RPC framing, capability negotiation, content-block shape) is too large to hand-roll for the Claude Code surface; zod ships as the SDK's blessed schema dialect. Dev-only tooling dependencies such as linters / formatters are allowed when explicitly agreed for repository workflow. New runtime deps beyond these require a separate scope discussion.
- **Tests**: keep `*.test.ts` next to the source and run with `bun test`. Isolate fs-dependent tests with `mkdtempSync`.

## MVP scope (hold the line)

**In**: single-page Notion read + cache + expiry, single OpenAPI / Swagger JSON spec cache + cross-spec endpoint search + `host:env:spec` registry (`agent-toolkit.json`, project > user precedence), append-only agent journal (turn-spanning memory: decisions / blockers / answers / notes — disk only, no TTL, time / page-key / kind / tag-shaped lookup + substring search), **MySQL read-only inspection** (`mysql-query` skill + five `mysql_*` tools, `host:env:db` handles in `agent-toolkit.json` with `passwordEnv` 또는 `dsnEnv` only — config 파일 평문 비밀번호 금지, allow-list of `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`, deny-list for write/DDL/`SET`/`CALL`/`LOAD`/`INTO OUTFILE` and multi-statement, automatic / capped `LIMIT` on row-returning queries, single sub-agent split deferred — the skill is conducted directly by `rocky` for now), SPEC 합의 lifecycle (`spec-pact` skill, four modes — DRAFT / VERIFY / DRIFT-CHECK / AMEND — on top of an LLM-wiki-inspired INDEX at `.agent/specs/INDEX.md` and per-page SPEC files at `.agent/specs/<slug>.md` slug 모드 또는 `**/SPEC.md` directory 모드; four reserved journal kinds — `spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result` — plus the existing `note` kind reused for the DRIFT-CHECK clean case under the `spec-pact` / `drift-clear` tags, so lifecycle history is recovered through the tag-shaped query `journal_search "spec-pact"` rather than a kind-only filter), **PR review watch** (`pr-review-watch` skill + six `pr_*` tools, polling-only — toolkit never calls the GitHub API itself for PR comments, that stays with the external GitHub MCP server; four-mode lifecycle WATCH-START / PULL / VALIDATE / WATCH-STOP; `mindy` sub-agent with `permission.edit: deny` + `permission.bash: deny`; PR handle = `owner/repo#NUMBER`, journal-side handle = tag `pr:<canonical>`; four reserved journal kinds — `pr_watch_start` / `pr_watch_stop` / `pr_event_inbound` / `pr_event_resolved`; lifecycle recovered with the tag-shaped query `journal_search "pr-watch"`; `agent-toolkit.json` 의 `github.repositories` 트리는 `owner/repo` 키 + `alias` / `labels` / `defaultBranch` / `mergeMode` 만 받고 토큰 / 비밀은 두지 않는다 — 외부 GitHub MCP 책임), five skills (`notion-context`, `openapi-client`, `mysql-query`, `spec-pact`, `pr-review-watch`), one work-partner primary agent (`rocky`) that conducts the cache-first skills (Notion / OpenAPI / MySQL) + journal and routes the SPEC lifecycle to the `grace` sub-agent and the PR review watch lifecycle to the `mindy` sub-agent, one SPEC sub-agent (`grace`) that owns the SPEC lifecycle as its sole contract, one PR review watch sub-agent (`mindy`) that owns the PR review watch lifecycle as its sole contract, all three able to delegate to external sub-agents / skills when the task exceeds the toolkit, dual-host (Claude Code primary, opencode secondary).

**Out**: **Notion database queries** (Notion DB 객체 / child pages — single-page only), **MySQL writes / DDL / multi-statement / stored-procedure calls / `SET` / `LOAD` / `INTO OUTFILE` / `INTO DUMPFILE`**, MySQL TLS / SSH tunnel options, OS keychain integration, other DBMSs (Postgres / SQLite / Oracle / MSSQL), MySQL result disk caching, OAuth, OpenAPI YAML parsing, runtime base-URL override (use `spec.servers`), full SDK code generation, multi-spec merge, mock servers, UI, codex integration, **direct multi-step implementation by Rocky / Grace / Mindy** (writing code, refactor, multi-file changes — all three may delegate these to a sub-agent / skill, or return them to the caller, but never run them itself), cross-machine journal sync, embedding / natural-language journal search, journal compaction or summarization, **automatic drift polling** (`spec-pact` DRIFT-CHECK is explicit only), **automatic INDEX commit / push**, cross-machine SPEC sync, embedding-based SPEC search, **GitHub webhook reception / event subscription** (`pr-review-watch` is polling-only — turn-bound, no scheduler / no webhook listener), **GitHub API direct calls / `gh` CLI execution from Rocky or Mindy** (always external GitHub MCP), **PR creation / actual merge by Mindy** (those return to the caller; mindy only watches and replies), **typecheck / test / lint runs from Mindy during VALIDATE** (mindy is `bash: deny`; the user runs the command and tells mindy the result in one line), **automatic re-arm of a stopped PR watch**, **alias-prefixed PR handle parsing** (`<alias>#<num>` is registered in config but parsing is deferred — MVP requires `owner/repo#NUMBER` or a github.com/.../pull URL). Anything beyond this scope ships as a separate PR proposal.

The longer-term capability targets (auto memory, GitHub-issue tracking, OpenAPI client generation, …) live in [`ROADMAP.md`](./ROADMAP.md) — phase-by-phase, one PR at a time. Do not pull roadmap items into MVP unless the user explicitly asks.

### Removal candidates

The 10 tools missing from the Claude Code surface are not yet removed from disk — code stays compilable for the opencode entrypoint until each is dropped in its own follow-up PR. Domains, in the order they should be dropped:

| Order | Domain | Code | Tools omitted from Claude Code surface | Why a candidate |
| --- | --- | --- | --- | --- |
| 1 | `gap-coverage` | `lib/gap-coverage.test.ts` only | (no tool) | Test-only, no caller. Safest first step. |
| 2 | `pr-watch` | `lib/pr-watch.ts` (+ test), `skills/pr-review-watch/`, `agents/mindy.md` | `pr_watch_start` / `pr_watch_stop` / `pr_watch_status` / `pr_event_record` / `pr_event_pending` / `pr_event_resolve` (×6) | Self-contained domain. Polling design and the external-GitHub-MCP dependency add maintenance cost without a Claude Code use case. |
| n/a | `notion-context` | `lib/notion-context.ts`, `lib/notion-chunking.ts` (+ tests), `skills/notion-context/` | `notion_get` / `notion_refresh` / `notion_status` / `notion_extract` (×4) | Already off the Claude Code surface (depends on opencode's `~/.local/share/opencode/mcp-auth.json` OAuth cache, which Claude Code does not populate). `agents/grace.md` calls `notion_*` during spec-pact DRAFT — review the SPEC lifecycle dependency before dropping. |

`spec-pact` and `journal` were once raised as removal candidates but are kept on both surfaces — they carry turn-spanning value that does not depend on either host's built-in memory.

Each removal lands as its own PR with: code delete + test delete + `FEATURES.md` / `AGENTS.md` (this section + Layout) sync + `agent-toolkit.schema.json` shrink (if a top-level key drops). The `.opencode/INSTALL.md` is updated only when the opencode-side surface changes.

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
4. If the user-facing surface (tools / env vars / handles) changes, sync the **two single sources** — `FEATURES.md` (Korean, humans) and `AGENTS.md` (English, agents — this file's *Project in one line* + *Layout*) — and the entry pages: `README.md` always, `.opencode/INSTALL.md` only when the opencode-side surface changes, `.claude-plugin/plugin.json` only when the Claude Code surface changes.
5. If a new env var is added, update the env-reading site that consumes it. The Notion / OpenAPI download / MCP-auth env vars feed `readEnv()` in `.opencode/plugins/agent-toolkit.ts`. The journal / OpenAPI cache / MySQL env vars are read by their `lib/*` factory (`createJournalFromEnv` / `createOpenapiCacheFromEnv` / `MysqlExecutorRegistry`) which both `server/index.ts` (Claude Code) and `.opencode/plugins/agent-toolkit.ts` call. Update the `FEATURES.md` env-var table on every addition.
6. If a plugin tool contract changes, update the tool-usage rules in the relevant skill (`skills/notion-context/SKILL.md` for `notion_*`, `skills/openapi-client/SKILL.md` for `openapi_*`, `skills/mysql-query/SKILL.md` for `mysql_*`, `skills/spec-pact/SKILL.md` for the lifecycle modes that touch `notion_*` / `journal_*` / file IO, `skills/pr-review-watch/SKILL.md` for `pr_*` / `journal_*` and the external GitHub MCP) **and** the routing / tool rules in `agents/rocky.md` (Rocky conducts the cache-first skills + journal and routes the SPEC and PR review watch lifecycles, so changes on either side propagate to it; `journal_*` is owned by `rocky` directly — no separate skill) **and** `agents/grace.md` (Grace conducts `spec-pact` end-to-end and is the single finalize/lock authority over `.agent/specs/INDEX.md` + SPEC files; GitHub Issue / PR / 일반 `gh` 호출은 toolkit 밖 — grace 는 관여하지 않음) **and** `agents/mindy.md` (Mindy conducts `pr-review-watch` end-to-end and is the single finalize authority over `pr_event_resolved` journal entries).
7. If `agent-toolkit.json` shape changes, update **both** `agent-toolkit.schema.json` (IDE autocomplete) **and** `lib/toolkit-config.ts` (runtime validation) — they must stay in lockstep. Currently the `openapi.registry`, the `spec` (dir / scanDirectorySpec / indexFile), the `mysql.connections` (host / env / db → host / port / user / database / passwordEnv / dsnEnv), and the `github.repositories` (PR review watch) objects are the four top-level keys with explicit validation.

## MCP servers

`.mcp.json` registers two MCP servers at project scope, both shown as a trust prompt the first time Claude Code or opencode loads them — approve both to enable:

- [`context7`](https://github.com/upstash/context7) — pull up-to-date documentation for external libraries (Bun, TypeScript, the opencode plugin API, etc.).
- `agent-toolkit` — the toolkit's own stdio MCP server (`bun run server/index.ts`). Exposes the 15-tool Claude Code surface (OpenAPI / MySQL / journal / `spec_pact_fragment`).

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
- Write code review outputs (summary/inline/suggestions) in Korean by default.
- When requesting a PR review, explicitly ask for Korean review comments (e.g. `모든 리뷰 코멘트는 한국어로 작성해 주세요.`).
- PR titles must follow Conventional Commits style (`type(scope): Korean summary` or `type: Korean summary`; e.g. `docs: runtime 주석 guidance 정리`).
- PR title/body and user-facing change descriptions should also be written in Korean.
- **Single sources**: humans = `FEATURES.md` (Korean), agents = this `AGENTS.md` (English). Do not introduce a new sibling doc — fold new content into one of the two.
