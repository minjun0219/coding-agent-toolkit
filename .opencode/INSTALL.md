# opencode 설치

`opencode.json` 의 `plugin` 배열에 이 저장소를 추가한 뒤 opencode 를 재시작한다.

```json
{
  "plugin": [
    "agent-toolkit@git+https://github.com/minjun0219/coding-agent-toolkit.git"
  ]
}
```

또는 로컬 체크아웃을 직접 쓰려면:

```json
{
  "plugin": ["./path/to/coding-agent-toolkit"]
}
```

## 환경변수

전부 옵션이다. 기본값을 바꿔야 할 때만 설정한다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | remote Notion MCP base URL. 인증은 OAuth 가 처리하므로 토큰 변수는 없다. |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | remote Notion 호출 timeout (ms) |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.config/opencode/agent-toolkit/notion-pages` | Notion 페이지 캐시 디렉터리 |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | Notion 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `~/.config/opencode/agent-toolkit/openapi-specs` | OpenAPI / Swagger spec 캐시 디렉터리 |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `86400` | OpenAPI 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS` | `30000` | OpenAPI spec 다운로드 timeout (ms) |
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | user-level `agent-toolkit.json` 경로. project-level `./.opencode/agent-toolkit.json` 가 leaf 단위로 우선한다. |

## 동작 확인

opencode 를 띄운 뒤:

```
> use skill tool to list skills
```

목록에 `notion-context` / `openapi-client` 가 둘 다 보이면 skill 로딩 OK.

도구 등록도 확인:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
> use swagger_status tool with input "<spec URL or host:env:spec handle>"
> use swagger_get tool with input "<spec URL or host:env:spec handle>"
> use swagger_envs tool   # agent-toolkit.json 의 등록 목록을 평면 리스트로
```

첫 호출은 `fromCache: false` 로 remote 가 한 번 불리고, 두 번째 호출은 `fromCache: true` 가 되어야 한다 (`notion_*` / `swagger_*` 둘 다 동일 정책).

## OpenAPI registry (`agent-toolkit.json`)

`agent-toolkit.json` 을 작성하면 spec URL 대신 `host:env:spec` 형식의 짧은 handle 로 호출할 수 있다. project (`./.opencode/agent-toolkit.json`) 가 user (`~/.config/opencode/agent-toolkit/agent-toolkit.json`) 를 leaf 단위로 덮어쓴다.

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

이후:

```
> use swagger_get tool with input "acme:dev:users"
> use swagger_search tool with query "/pets" scope "acme:dev"
```

식별자 패턴은 `^[a-zA-Z0-9_-]+$` — 콜론은 separator 로 예약. config 가 schema 를 어기면 plugin 은 콘솔에 한 줄 에러를 찍고 빈 registry 로 동작한다 (도구 자체가 죽지는 않음).

## Agent (`rocky`)

`agents/rocky.md` 가 plugin 의 config 훅을 통해 opencode agent 경로에 등록된다. `mode: all` 이라 primary 사이클(Tab) 과 다른 primary 의 subagent 위임 둘 다에서 보인다.

직접 호출 (컨텍스트 모드):

```
@rocky https://www.notion.so/.../<pageId>
```

스펙 모드:

```
@rocky <Notion URL> 스펙 정리해줘
```

OmO 같이 자체 primary agent (Sisyphus 등) 를 쓰는 환경에선, primary 가 turn 시작 시 받는 subagent 목록에서 `rocky` 의 description 을 보고 Notion 관련 요청을 자동으로 위임한다 (보장은 안 됨 — primary 가 직접 처리하기로 결정할 수도 있음). Rocky 의 존재를 OmO 측 system prompt 에 박을 필요는 없다.

plugin 이 미등록이거나 `agents.paths` 가 인식되지 않는 opencode 버전이면, 프로젝트의 `.opencode/agents/rocky.md` 로 직접 심볼릭 링크하거나 복사해서 쓴다.
