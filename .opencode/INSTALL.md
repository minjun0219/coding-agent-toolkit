# opencode install

> Looking for the **Claude Code** entrypoint? It is not opencode-specific — see [`README.md`](../README.md) (the "Claude Code (1차 host)" section). Claude Code uses `.claude-plugin/plugin.json` + the root `.mcp.json` and exposes a narrower 15-tool surface (no `notion_*` / `pr_*`). The rest of this file applies only to the opencode host.

Add this repository to the `plugin` array in `opencode.json` and restart opencode.

```json
{
  "plugin": [
    "agent-toolkit@git+https://github.com/minjun0219/agent-toolkit.git"
  ]
}
```

Or, to use a local checkout directly:

```json
{
  "plugin": ["./path/to/agent-toolkit"]
}
```

## Installation Verification

opencode installs package plugins under its cache, not the consumer project's `node_modules`. Verify the installed package metadata and server module from the actual package directory:

```bash
PLUGIN_DIR=$(ls -d "$HOME"/.cache/opencode/packages/agent-toolkit@* | sort | tail -1)
PLUGIN_DIR="$PLUGIN_DIR" bun -e 'const dir=process.env.PLUGIN_DIR; if (!dir) throw new Error("PLUGIN_DIR is required"); const p=await Bun.file(`${dir}/package.json`).json(); const root=p.exports?.["."]?.import; const server=p.exports?.["./server"]?.import; if (p.main!=="./.opencode/plugins/agent-toolkit-server.ts" || root!==p.main || server!==p.main) throw new Error("bad agent-toolkit entrypoint"); const mod=await import(`${dir}/${root.slice(2)}`); console.log("agent-toolkit root:", typeof mod.default)'
```

- **Expected output**: `agent-toolkit root: function`
- For a local checkout plugin, set `PLUGIN_DIR` to that checkout path instead of using the cache lookup.

## Troubleshooting: Agents Not Showing Up

If `rocky`, `grace`, or `mindy` agents do not appear in `opencode agent list` (common on opencode `1.14.33` + Bun `1.3.11` + macOS), you can manually expose them to your project:

1. Create the project-local agent directory:
   ```bash
   mkdir -p .opencode/agents
   ```
2. Copy the agent files from the installed package cache:
   ```bash
   PLUGIN_DIR=$(ls -d "$HOME"/.cache/opencode/packages/agent-toolkit@* | sort | tail -1)
   cp "$PLUGIN_DIR/agents/rocky.md" .opencode/agents/
   cp "$PLUGIN_DIR/agents/grace.md" .opencode/agents/
   cp "$PLUGIN_DIR/agents/mindy.md" .opencode/agents/
   ```

*Note: For a local checkout plugin, set `PLUGIN_DIR` to that checkout path instead of using the cache lookup.*

### GitHub Transport Policy

agent-toolkit 자체는 GitHub 쓰기 surface 를 두지 않습니다. PR 라이브 상태 (코멘트 / 답글 / 머지 상태) 는 사용자가 opencode 에 별도로 등록한 외부 GitHub MCP 가 책임지고, `pr_*` 도구는 로컬 저널에만 기록합니다. PR 생성 / 머지 / 일반 `gh` 호출이 필요할 때는 사용자 / Claude Code / 외부 GitHub MCP 가 직접 처리합니다.

## Environment variables

All optional. Set only when the defaults do not fit.

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | Remote Notion MCP base URL. Auth goes through Notion's OAuth, so there is no token variable. |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | Remote Notion call timeout (ms). |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.config/opencode/agent-toolkit/notion-pages` | Notion page cache directory. |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | Notion cache TTL (seconds). |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `~/.config/opencode/agent-toolkit/openapi-specs` | OpenAPI / Swagger spec cache directory. |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `86400` | OpenAPI cache TTL (seconds). |
| `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS` | `30000` | OpenAPI spec download timeout (ms). |
| `AGENT_TOOLKIT_JOURNAL_DIR` | `~/.config/opencode/agent-toolkit/journal` | Agent journal directory. Holds a single `journal.jsonl` (append-only, no TTL). |
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | User-level `agent-toolkit.json` path. The project-level `./.opencode/agent-toolkit.json` overrides it at the leaf level. |

