# Agent Toolkit — Features

> Single source of truth for what the toolkit exposes.
> Audience: humans browsing GitHub, and agents (opencode / Claude Code / codex / …) reading via grep or anchor.
> A Korean mirror lives at [`FEATURES.ko.md`](./FEATURES.ko.md). This English file is the canonical version — when surfaces change, update this file first, then mirror to the Korean one.

## At a glance

- **28 tools** across 8 categories
- **7 skills** (`notion-context`, `openapi-client`, `mysql-query`, `spec-pact`, `pr-review-watch`, `spec-to-issues`, `gh-passthrough`)
- **3 agents** (`rocky`, `grace`, `mindy`)
- **One config file** — `agent-toolkit.json` (project `./.opencode/agent-toolkit.json` overrides user `~/.config/opencode/agent-toolkit/agent-toolkit.json`)
- **Runtime**: Bun ≥ 1.0, opencode-only. No build step.
- **Unstable tool convention**: any tool whose name starts with `unstable_` is not considered a stable agent contract yet. Agents must treat these as test-only / human-supervised surfaces until the prefix is removed.
- **GitHub transport policy**: gh CLI for write, external GitHub MCP for live PR state, journal-only for `unstable_pr_*` queueing. The toolkit never stores GitHub tokens and never calls the GitHub API directly for PR comments. `unstable_pr_*`, `unstable_issue_*`, and `unstable_gh_run` are intentionally unstable so Minjun can test them before promotion.

Each tool entry below uses the same six-field shape so it can be quoted as a single block:

```
What           — one or two lines on behavior
Input          — required + optional parameters
Output         — top-level shape of the return value
Owner          — skill / agent that conducts this tool
Side effects   — disk / network actions (or "none")
Related config — env vars and agent-toolkit.json keys it reads
```

## Tools

### Notion cache (`notion_*`)

Single-page, cache-first reads against the user's Notion via the Notion remote MCP (OAuth handles auth). Database queries and child-page traversal are out of scope.

#### `notion_get`

- **What**: Cache-first read of a single Notion page. Hit returns immediately; miss calls the remote MCP, validates the page id, and writes the cache.
- **Input**: `input` — Notion page id or page URL.
- **Output**: `NotionPageResult` — `{ entry: { pageId, url, cachedAt, ttlSeconds, contentHash, title }, markdown, fromCache }`. (`fromCache: true` on hit, `false` on miss.)
- **Owner**: `notion-context` skill, conducted by `rocky`. Also called by `spec-pact` (DRAFT / DRIFT-CHECK).
- **Side effects**: writes `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}` on miss.
- **Related config**: `AGENT_TOOLKIT_NOTION_MCP_URL`, `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS`, `AGENT_TOOLKIT_CACHE_DIR`, `AGENT_TOOLKIT_CACHE_TTL`.

#### `notion_refresh`

- **What**: Force-fetch a Notion page from the remote MCP (ignore cache), validate the id, and rewrite the cache.
- **Input**: `input` — Notion page id or page URL.
- **Output**: same `NotionPageResult` shape as `notion_get`, always with `fromCache: false`.
- **Owner**: `notion-context` skill.
- **Side effects**: rewrites `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}`.
- **Related config**: same as `notion_get`.

#### `notion_status`

- **What**: Inspect cache metadata for a single page. No remote call.
- **Input**: `input` — Notion page id or page URL.
- **Output**: `NotionCacheStatus` — `{ pageId, exists, expired, cachedAt?, ttlSeconds?, ageSeconds?, title? }`. The optional fields are populated only when the cache file exists.
- **Owner**: `notion-context` skill.
- **Side effects**: none.
- **Related config**: `AGENT_TOOLKIT_CACHE_DIR`.

#### `notion_extract`

- **What**: Cache-first read, then split the Notion markdown into heading-based chunks and emit implementation-action candidates (`requirements` / `screens` / `apis` / `todos` / `questions`).
- **Input**: `input` — Notion page id or page URL. Optional `maxCharsPerChunk: number` (default 1400).
- **Output**: `NotionExtractResult` — `{ entry, fromCache, chunkCount, chunks, extracted: { requirements, screens, apis, todos, questions } }`. Note the field name is `extracted`, not `candidates`.
- **Owner**: `notion-context` skill (Korean spec mode), and `spec-pact` (DRAFT mode).
- **Side effects**: same cache write as `notion_get` on miss; otherwise none.
- **Related config**: same as `notion_get`.

