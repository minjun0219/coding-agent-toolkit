# opencode install

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

Confirm that the plugin is correctly loaded by checking `package.json` for the `main` and `exports` fields:

```bash
bun -e 'const p=await Bun.file("package.json").json(); console.log("main:", p.main); console.log("server:", p.exports?.["./server"]?.import)'
```

- **Expected `main`**: `./.opencode/plugins/agent-toolkit.ts`
- **Expected `exports["./server"]`**: `./.opencode/plugins/agent-toolkit.ts`

## Troubleshooting: Agents Not Showing Up

If `rocky` or `grace` agents do not appear in `opencode agent list` (common on opencode `1.14.33` + Bun `1.3.11` + macOS), you can manually expose them to your project:

1. Create the project-local agent directory:
   ```bash
   mkdir -p .opencode/agents
   ```
2. Copy the agent files from the installed package:
   ```bash
   cp node_modules/agent-toolkit/agents/rocky.md .opencode/agents/
   cp node_modules/agent-toolkit/agents/grace.md .opencode/agents/
   ```

*Note: The path inside `node_modules` may vary depending on your git installation method.*

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

If `notion-context`, `openapi-client`, `mysql-query`, and `spec-pact` all show up, skills are loaded.

Then verify the tools are registered:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
> use notion_extract tool with input "<pageId or url>" maxCharsPerChunk 1400
> use swagger_status tool with input "<spec URL or host:env:spec handle>"
> use swagger_get tool with input "<spec URL or host:env:spec handle>"
> use swagger_envs tool   # flatten the registry from agent-toolkit.json
> use journal_append tool with content "decided to ship Phase 3" kind "decision"
> use journal_read tool   # most recent first
> use spec_pact_fragment tool with mode "draft"   # Phase 6.A — returns the DRAFT mode body from the plugin's absolute path
```

Optional spec-to-issues smoke (Phase 2 — only after `gh` is installed and authenticated; see "GitHub Issue sync" below):

```
> use issue_status tool with slug "<existing-locked-spec-slug>"                          # plan only, single `gh issue list` call
> use issue_create_from_spec tool with slug "<slug>" dryRun true                         # same as issue_status (read-only)
> use issue_create_from_spec tool with slug "<slug>" dryRun false                        # apply: creates missing subs, then patches/creates the epic
> use issue_create_from_spec tool with slug "<slug>" dryRun false                        # re-run is a no-op (markers match)
```

`gh` 미설치면 `GhNotInstalledError`, 미인증이면 `GhAuthError` 가 한 줄 install / login 가이드와 함께 throw.

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

The first call returns `fromCache: false` — remote is hit once. The second call returns `fromCache: true` (same policy for `notion_*` and `swagger_*`). `journal_*` does not hit any remote — it only reads / writes the local JSONL file.

## OpenAPI registry (`agent-toolkit.json`)

Once you write an `agent-toolkit.json`, the swagger tools accept short `host:env:spec` handles in addition to raw URLs. The project file (`./.opencode/agent-toolkit.json`) overrides the user file (`~/.config/opencode/agent-toolkit/agent-toolkit.json`) at the leaf level.

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
> use swagger_get tool with input "acme:dev:users"
> use swagger_search tool with query "/pets" scope "acme:dev"
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

## Agents (`rocky` + `grace`)

`agents/rocky.md` and `agents/grace.md` are registered into opencode's agent path via the plugin's `config` hook. Rocky's `mode: all` shows up both in the primary cycle (Tab) and as a delegation target from another primary agent; Grace's `mode: subagent` only shows up as a delegation target (called by Rocky, by an external primary that happens to share the environment, or by the user via an explicit `@grace`). Neither agent pins a `model:` in its frontmatter — both inherit whatever model the user has selected in the opencode session, so prompts can be swapped between models without editing the agent files.

Rocky is a work partner with frontend specialty and fullstack range — it conducts the toolkit's two cache-first skills (`notion-context`, `openapi-client`) and the journal as its primary contract, routes the SPEC 합의 lifecycle to `@grace`, and may delegate to external sub-agents / skills when the work exceeds the toolkit.

Grace is the SPEC 합의 lifecycle owner — it conducts the `spec-pact` skill end-to-end (DRAFT / VERIFY / DRIFT-CHECK / AMEND) and is the single finalize/lock authority over the INDEX file (`<spec.dir>/<spec.indexFile>`, default `.agent/specs/INDEX.md`, the LLM-wiki-inspired entry point) + SPEC files (`<spec.dir>/<slug>.md` slug 모드 default `.agent/specs/<slug>.md`, or `**/SPEC.md` directory 모드).

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

Chained (Notion → OpenAPI in one turn):

```
@rocky <Notion URL> 스펙 정리하고 거기 나온 POST /pets 의 axios snippet 도 줘
```

In a setup that already has its own primary agent (e.g. OmO Sisyphus, Superpowers — these are synergies when present, not dependencies), that agent sees `rocky` (and through Rocky, `grace`) in its subagent list (turn start) and routes toolkit-shaped or working-context requests via the description — no need to hard-code Rocky/Grace existence into the upstream agent's system prompt. Routing is not guaranteed; the primary may decide to handle it directly.

Neither Rocky nor Grace directly run multi-step implementation work (writing code, refactor, multi-file changes). When such work is needed, they delegate to an external sub-agent / skill if one fits, or return the request to the caller.

The SPEC layer lives at `<spec.dir>/<spec.indexFile>` (entry point — default `.agent/specs/INDEX.md`) + `<spec.dir>/<slug>.md` (slug 모드 — default `.agent/specs/<slug>.md`) by convention. To park a SPEC inside a directory subtree (AGENTS.md style), drop `<dir>/SPEC.md` instead — `grace` discovers both via the `**/SPEC.md` glob (toggle `spec.scanDirectorySpec` in `agent-toolkit.json` to disable). All three keys (`spec.dir`, `spec.indexFile`, `spec.scanDirectorySpec`) are overridable via `agent-toolkit.json`.

If the plugin is not registered, or the opencode version does not recognize `agents.paths`, drop a symlink or copy of `agents/rocky.md` and `agents/grace.md` into the project's `.opencode/agents/` instead.

## GitHub Issue sync (Phase 2 — `spec-to-issues` skill / `issue_*` tools)

`spec-to-issues` 는 잠긴 SPEC 의 `# 합의 TODO` 를 GitHub epic + sub-issue 시리즈로 한 방향 동기화한다 (Rocky 가 conduct, Grace 는 책임 외). **모든 GitHub 호출은 사용자 환경의 `gh` CLI 위임으로 처리** — agent-toolkit 은 토큰 / API URL 같은 새 env 변수를 추가하지 않는다.

