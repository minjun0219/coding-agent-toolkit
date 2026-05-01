# opencode install

Add this repository to the `plugin` array in `opencode.json` and restart opencode.

```json
{
  "plugin": [
    "agent-toolkit@git+https://github.com/minjun0219/coding-agent-toolkit.git"
  ]
}
```

Or, to use a local checkout directly:

```json
{
  "plugin": ["./path/to/coding-agent-toolkit"]
}
```

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
| `AGENT_TOOLKIT_GITHUB_TOKEN` | (none) | GitHub PAT used by the `spec-to-issues` skill. `repo` scope, or fine-grained `Issues: Read & Write`. Secret — never store in `agent-toolkit.json`. |
| `AGENT_TOOLKIT_GITHUB_REPO` | (none) | Default `owner/repo` for `issue_create_from_spec` / `issue_status`. `agent-toolkit.json` `github.repo` takes precedence; the caller can also pass `repo` directly. |
| `AGENT_TOOLKIT_GITHUB_API_URL` | `https://api.github.com` | GitHub REST API base URL. Override for GHE or corporate proxies. `agent-toolkit.json` `github.apiBaseUrl` takes precedence. |
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | User-level `agent-toolkit.json` path. The project-level `./.opencode/agent-toolkit.json` overrides it at the leaf level. |

## Smoke test

Once opencode is running:

```
> use skill tool to list skills
```

If `notion-context`, `openapi-client`, `spec-pact`, and `spec-to-issues` all show up, skills are loaded.

Then verify the tools are registered:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
> use swagger_status tool with input "<spec URL or host:env:spec handle>"
> use swagger_get tool with input "<spec URL or host:env:spec handle>"
> use swagger_envs tool   # flatten the registry from agent-toolkit.json
> use journal_append tool with content "decided to ship Phase 3" kind "decision"
> use journal_read tool   # most recent first
> use issue_status tool with slug "<your-locked-spec-slug>"
> use issue_create_from_spec tool with slug "<your-locked-spec-slug>" dryRun true
```

The first call returns `fromCache: false` — remote is hit once. The second call returns `fromCache: true` (same policy for `notion_*` and `swagger_*`). `journal_*` does not hit any remote — it only reads / writes the local JSONL file. `issue_*` always hits GitHub (REST API) for the dedupe-listing GET; only `issue_create_from_spec` (without `dryRun`) writes (creates / patches issues).

## OpenAPI registry (`agent-toolkit.json`)

Once you write an `agent-toolkit.json`, the swagger tools accept short `host:env:spec` handles in addition to raw URLs. The project file (`./.opencode/agent-toolkit.json`) overrides the user file (`~/.config/opencode/agent-toolkit/agent-toolkit.json`) at the leaf level.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/coding-agent-toolkit/main/agent-toolkit.schema.json",
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

## GitHub Issue sync (`spec-to-issues`)

The same config file holds the GitHub target for the `spec-to-issues` skill. All keys optional; the skill throws a clear error when something required is missing.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/coding-agent-toolkit/main/agent-toolkit.schema.json",
  "github": {
    "repo": "minjun0219/agent-toolkit",
    "apiBaseUrl": "https://api.github.com",
    "defaultLabels": ["spec-pact"]
  }
}
```

`github.repo` must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`. `defaultLabels` must be a non-empty array — the first label doubles as the GitHub `labels=` filter for dedupe lookup, so it has to remain stable across runs (default `["spec-pact"]`). Token / secret values are never stored here; pass `AGENT_TOOLKIT_GITHUB_TOKEN` via the environment (PAT with `repo` scope, or fine-grained `Issues: Read & Write`).

After that:

```
> use issue_create_from_spec tool with slug "<locked-spec-slug>" dryRun true   # plan only
> use issue_create_from_spec tool with slug "<locked-spec-slug>"               # apply
> use issue_status tool with slug "<locked-spec-slug>"                          # GET-only status
```

The plugin maps each SPEC to a single epic + N sub-issues (`# 합의 TODO` bullets). Reruns are idempotent (marker + label dedupe). Auto-reopen, GitHub Project (v2) board moves, and Notion ↔ Issue two-way sync are intentionally out-of-scope.

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
