# opencode 설치

`opencode.json` 의 `plugin` 배열에 이 저장소를 추가한 뒤 opencode 를 재시작한다.

```json
{
  "plugin": [
    "agent-toolkit@git+https://github.com/<owner>/coding-agent-toolkit.git"
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

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | ✅ | remote Notion MCP base URL (`POST {url}/getPage` 가정) |
| `AGENT_TOOLKIT_NOTION_MCP_TOKEN` | ⛔️ | 있으면 `Authorization: Bearer …` 첨부 |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | ⛔️ | 기본 `15000` |
| `AGENT_TOOLKIT_CACHE_DIR` | ⛔️ | 기본 `.agent-cache/notion/pages` |
| `AGENT_TOOLKIT_CACHE_TTL` | ⛔️ | 초 단위, 기본 `86400` |

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
