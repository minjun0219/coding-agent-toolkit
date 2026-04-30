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
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | remote 호출 timeout (ms) |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.cache/notion-context/pages` | 페이지 캐시 디렉터리 |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | 캐시 TTL (초) |

## 동작 확인

opencode 를 띄운 뒤:

```
> use skill tool to list skills
```

목록에 `notion-spec-reader` 가 보이면 skill 로딩 OK.

도구 등록도 확인:

```
> use notion_status tool with input "<pageId or url>"
> use notion_get tool with input "<pageId or url>"
```

첫 호출은 `fromCache: false` 로 remote 가 한 번 불리고, 두 번째 호출은 `fromCache: true` 가 되어야 한다.

## Agent (`rocky`)

`agents/rocky.md` 가 plugin 의 config 훅을 통해 opencode agent 경로에 등록된다. primary agent 사이클(Tab) 에 `rocky` 가 보이면 OK.

호출 예:

```
@rocky https://www.notion.so/.../<pageId> 이거 끝까지 구현해줘
```

내부적으로 `notion-spec-reader` skill → `notion_get` 도구 순으로 흐른다. plugin 이 미등록이거나 `agents.paths` 가 인식되지 않는 opencode 버전이면, 프로젝트의 `.opencode/agents/rocky.md` 로 직접 심볼릭 링크하거나 복사해서 쓴다.