### OpenAPI cache (`openapi_*`)

Cache-first reads of OpenAPI / Swagger JSON specs, plus a cross-spec endpoint search and the `host:env:spec` registry. YAML specs are out of scope.

#### `openapi_get`

- **What**: Cache-first read of an OpenAPI / Swagger JSON spec. Hit returns immediately; miss downloads the spec by URL, validates JSON shape, and writes the cache.
- **Input**: `input` — spec URL (`https://…` / `file://…`), a 16-hex disk key, or a `host:env:spec` handle declared in `agent-toolkit.json`.
- **Output**: `OpenapiSpecResult` — `{ entry: { key, specUrl, cachedAt, ttlSeconds, specHash, title, version, openapi, endpointCount }, spec, fromCache }`. `spec` is the full parsed OpenAPI document.
- **Owner**: `openapi-client` skill, conducted by `rocky`.
- **Side effects**: writes `<AGENT_TOOLKIT_OPENAPI_CACHE_DIR>/<key>.{json,spec.json}` on miss (`key = sha256(specUrl)[:16]`).
- **Related config**: `AGENT_TOOLKIT_OPENAPI_CACHE_DIR`, `AGENT_TOOLKIT_OPENAPI_CACHE_TTL`, `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS`, `openapi.registry` in `agent-toolkit.json`.

#### `openapi_refresh`

- **What**: Force-download an OpenAPI / Swagger JSON spec (ignore cache), validate, and rewrite the cache.
- **Input**: `input` — same accepted shapes as `openapi_get`.
- **Output**: same `OpenapiSpecResult` shape, always with `fromCache: false`.
- **Owner**: `openapi-client` skill.
- **Side effects**: rewrites the two cache files.
- **Related config**: same as `openapi_get`.

#### `openapi_status`

- **What**: Inspect cache metadata for one spec. No network call.
- **Input**: `input` — same accepted shapes as `openapi_get`.
- **Output**: `OpenapiCacheStatus` — `{ key, exists, expired, cachedAt?, ttlSeconds?, ageSeconds?, title?, specUrl?, endpointCount? }`. The optional fields are populated only on cache hit.
- **Owner**: `openapi-client` skill.
- **Side effects**: none.
- **Related config**: `AGENT_TOOLKIT_OPENAPI_CACHE_DIR`, `openapi.registry`.

#### `openapi_search`

- **What**: Substring search across cached specs over `path` / `method` / `tag` / `operationId` / `summary`. Optional `scope` narrows to host / `host:env` / `host:env:spec`. No network call.
- **Input**: `query: string`, `limit?: number` (default 20), `scope?: string`.
- **Output**: bare `OpenapiEndpointMatch[]` — `[{ specKey, specUrl, specTitle, method, path, operationId?, summary?, tags? }]`. No wrapper object; `tags` is plural.
- **Owner**: `openapi-client` skill.
- **Side effects**: none (reads cache only).
- **Related config**: `AGENT_TOOLKIT_OPENAPI_CACHE_DIR`, `openapi.registry`.

#### `openapi_envs`

- **What**: Flatten the `openapi.registry` tree from `agent-toolkit.json` into a list of registry entries. No network call.
- **Input**: none.
- **Output**: bare `OpenapiRegistryEntry[]` — `[{ host, env, spec, url }]`. No wrapper object. Empty array when the registry is unconfigured.
- **Owner**: `openapi-client` skill.
- **Side effects**: none.
- **Related config**: `openapi.registry` in `agent-toolkit.json`.


### Journal (`journal_*`)

Turn-spanning agent memory. Append-only JSONL, no TTL. Use it to record decisions, blockers, user answers, and notes that the next turn must cite. Corrupted lines are skipped on read.

#### `journal_append`

- **What**: Append one entry to the journal.
- **Input**: `content: string` (required), `kind?: string` (e.g. `decision` / `blocker` / `answer` / `note` — free string, defaults to `note`), `tags?: string[]`, `pageId?: string` (Notion page id or URL — normalised to `8-4-4-4-12` on save).
- **Output**: the appended `JournalEntry` — `{ id, timestamp, kind, content, tags, pageId? }`.
- **Owner**: `rocky` (general use), and every skill that records lifecycle events (`spec-pact`, `pr-review-watch`, `spec-to-issues`, `gh-passthrough`).
- **Side effects**: appends one line to `<AGENT_TOOLKIT_JOURNAL_DIR>/journal.jsonl`.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_read`

- **What**: Return recent entries, newest first, with optional filters and limit.
- **Input**: `limit?: number` (default 20), `kind?: string`, `tag?: string`, `pageId?: string` (page-key lookup), `since?: string` (ISO 8601 — only entries after that instant).
- **Output**: bare `JournalEntry[]` — no wrapper object.
- **Owner**: any agent / skill that needs to recover prior context.
- **Side effects**: none.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_search`