MySQL connections take credentials *only* from environment variables — the variable *name* is declared per handle (`passwordEnv` or `dsnEnv`) inside `agent-toolkit.json` 의 `mysql.connections`. Suggested pattern: `MYSQL_<HOST>_<ENV>_<DB>_PASSWORD` (passwordEnv mode) or `MYSQL_<HOST>_<ENV>_<DB>_DSN` (dsnEnv mode). Plaintext credentials in the config file are rejected by the loader.

## Smoke test

Once opencode is running:

```
> use skill tool to list skills
```

If `notion-context`, `openapi-client`, `mysql-query`, `spec-pact`, and `pr-review-watch` all show up, skills are loaded.

Then verify the tools are registered:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
> use notion_extract tool with input "<pageId or url>" maxCharsPerChunk 1400
> use openapi_status tool with input "<spec URL or host:env:spec handle>"
> use openapi_get tool with input "<spec URL or host:env:spec handle>"
> use openapi_envs tool   # flatten the registry from agent-toolkit.json
> use journal_append tool with content "decided to ship Phase 3" kind "decision"
> use journal_read tool   # most recent first
> use spec_pact_fragment tool with mode "draft"   # returns the DRAFT mode body from the plugin's absolute path
```

Optional PR review watch smoke (works without external GitHub MCP — the toolkit's six `pr_*` tools never call GitHub; mindy reads PR meta / comments through whichever GitHub MCP server you have registered separately):

```
> use pr_watch_start tool with handle "owner/repo#42" note "review 1차"
> use pr_watch_status tool                                                       # active watches + pending counts
> use pr_event_record tool with handle "owner/repo#42" type "issue_comment" externalId "1" summary "user bob: typo on /api/orders"
> use pr_event_pending tool with handle "owner/repo#42"                         # surfaces the new event
> use pr_event_resolve tool with handle "owner/repo#42" type "issue_comment" externalId "1" decision "accepted" reasoning "fixed missing await"
> use pr_watch_stop tool with handle "owner/repo#42" reason "merged"
```

Optional MySQL smoke (only after registering a `host:env:db` handle in `agent-toolkit.json` and exporting the matching `passwordEnv` / `dsnEnv` variable):

```
> use mysql_envs tool                                                                # flatten mysql.connections (no credentials in output)
> use mysql_status tool with handle "<host:env:db>"                                  # SELECT 1 ping
> use mysql_tables tool with handle "<host:env:db>"                                  # SHOW FULL TABLES
> use mysql_schema tool with handle "<host:env:db>" table "<t>"                      # SHOW CREATE TABLE + SHOW INDEX FROM
> use mysql_query tool with handle "<host:env:db>" sql "SELECT id FROM <t> LIMIT 5"  # read-only SQL only
```

Reject smoke (these MUST throw `MySQL read-only guard: …`):

```
> use mysql_query tool with handle "<host:env:db>" sql "DELETE FROM <t>"
> use mysql_query tool with handle "<host:env:db>" sql "SELECT 1; SELECT 2"
> use mysql_query tool with handle "<host:env:db>" sql "SELECT * FROM <t> INTO OUTFILE '/tmp/x'"
```

The first call returns `fromCache: false` — remote is hit once. The second call returns `fromCache: true` (same policy for `notion_*` and `openapi_*`). `journal_*` does not hit any remote — it only reads / writes the local JSONL file.

## OpenAPI registry (`agent-toolkit.json`)

Once you write an `agent-toolkit.json`, the OpenAPI tools accept short `host:env:spec` handles in addition to raw URLs. The project file (`./.opencode/agent-toolkit.json`) overrides the user file (`~/.config/opencode/agent-toolkit/agent-toolkit.json`) at the leaf level.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "openapi": {
    "registry": {
      "acme": {
        "dev":  { "users": "https://dev.acme/users.json",
                  "orders": "https://dev.acme/orders.json" },
        "prod": { "users": "https://api.acme/users.json" }
      }
    }
  }
}
```

After that:

```
> use openapi_get tool with input "acme:dev:users"
> use openapi_search tool with query "/pets" scope "acme:dev"
```

