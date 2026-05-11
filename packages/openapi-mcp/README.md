# openapi-mcp

Standalone stdio MCP server for browsing internal OpenAPI / Swagger specs. Cache-first, `$ref` deref + swagger 2.0 → OpenAPI 3 auto-conversion, scored endpoint search, tag list. **Host-agnostic** — works with any MCP client (Claude Code, Cursor, Continue, Claude Desktop, opencode, …) via stdio.

> agent-toolkit 의 OpenAPI 도메인만 떼어낸 subset MCP. 같은 7-tool surface 를 [agent-toolkit Claude Code plugin](../agent-toolkit-claude-code) / [opencode plugin](../agent-toolkit-opencode) 도 노출한다.

## 7 tool surface

`openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs` / `openapi_endpoint` / `openapi_tags`. 입출력 형태는 루트의 [`FEATURES.md`](../../FEATURES.md) 참고.

## 설치

### npm (배포 후)

```bash
npm i -g openapi-mcp           # 또는 bun add -g openapi-mcp
openapi-mcp --config ~/.config/openapi-mcp/openapi-mcp.json
```

### 로컬 체크아웃

```bash
bun install                    # 워크스페이스 의존성
cd packages/openapi-mcp
bun link                       # 한 번만, openapi-mcp 를 PATH 에 노출
openapi-mcp --help
```

## 사용

```bash
openapi-mcp                                      # XDG 기본 위치의 openapi-mcp.json 사용
openapi-mcp --config /etc/myorg/openapi.json
openapi-mcp --log-level debug
openapi-mcp --insecure-tls --config ./dev.json   # 사내 self-signed
openapi-mcp -V                                   # 버전
openapi-mcp -h                                   # 옵션 도움말
```

stdout 은 MCP JSON-RPC stream 전용 — 로그는 모두 stderr.

## Config

`openapi-mcp.json` (또는 `.yaml` / `.yml`). 검색 경로: `--config` flag → `$XDG_CONFIG_HOME/openapi-mcp/openapi-mcp.json` → `~/.config/openapi-mcp/openapi-mcp.json`.

```json
{
  "specs": {
    "acme-users": {
      "environments": {
        "dev": {
          "baseUrl": "https://dev.acme.example",
          "source": { "type": "url", "url": "https://dev.acme.example/openapi.json" }
        },
        "prod": {
          "baseUrl": "https://api.acme.example",
          "source": { "type": "url", "url": "https://api.acme.example/openapi.json" }
        }
      }
    }
  },
  "cache": { "diskCache": true, "ttlSeconds": 300 },
  "http":  { "timeoutMs": 30000, "insecureTls": false }
}
```

## 다른 host 에 등록

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 또는 `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openapi": {
      "command": "openapi-mcp",
      "args": ["--config", "/Users/me/.config/openapi-mcp/openapi-mcp.json"]
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "openapi": {
      "type": "stdio",
      "command": "openapi-mcp",
      "args": ["--config", "/path/to/openapi-mcp.json"]
    }
  }
}
```

### Cursor / Continue

각 IDE 의 MCP server 등록 UI 에 `openapi-mcp` 를 stdio 서버로 등록.

## 환경 변수

| 변수 | 기본값 | 영향 |
| --- | --- | --- |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `$XDG_CACHE_HOME/openapi-mcp` 또는 `~/.cache/openapi-mcp` | 디스크 캐시 위치. |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `300` | 캐시 TTL (초). config 의 `cache.ttlSeconds` 가 우선. |

## 라이선스

MIT.