- **What**: Substring search (case-insensitive) over `content`, `kind`, `tags`, and `pageId`.
- **Input**: `query: string`, `limit?: number`, `kind?: string`.
- **Output**: bare `JournalEntry[]` — no wrapper object.
- **Owner**: lifecycle recovery for `spec-pact` (`journal_search "spec-pact"`) and `pr-review-watch` (`journal_search "pr-watch"`), plus general agent use.
- **Side effects**: none.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_status`

- **What**: Report file path, existence, valid entry count (corrupted lines excluded), byte size, and last-entry timestamp.
- **Input**: none.
- **Output**: `JournalStatus` — `{ path, exists, totalEntries, sizeBytes, lastEntryAt? }`.
- **Owner**: any.
- **Side effects**: none.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

### MySQL read-only (`mysql_*`)

Read-only inspection of MySQL via `host:env:db` handles declared in `agent-toolkit.json`. Writes / DDL / multi-statement / `SET` / `CALL` / `LOAD` / `INTO OUTFILE` are all rejected. Always pair with a database account that only has `GRANT SELECT` as the first line of defence.

#### `mysql_envs`

- **What**: Flatten the `mysql.connections` tree into registry entries. **Credential values are never returned — only the env-var names.**
- **Input**: none.
- **Output**: bare `MysqlRegistryEntry[]` — `[{ host, env, db, handle, authMode, authEnv, hostName, port, user, database }]`. No wrapper object. Empty array when no connections are configured.
- **Owner**: `mysql-query` skill, conducted by `rocky`.
- **Side effects**: none (no DB connection).
- **Related config**: `mysql.connections` in `agent-toolkit.json`.

#### `mysql_status`

- **What**: Resolve a handle, build a connection from `passwordEnv` / `dsnEnv`, and run a single `SELECT 1` ping.
- **Input**: `handle: string` (`host:env:db`).
- **Output**: `MysqlRegistryEntry & { ok: boolean }` — the registry entry described above plus a single `ok` field from the ping.
- **Owner**: `mysql-query` skill.
- **Side effects**: opens a short-lived connection to the target server.
- **Related config**: `mysql.connections`; the env var named by `passwordEnv` or `dsnEnv`.

#### `mysql_tables`

- **What**: `SHOW FULL TABLES` against the resolved database — list of tables and views.
- **Input**: `handle: string`.
- **Output**: bare `Array<{ name: string; type: string }>`. No wrapper object. `type` is the raw `SHOW FULL TABLES` value (e.g. `BASE TABLE` / `VIEW`).
- **Owner**: `mysql-query` skill.
- **Side effects**: opens one connection and runs one read query.
- **Related config**: `mysql.connections`.

#### `mysql_schema`

- **What**: Without `table`, return an `INFORMATION_SCHEMA.COLUMNS` summary for the current DB. With `table`, return the combined output of `SHOW CREATE TABLE` + `SHOW INDEX FROM`.
- **Input**: `handle: string`, `table?: string`.
- **Output**: discriminated union by `mode`. Summary mode (no `table`): `{ mode: "summary", columns: [{ table, column, type, nullable, key, default, extra }] }`. Detail mode (with `table`): `{ mode: "detail", createTable: string, indexes: [{ keyName, column, nonUnique, type }] }`.
- **Owner**: `mysql-query` skill.
- **Side effects**: opens one connection and runs one or two read queries.
- **Related config**: `mysql.connections`.

#### `mysql_query`

- **What**: Run a single read-only SQL statement. Pipeline: `assertReadOnlySql(sql)` → `enforceLimit(sql, { limit })` → execute. The first keyword must be one of `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`. `LIMIT` is auto-applied (default 100, hard cap 1000) on row-returning statements.
- **Input**: `handle: string`, `sql: string`, `limit?: number`.
- **Output**: `MysqlQueryResult` — `{ sql, rows, columns, rowCount, truncated, effectiveLimit }`. `effectiveLimit` is `null` for `SHOW` / `DESCRIBE` / `EXPLAIN`.
- **Owner**: `mysql-query` skill.
- **Side effects**: opens one connection and runs one read query.
- **Related config**: `mysql.connections`.

### PR review watch (`unstable_pr_*`)

> **UNSTABLE**: this surface is deliberately prefixed with `unstable_`. Do not assume long-term name / schema stability; agents should surface plans and prefer human confirmation.

Polling-only PR lifecycle. The toolkit never calls the GitHub API directly for PR comments — the external GitHub MCP server (registered separately in the user's opencode session) handles PR meta / comments / replies / merge-state queries. These tools own the local queue and lifecycle state only.

#### `unstable_pr_watch_start`

- **What**: Register a PR handle as an active watch, persist a `pr_watch_start` journal entry, and return the updated watch state.
- **Input**: `handle: string` (`owner/repo#NUMBER` or a github.com PR URL), `note?: string`, `labels?: string[]`, `mergeMode?: "merge" | "squash" | "rebase"`. `mergeMode` is enum-validated; values outside the enum throw.
- **Output**: `{ entry: JournalEntry, state: PrWatchState }`. `state` = `{ handle, active, startedAt?, stoppedAt?, note? }`.
- **Owner**: `pr-review-watch` skill, conducted by `mindy`.
- **Side effects**: appends a `pr_watch_start` entry to the journal.
- **Related config**: `github.repositories` in `agent-toolkit.json`.

