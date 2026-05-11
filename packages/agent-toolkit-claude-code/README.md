# @minjun0219/agent-toolkit-claude-code

agent-toolkit 의 Claude Code plugin. stdio MCP 서버로 **7 개 `openapi_*` 도구** 를 노출 — OpenAPI / Swagger spec 캐시 우선 fetch, endpoint 점수화 검색, tag list. 같은 7-tool surface 를 [opencode plugin](../agent-toolkit-opencode) / [standalone `openapi-mcp` CLI](../openapi-mcp) 도 노출한다.

> v0.3 부터 toolkit 은 OpenAPI 도메인만 다룬다. 이전 journal / mysql / notion / spec-pact / pr-watch 도메인은 [`archive/pre-openapi-only-slim`](https://github.com/minjun0219/agent-toolkit/tree/archive/pre-openapi-only-slim) 브랜치에 박제되어 있고, 활용 패턴이 잡히면 ROADMAP 의 phase 단위로 재추가된다.

## 7 tool

`openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs` / `openapi_endpoint` / `openapi_tags`. 입출력 형태는 루트 [`FEATURES.md`](../../FEATURES.md) 참고.

## 설치 (Claude Code marketplace)

1. Claude Code 의 plugin marketplace 에서 `agent-toolkit` 검색 → install.
2. 첫 trust prompt 에서 `agent-toolkit` MCP 서버 trust.
3. user 또는 project 레벨에 [`agent-toolkit.json`](#agent-toolkitjson) 작성 (선택 — URL 직접 입력으로도 작동).
4. `openapi_envs` / `openapi_get` 호출.

## 설치 (로컬 체크아웃 — 개발용)

저장소 root 에서 직접 trust 해 개발할 때:

1. `bun install`
2. Claude Code 가 저장소 root 의 `.mcp.json` 의 `agent-toolkit` stdio 서버 (`bun run packages/agent-toolkit-claude-code/src/index.ts`) 를 처음 로드할 때 trust prompt — 승인.
3. 동일한 방식으로 호출.

## `agent-toolkit.json`

설정 파일. project 의 `./.opencode/agent-toolkit.json` 이 user 의 `~/.config/opencode/agent-toolkit/agent-toolkit.json` 을 leaf 단위로 덮어쓴다.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "openapi": {
    "registry": {
      "acme": {
        "dev":  { "users": "https://dev.acme.example/openapi.json" },
        "prod": {
          "users":  { "url": "https://api.acme.example/openapi.json", "baseUrl": "https://api.acme.example" }
        }
      }
    }
  }
}
```

핸들 규칙은 `host:env:spec`, 식별자는 `^[a-zA-Z0-9_-]+$`. leaf 는 string (URL only) 또는 object (`{ url, baseUrl?, format? }`). 자세한 내용은 루트 [`FEATURES.md`](../../FEATURES.md).

## 환경 변수

| 변수 | 기본값 | 영향 |
| --- | --- | --- |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `$XDG_CACHE_HOME/openapi-mcp` 또는 `~/.cache/openapi-mcp` | 디스크 캐시 위치. |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `300` | 캐시 TTL (초). |
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | user-level config 경로 override. |

## 라이선스

MIT.