Identifier pattern is `^[a-zA-Z0-9_-]+$` — colons are reserved as the handle separator. URLs must parse and use `http`, `https`, or `file` scheme. If the config violates the schema, the plugin logs a single error line and falls back to an empty registry — the tools themselves keep working.

## MySQL connections (`agent-toolkit.json`)

Same shape as `openapi.registry`, but the leaf is a connection profile, not a URL. Plaintext passwords / DSN strings are **rejected by the loader** — every profile must declare exactly one of `passwordEnv` (env-var name + decomposed `host`/`port?`/`user`/`database`) or `dsnEnv` (env-var name holding a `mysql://user:pass@host:port/db` line).

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "mysql": {
    "connections": {
      "acme": {
        "prod": {
          "users": {
            "host": "db.acme.example",
            "port": 3306,
            "user": "readonly",
            "database": "app",
            "passwordEnv": "MYSQL_ACME_PROD_USERS_PASSWORD"
          },
          "orders": { "dsnEnv": "MYSQL_ACME_PROD_ORDERS_DSN" }
        }
      }
    }
  }
}
```

Then export the matching env var (read-only account recommended — `GRANT SELECT` only):

```
export MYSQL_ACME_PROD_USERS_PASSWORD=...
# or, for the dsnEnv form:
export MYSQL_ACME_PROD_ORDERS_DSN="mysql://readonly:...@db.acme.example:3306/orders"
```

After that:

```
> use mysql_envs tool
> use mysql_query tool with handle "acme:prod:users" sql "SELECT id FROM users LIMIT 5"
```

Same identifier rules as `openapi.registry` — `^[a-zA-Z0-9_-]+$` for `host` / `env` / `db`. Mismatched env vars (missing / empty) raise a precise error naming the variable; the loader never logs the credential value.

## GitHub repositories (`agent-toolkit.json`)

PR review watch (`mindy` + `pr-review-watch`) consults `github.repositories` for repo-shaped metadata (alias, advisory labels, default branch, recommended merge mode). **No tokens / secrets live in this file** — credentials are owned by whichever GitHub MCP server you have registered separately. The block exists so mindy can:

- recognize that a given `owner/repo` is in scope (allow-list),
- surface `defaultBranch` / `mergeMode` hints in its replies,
- and consult the advisory `labels` list when drafting reply / triage suggestions.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "github": {
    "repositories": {
      "minjun0219/agent-toolkit": {
        "alias": "toolkit",
        "labels": ["bug", "review", "ci"],
        "defaultBranch": "main",
        "mergeMode": "squash"
      }
    }
  }
}
```