#### `unstable_pr_watch_stop`

- **What**: Stop a watch, append a `pr_watch_stop` journal entry, and return the final state.
- **Input**: `handle: string`, `reason?: "merged" | "closed" | "manual"`. `reason` is enum-validated; free strings are rejected so the journal `reason:<value>` tag stays consistent for recovery / aggregation.
- **Output**: `{ entry: JournalEntry, state: PrWatchState }` (with `active: false` and `stoppedAt` set).
- **Owner**: `pr-review-watch` skill.
- **Side effects**: appends a `pr_watch_stop` entry.
- **Related config**: `github.repositories`.

#### `unstable_pr_watch_status`

- **What**: Reduce the journal once and return every active watch plus the per-handle pending event total.
- **Input**: none.
- **Output**: `{ active: PrWatchState[], totals: { active: number, pending: number } }`. `pending` is the sum across all active watches.
- **Owner**: `pr-review-watch` skill.
- **Side effects**: none.
- **Related config**: `github.repositories`.

#### `unstable_pr_event_record`

- **What**: Enqueue a single inbound PR event (comment / review / review comment / check / status / merge / close) fetched by the external GitHub MCP. Same `(handle, type, externalId)` reappends on disk (append-only) but responds with `alreadySeen: true`.
- **Input**: `handle: string`, `type: "issue_comment" | "pr_review" | "pr_review_comment" | "check_run" | "status" | "merge" | "close"`, `externalId: string`, `summary: string` (one-line digest from the caller — author + short excerpt; the full external MCP payload is not stored here).
- **Output**: `{ entry: JournalEntry, ref: { type, externalId, toolkitKey }, alreadySeen }`.
- **Owner**: `pr-review-watch` skill.
- **Side effects**: appends a `pr_event_inbound` entry.
- **Related config**: `github.repositories`.

#### `unstable_pr_event_pending`

- **What**: List inbound events for a handle that have no corresponding `pr_event_resolved` entry, ordered by timestamp ascending.
- **Input**: `handle: string`.
- **Output**: bare `PendingPrEvent[]` — `[{ handle, ref, receivedAt, summary, inboundEntryId }]`. No wrapper object.
- **Owner**: `pr-review-watch` skill.
- **Side effects**: none.
- **Related config**: `github.repositories`.

#### `unstable_pr_event_resolve`

- **What**: Record `mindy`'s validation outcome for one inbound event. Track the reply id from the external GitHub MCP via `replyExternalId` so future polls can correlate.
- **Input**: `handle: string`, `type: "issue_comment" | "pr_review" | …` (same enum as `unstable_pr_event_record`), `externalId: string`, `decision: "accepted" | "rejected" | "deferred"`, `reasoning: string`, `replyExternalId?: string`. The handler resolves the `toolkitKey` internally from `(type, externalId)`. Throws if no matching `pr_event_inbound` exists yet (orphan-resolve guard).
- **Output**: `{ entry: JournalEntry, resolved: { type, externalId, toolkitKey } }`.
- **Owner**: `pr-review-watch` skill — `mindy` is the sole authority over `pr_event_resolved` entries.
- **Side effects**: appends a `pr_event_resolved` entry.
- **Related config**: `github.repositories`.

