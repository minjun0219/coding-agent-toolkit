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
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | User-level `agent-toolkit.json` path. The project-level `./.opencode/agent-toolkit.json` overrides it at the leaf level. |

## Smoke test

Once opencode is running:

```
> use skill tool to list skills
```

If `notion-context` and `openapi-client` both show up, skills are loaded.

Then verify the tools are registered:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
> use swagger_status tool with input "<spec URL or host:env:spec handle>"
> use swagger_get tool with input "<spec URL or host:env:spec handle>"
> use swagger_envs tool   # flatten the registry from agent-toolkit.json
> use journal_append tool with content "decided to ship Phase 3" kind "decision"
> use journal_read tool   # most recent first
```

The first call returns `fromCache: false` — remote is hit once. The second call returns `fromCache: true` (same policy for `notion_*` and `swagger_*`). `journal_*` does not hit any remote — it only reads / writes the local JSONL file.

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

## Agent (`rocky`)

`agents/rocky.md` is registered into opencode's agent path via the plugin's `config` hook. `mode: all` means it shows up both in the primary cycle (Tab) and as a delegation target from another primary agent.

Direct invocation (context mode):

```
@rocky https://www.notion.so/.../<pageId>
```

Spec mode:

```
@rocky <Notion URL> 스펙 정리해줘
```

In a setup that already has its own primary agent (e.g. OmO Sisyphus), that agent sees `rocky` in its subagent list (turn start) and routes Notion requests to it via the description — no need to hard-code Rocky's existence into the upstream agent's system prompt. Routing is not guaranteed; the primary may decide to handle it directly.

If the plugin is not registered, or the opencode version does not recognize `agents.paths`, drop a symlink or copy of `agents/rocky.md` into the project's `.opencode/agents/` instead.