### Precondition

```
$ gh --version           # required: gh ≥ 2.40 (older gh has --json label shape differences)
$ gh auth status         # required: exit 0 — `gh` must be authenticated for the target repo
$ gh auth login --scopes "repo"   # if not authenticated; for GHE add --hostname <your-host>
```

`gh` 가 PATH 에 없거나 인증되지 않으면 plugin 이 한 줄 install / login 가이드와 함께 throw 한다 (재시도 X).

### `agent-toolkit.json` `github` 객체 (선택)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "github": {
    "repo": "minjun0219/agent-toolkit",
    "defaultLabels": ["spec-pact"]
  }
}
```

- `repo` (선택) — `owner/name`. 미지정 시 `gh repo view --json nameWithOwner` 가 cwd 에서 자동 감지. tool param `repo` 가 이 값을 override.
- `defaultLabels` (선택, 기본 `["spec-pact"]`) — sync 가 새 issue 에 부착할 라벨 배열. **`[0]` 이 dedupe 검색 (`gh issue list --label`) 의 1차 필터**라 stable 해야 한다. `^[a-zA-Z0-9_-]+$` 패턴만 허용 (콜론 / 공백 X).

### 사용 예 (Rocky 경유)

```
@rocky user-auth SPEC 의 GitHub 이슈 상태 보여줘                # → issue_status (dryRun, plan only)
@rocky user-auth SPEC 을 이슈로 만들어줘                         # → issue_create_from_spec dryRun=true 먼저
                                                                # → 사용자 확인 후 dryRun=false 로 apply
@rocky user-auth 에 새 bullet 추가했어, 이슈 추가 동기화해줘     # → 같은 호출, 새 sub 만 생성 + epic body patch
```

### 멱등 보증

- 마커 (HTML 주석) 기반 dedupe: `<!-- spec-pact:slug=<slug>:kind=epic -->`, `<!-- spec-pact:slug=<slug>:kind=sub:index=<n> -->`
- 같은 SPEC 재호출 = no-op (모든 marker 매칭 → reuse)
- bullet 추가 = 새 sub 만 생성 + epic body 의 task list 자동 patch
- bullet 삭제 = orphan 으로 surface 만 (close 하지 않음)
- 제목 / 라벨 사람이 바꿔도 marker 가 살아있으면 같은 issue 로 인식