### spec-pact (`spec_pact_fragment`)

The four `spec-pact` mode bodies live as separate files under `<plugin>/skills/spec-pact/fragments/`. This single tool exists so `grace` can pull the right body in one call without inlining all four into the SKILL.

#### `spec_pact_fragment`

- **What**: Read the markdown fragment for one mode (`draft` / `verify` / `drift-check` / `amend`) from the plugin's absolute install path (resolved via `import.meta.url`), so it works under `agent-toolkit@git+…` installs regardless of the user's cwd.
- **Input**: `mode: "draft" | "verify" | "drift-check" | "amend"`.
- **Output**: `{ mode, path, content }`.
- **Owner**: `spec-pact` skill, conducted by `grace`. Designed to be called exactly once per turn (a second call defeats the fragment-loading saving).
- **Side effects**: none (file read inside the plugin install).
- **Related config**: none.

### spec-to-issues (`unstable_issue_*`)

> **UNSTABLE**: this surface is deliberately prefixed with `unstable_` while Minjun tests the real GitHub Issue sync workflow.

One-way sync from a locked SPEC (`<spec.dir>/<slug>.md` or `**/SPEC.md`) into a GitHub epic + sub-issue series. Auth, repo detection, GHE hosting, and scope are all delegated to the user's `gh` CLI — the toolkit adds no new env vars and no octokit / raw-fetch dependency.

#### `unstable_issue_create_from_spec`

- **What**: Reconcile the SPEC's `# 합의 TODO` flat bullets into a GitHub epic plus one sub-issue per bullet. Marker-based dedupe (`<!-- spec-pact:slug=…:kind=epic|sub:index=N -->`) makes it idempotent — re-runs are no-ops, only newly added bullets create new sub-issues. dryRun-first contract: the default `dryRun: true` returns the plan only, `dryRun: false` actually invokes `gh`.
- **Input**: `slug?: string` xor `path?: string`, `repo?: string` (`owner/name` override), `dryRun?: boolean` (default `true`).
- **Output**: a sync report containing the epic, the sub-issue plan (created / existing / orphans), and — when `dryRun: false` — the applied result. Exact field shape lives in `lib/github-issue-sync.ts`.
- **Owner**: `spec-to-issues` skill, conducted by `rocky`. `grace`'s authority stops at the SPEC — GitHub state is rocky's surface.
- **Side effects**: when `dryRun: false`, calls `gh issue create` / `gh issue edit` and appends a journal entry.
- **Related config**: `github.repo`, `github.defaultLabels` (default `["spec-pact"]`, index 0 is the dedupe filter), `spec.dir`, `spec.scanDirectorySpec`, `spec.indexFile`.

#### `unstable_issue_status`

- **What**: Read-only alias of `dryRun: true`. Calls `gh issue list` once, surfaces what would be created, what already exists, and any orphaned sub-issues whose source bullet was removed from the SPEC.
- **Input**: same as `unstable_issue_create_from_spec` minus `dryRun`.
- **Output**: same plan shape as `unstable_issue_create_from_spec` with no applied section (read-only).
- **Owner**: `spec-to-issues` skill.
- **Side effects**: one `gh issue list` call. **No journal entry** — read-only.
- **Related config**: same as `unstable_issue_create_from_spec`.

### gh-passthrough (`unstable_gh_run`)

> **UNSTABLE**: this surface is deliberately prefixed with `unstable_` while Minjun tests which `gh` passthrough commands are safe and useful.

Generic ad-hoc passthrough to the user's `gh` CLI for anything that doesn't fit the high-level `spec-to-issues` flow.

#### `unstable_gh_run`

- **What**: Take an `args` array starting with a `gh` subcommand, classify it as `read` / `write` / `deny`, then enforce policy.
  - **read** (`auth status` / `repo view` / `issue list` / `pr view` / `api` default GET / `search` / `gist list|view` / …) — runs immediately.
  - **write** (`issue create` / `label create` / `api --method POST` / …) — `dryRun: true` (default) returns a plan-only result; `dryRun: false` actually runs.
  - **deny** (`pr merge` / `repo edit|delete` / `release delete` / `workflow run|enable|disable` / `run rerun|cancel` / `auth login|logout|refresh|setup-git|token` / `extension *` / `alias *` / `config *` / `gist create|edit|delete|clone` / unknown subcommand) — throws `GhDeniedCommandError` immediately. `gist list|view` is allowed as read.