The repo key matches `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` (= GitHub's owner/repo body characters). Unknown leaf keys (e.g. `token`, `passwordEnv`, `apiKey`) are rejected by the loader — those belong to the external GitHub MCP, not here.

## Agents (`rocky` + `grace` + `mindy`)

`agents/rocky.md`, `agents/grace.md`, and `agents/mindy.md` are parsed by the plugin's `config` hook and registered as concrete `config.agent.rocky` / `config.agent.grace` / `config.agent.mindy` entries. Rocky's `mode: all` shows up both in the primary cycle (Tab) and as a delegation target from another primary agent; Grace's and Mindy's `mode: subagent` only show up as delegation targets (called by Rocky, by an external primary that happens to share the environment, or by the user via an explicit `@grace` / `@mindy`). None of the three pin a `model:` in their frontmatter — all inherit whatever model the user has selected in the opencode session, so prompts can be swapped between models without editing the agent files.

Rocky is a work partner with frontend specialty and fullstack range — it conducts the toolkit's three cache-first skills (`notion-context`, `openapi-client`, `mysql-query`) and the journal as its primary contract, routes the SPEC 합의 lifecycle to `@grace`, routes the PR review watch lifecycle to `@mindy`, and may delegate to external sub-agents / skills when the work exceeds the toolkit.

Grace is the SPEC 합의 lifecycle owner — it conducts the `spec-pact` skill end-to-end (DRAFT / VERIFY / DRIFT-CHECK / AMEND) and is the single finalize/lock authority over the INDEX file (`<spec.dir>/<spec.indexFile>`, default `.agent/specs/INDEX.md`, the LLM-wiki-inspired entry point) + SPEC files (`<spec.dir>/<slug>.md` slug 모드 default `.agent/specs/<slug>.md`, or `**/SPEC.md` directory 모드).

Mindy is the PR review watch lifecycle owner — it conducts the `pr-review-watch` skill end-to-end (WATCH-START / PULL / VALIDATE / WATCH-STOP) and is the single finalize authority over `pr_event_resolved` journal entries. Mindy never edits code (`permission.edit: deny`), never runs `bun test` / `tsc` / `gh` CLI (`permission.bash: deny`), never creates / merges PRs, and never calls the GitHub API directly — PR meta / comments / replies / merge state all go through an external GitHub MCP server that you must register in your opencode session separately.

Direct invocation — Notion (context mode):

```
@rocky https://www.notion.so/.../<pageId>
```

Notion spec mode (notion-context, **합의 없음**):

```
@rocky <Notion URL> 스펙 정리해줘
```

SPEC 합의 lifecycle (Rocky 가 `@grace` 로 즉시 위임 + passthrough — 또는 `@grace` 직접 호출):

```
@rocky <Notion URL> 스펙 합의해줘            # → grace DRAFT
@grace <slug 또는 Notion URL> SPEC 검증       # → grace VERIFY
@grace <slug 또는 Notion URL> SPEC drift     # → grace DRIFT-CHECK
@grace <slug 또는 Notion URL> 변경 반영       # → grace AMEND
```

OpenAPI snippet mode (default `fetch`):

```
@rocky https://api.example/openapi.json POST /pets 호출 코드
```

OpenAPI snippet mode via registered handle (`agent-toolkit.json`):

```
@rocky acme:dev:users 의 GET /users/{id} axios 로 작성해줘
```

PR review watch (Rocky 가 `@mindy` 로 즉시 위임 + passthrough — 또는 `@mindy` 직접 호출):

```
@rocky https://github.com/minjun0219/agent-toolkit/pull/42 리뷰 봐줘     # → mindy WATCH-START
@mindy minjun0219/agent-toolkit#42 코멘트 확인                            # → mindy PULL (외부 GitHub MCP 호출)
@mindy minjun0219/agent-toolkit#42 1번 검증해줘                          # → mindy VALIDATE (단일 항목)
@mindy minjun0219/agent-toolkit#42 모두 검증해줘                          # → mindy VALIDATE (전체)
@mindy minjun0219/agent-toolkit#42 머지됐어                               # → mindy WATCH-STOP (PULL 에서 자동 stop 도 가능)
```

Chained (Notion → OpenAPI in one turn):

```
@rocky <Notion URL> 스펙 정리하고 거기 나온 POST /pets 의 axios snippet 도 줘
```

In a setup that already has its own primary agent (e.g. OmO Sisyphus, Superpowers — these are synergies when present, not dependencies), that agent sees `rocky` (and through Rocky, `grace`) in its subagent list (turn start) and routes toolkit-shaped or working-context requests via the description — no need to hard-code Rocky/Grace existence into the upstream agent's system prompt. Routing is not guaranteed; the primary may decide to handle it directly.

None of Rocky / Grace / Mindy directly run multi-step implementation work (writing code, refactor, multi-file changes). When such work is needed, they delegate to an external sub-agent / skill if one fits, or return the request to the caller. Mindy is additionally constrained to never call the GitHub API directly, never create / merge PRs, and never run `bun test` / `tsc` / `gh` CLI — those return to the caller (or the external GitHub MCP).

The SPEC layer lives at `<spec.dir>/<spec.indexFile>` (entry point — default `.agent/specs/INDEX.md`) + `<spec.dir>/<slug>.md` (slug 모드 — default `.agent/specs/<slug>.md`) by convention. To park a SPEC inside a directory subtree (AGENTS.md style), drop `<dir>/SPEC.md` instead — `grace` discovers both via the `**/SPEC.md` glob (toggle `spec.scanDirectorySpec` in `agent-toolkit.json` to disable). All three keys (`spec.dir`, `spec.indexFile`, `spec.scanDirectorySpec`) are overridable via `agent-toolkit.json`.

If the plugin is not registered, or the opencode version does not recognize plugin-provided `config.agent.*` entries, drop a symlink or copy of `agents/rocky.md`, `agents/grace.md`, and `agents/mindy.md` into the project's `.opencode/agents/` instead.