- **Input**: `args: string[]`, `dryRun?: boolean` (default `true`).
- **Output**: `RunGhResult` — `{ args, kind, executed, dryRun, stdout, stderr, exitCode }`. For a write + `dryRun: true` call, `executed` is `false` and `stdout` carries a `(dry-run, not executed) gh …` line. Non-zero `exitCode` from `gh` throws `GhCommandError` instead of returning.
- **Owner**: `gh-passthrough` skill, conducted by `rocky`.
- **Side effects**: every call (read / dry-run / applied) appends a journal entry tagged `["gh-passthrough", "read" | "dry-run" | "applied"]`. Read calls and applied write calls also invoke `gh` on the user's machine.
- **Related config**: none directly (the `gh` CLI handles its own auth and `~/.config/gh/`).

## Skills

Each skill bundles a small surface of tools into a step-by-step prompt. Skills live under `skills/<name>/SKILL.md`.

### `notion-context`

- **Conducted by**: `rocky`.
- **Tools used**: `notion_get`, `notion_status`, `notion_refresh`, `notion_extract`.
- **Purpose**: Cache-first Notion read with two output styles — pass the markdown through as raw LLM context, or extract a structured Korean-language spec. Default for Notion URLs.

### `openapi-client`

- **Conducted by**: `rocky`.
- **Tools used**: `openapi_get`, `openapi_status`, `openapi_refresh`, `openapi_search`, `openapi_envs`.
- **Purpose**: Locate one endpoint inside a cached OpenAPI / Swagger JSON spec and emit a `fetch` (default) or `axios` TypeScript call snippet.

### `mysql-query`

- **Conducted by**: `rocky`.
- **Tools used**: `mysql_envs`, `mysql_status`, `mysql_tables`, `mysql_schema`, `mysql_query`.
- **Purpose**: Read-only MySQL inspection — list envs, ping, list tables, inspect schema, run a single allowed `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `WITH`.

### `spec-pact`

- **Conducted by**: `grace` (sole finalize / lock authority).
- **Modes**: `DRAFT` (Notion → 합의 → write SPEC + refresh INDEX), `VERIFY` (turn the SPEC's 합의 TODO + API dependencies into a checklist), `DRIFT-CHECK` (compare the SPEC's `source_content_hash` with `notion_get(pageId).entry.contentHash`), `AMEND` (per-drift keep / update / reject → patch SPEC + bump version).
- **Tools used**: `notion_get`, `notion_extract`, `journal_append`, `journal_read`, `journal_search`, `spec_pact_fragment`, plus opencode's `read` / `write` / `edit` / `glob`.
- **Storage**: `<spec.dir>/<spec.indexFile>` (default `.agent/specs/INDEX.md`) as the wiki-style entry point, plus `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`) and/or `**/SPEC.md`.
- **Lifecycle journal kinds**: `spec_anchor`, `spec_drift`, `spec_amendment`, `spec_verify_result`. The DRIFT-CHECK clean case reuses the `note` kind with the tag pair `["spec-pact", "drift-clear"]`. Recover history with the tag-shaped query `journal_search "spec-pact"`.

### `pr-review-watch`

- **Conducted by**: `mindy` (sole authority over `unstable_pr_event_resolved`). Trigger only when the user explicitly asks to review/check/watch; a PR URL/handle alone is not enough.
- **Modes**: `WATCH-START`, `PULL`, `VALIDATE`, `WATCH-STOP`.
- **Tools used**: `unstable_pr_watch_start`, `unstable_pr_watch_stop`, `unstable_pr_watch_status`, `unstable_pr_event_record`, `unstable_pr_event_pending`, `unstable_pr_event_resolve`, `journal_append`, `journal_read`, `journal_search`, opencode's `read` / `glob` / `grep`. **External GitHub MCP must be registered in the opencode session** so `mindy` can fetch PR meta, comments, replies, and merge state.
- **PR handle**: `owner/repo#NUMBER` or a github.com PR URL. Journal-side handle is the tag `pr:<canonical>`; the `pageId` slot is intentionally unused (Notion id pattern doesn't match).
- **Lifecycle journal kinds**: `pr_watch_start`, `pr_watch_stop`, `pr_event_inbound`, `pr_event_resolved`. Recover history with `journal_search "pr-watch"`.

### `spec-to-issues`

- **Conducted by**: `rocky`. `grace` does not call this skill — finalize / lock authority stops at the SPEC.
- **Tools used**: `unstable_issue_create_from_spec`, `unstable_issue_status`, `journal_append`, `journal_read`, `journal_search`, opencode's `read`.
- **Contract**: dryRun-first. Always run `unstable_issue_status` (or `unstable_issue_create_from_spec` with `dryRun: true`) first, surface the plan to the user, then re-run with `dryRun: false`.
- **Auth**: delegated to the user's `gh` CLI. Throws a one-line guidance error if `gh` is missing or unauthenticated.

### `gh-passthrough`

- **Conducted by**: `rocky`.
- **Tools used**: `unstable_gh_run`, `journal_append`, `journal_read`, `journal_search`.
- **Contract**: dryRun-first for write commands. Read commands run immediately; environment-affecting and high-impact commands are denied at the tool level (see `unstable_gh_run`).

## Agents

Each agent's full prompt and exact tool / permission frontmatter live under `agents/<name>.md`. The summary below covers mode, permissions, and routing rules.

### `rocky`

- **Mode**: `all` (callable as primary or as a sub-agent of an external primary like OmO Sisyphus or Superpowers).
- **Permissions**: `edit: deny`, `bash: deny` — rocky does not write code or run shell commands directly.
- **Specialty**: frontend, with full-stack reach.
- **Conducts**: `notion-context`, `openapi-client`, `mysql-query`, `spec-to-issues`, `gh-passthrough`, plus journal usage.
- **Routes**:
  - SPEC lifecycle keywords ("스펙 합의", "SPEC 작성", "SPEC 검증", "SPEC drift", "기획문서 변경 반영") → `@grace`.
  - Explicit PR review watch keywords ("PR review", "리뷰 봐줘", "리뷰 확인", "코멘트 확인", "머지까지 watch", "리뷰 답글", "PR drift") + PR handle → `@mindy`. A bare PR link / reference mention does not start watch.
  - Multi-step implementation (writing code, refactor, multi-file changes) → external sub-agent / skill, or returns the work to the caller. Rocky never implements directly.
- **Hard refusals**: MySQL writes / DDL (the SQL guard rejects them), direct GitHub API calls (delegated to the external GitHub MCP).

### `grace`

- **Mode**: `subagent` (invoked via `@grace` or rocky's routing).
- **Permissions**: `edit: allow`, `bash: deny`.
- **Conducts**: `spec-pact` end-to-end (DRAFT / VERIFY / DRIFT-CHECK / AMEND).
- **Authority**: sole finalize / lock authority over `<spec.dir>/<spec.indexFile>` and SPEC files. Even when an external agent participates in 합의, only `grace` writes the SPEC frontmatter and the INDEX.
- **Out of scope**: `spec-to-issues` and `gh-passthrough` (rocky's surface), code implementation.

### `mindy`

- **Mode**: `subagent` (invoked via `@mindy` or rocky's routing).
- **Permissions**: `edit: deny`, `bash: deny` — mindy never edits code, never runs `gh` / `bun test` / `tsc` / `curl` directly.
- **Conducts**: `pr-review-watch` end-to-end (WATCH-START / PULL / VALIDATE / WATCH-STOP).
- **Authority**: sole authority over `pr_event_resolved` journal entries.
- **Out of scope**: PR creation, PR merge, code commits, running tests / typecheck / lint during VALIDATE (the user runs these and tells mindy the result in one line).
- **External dependency**: the GitHub MCP server must be registered in the opencode session for mindy to fetch PR meta and comments. The toolkit ships no GitHub HTTP client of its own.

## Config (`agent-toolkit.json`)

Project (`./.opencode/agent-toolkit.json`) overrides user (`~/.config/opencode/agent-toolkit/agent-toolkit.json` or `$AGENT_TOOLKIT_CONFIG`) on a per-leaf basis. The full grammar is in [`agent-toolkit.schema.json`](./agent-toolkit.schema.json) — point your editor's JSON Schema settings at the schema to get autocomplete and validation.

| Key | Purpose | Leaf shape | Notes |
| --- | --- | --- | --- |
| `openapi.registry` | `host:env:spec` handle → spec URL | `{ [host]: { [env]: { [spec]: "https://…" } } }` | Identifiers match `^[a-zA-Z0-9_-]+$`. URL must be non-empty. YAML specs are out of scope. |
| `spec.dir` / `spec.scanDirectorySpec` / `spec.indexFile` | SPEC layout for `spec-pact` | `string` / `boolean` / `string` | Defaults `.agent/specs` / `true` / `INDEX.md`. |
| `mysql.connections` | `host:env:db` handle → MySQL profile | `{ [host]: { [env]: { [db]: { passwordEnv } | { dsnEnv } } } }` | **Plaintext passwords / DSNs in this file are rejected by the loader.** Use `passwordEnv` (with `host` / `user` / `database` / optional `port`) or `dsnEnv` (single `mysql://user:pass@host:port/db` env var) — exactly one of the two. |
| `github.repositories` | `owner/repo` allow-list for PR review watch | `{ [owner/repo]: { alias?, labels?, defaultBranch?, mergeMode? } }` | Keys must match `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` (exactly one slash, e.g. `minjun0219/agent-toolkit`) — different from the colon-separated `host:env:spec` / `host:env:db` handles. Token / secret leaves are rejected — auth lives with the external GitHub MCP. `mergeMode ∈ {"merge", "squash", "rebase"}`. |
| `github.repo` / `github.defaultLabels` | Default repo and dedupe labels for `spec-to-issues` | `string` / `string[]` | `defaultLabels` defaults to `["spec-pact"]`; index 0 is the dedupe filter. Repo precedence: tool param > config > `gh` auto-detect. |

## Storage layout

| Surface | Path | TTL | Notes |
| --- | --- | --- | --- |
| Notion cache | `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}` | `AGENT_TOOLKIT_CACHE_TTL` (default 86400 s) | Both files must exist; missing one is treated as cache miss. |
| OpenAPI cache | `<AGENT_TOOLKIT_OPENAPI_CACHE_DIR>/<key>.{json,spec.json}` | `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `key = sha256(specUrl)[:16]`. Same dual-file rule. |
| Journal | `<AGENT_TOOLKIT_JOURNAL_DIR>/journal.jsonl` | none | Append-only, no expiry. Corrupted lines are skipped on read. |
| SPEC | `<spec.dir>/<spec.indexFile>` + `<spec.dir>/<slug>.md` and/or `**/SPEC.md` | none | `grace` is the sole writer. |

## Out of scope (MVP)

- **Notion database queries** and child-page traversal (single-page only).
- **MySQL writes / DDL / multi-statement / stored procs / `SET` / `LOAD` / `INTO OUTFILE` / `INTO DUMPFILE`**, MySQL TLS / SSH-tunnel options, and OS keychain integration.
- Other DBMSs (Postgres / SQLite / Oracle / MSSQL) and MySQL result disk caching.
- OpenAPI YAML parsing, runtime base-URL override (use `spec.servers`), full SDK code generation, multi-spec merge, mock servers.
- Multi-host plugin layouts (`.claude-plugin/`, `.cursor-plugin/`, …) — opencode-only for MVP.
- **GitHub webhook reception / event subscription** — `pr-review-watch` is polling-only and turn-bound, no scheduler.
- **Direct GitHub API calls or `gh` CLI execution from `rocky` or `mindy`** outside the `gh-passthrough` / `spec-to-issues` skills.
- **PR creation / merge by `mindy`** — those return to the caller.
- **Typecheck / test / lint runs from `mindy` during VALIDATE** — `mindy` is `bash: deny`; the user runs the command and tells `mindy` the result in one line.
- Cross-machine journal / SPEC sync, embedding-based search, journal compaction or summarisation.
- Automatic drift polling, automatic INDEX commit / push, automatic re-arm of a stopped PR watch.
- Alias-prefixed PR handle parsing (`<alias>#<num>`) — registered in config but parsing is deferred.
- **Direct multi-step implementation by `rocky` / `grace` / `mindy`** (writing code, refactor, multi-file changes) — all three may delegate or return work, never run it themselves.

## See also

- [`README.md`](./README.md) — narrative entry point and Quick start (Korean)
- [`AGENTS.md`](./AGENTS.md) — agent contract, MVP scope, and the change checklist
- [`.opencode/INSTALL.md`](./.opencode/INSTALL.md) — install verification, agent fallback, smoke tests
- [`agent-toolkit.schema.json`](./agent-toolkit.schema.json) — JSON Schema for `agent-toolkit.json`
- [`ROADMAP.md`](./ROADMAP.md) — post-MVP phases
- [`FEATURES.ko.md`](./FEATURES.ko.md) — Korean mirror of this file
