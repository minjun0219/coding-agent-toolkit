# Agent Toolkit

opencode 전용 plugin. Notion 페이지를 캐시 우선으로 읽는 도구 3 개와, 그 도구로 페이지를 컨텍스트로 가져오거나 한국어 스펙으로 정리하는 skill 1 개, 그리고 두 자원을 외부에 노출하는 얇은 게이트웨이 agent 1 개(`rocky`) 를 제공한다. 런타임은 **Bun (>=1.0)** 만 사용하며, 별도 빌드 단계는 없다 (Bun 이 TS 직접 실행).

구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다 — 단일 plugin 파일이 `skills/` / `agents/` 디렉터리를 opencode 탐색 경로에 등록하고 도구를 노출한다. `rocky` 의 캐릭터/네이밍 컨벤션은 [code-yeongyu/oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) 의 named-specialist 패턴에서 빌렸지만, 책임은 게이트웨이 한 줄로 한정한다.

## 디렉터리

```
.
├── .opencode/
│   ├── INSTALL.md                  # opencode 사용자용 설치 안내
│   └── plugins/
│       ├── agent-toolkit.ts        # plugin entrypoint + 도구 3 개
│       └── agent-toolkit.test.ts
├── lib/
│   ├── notion-context.ts           # TTL 파일 캐시 + key 정규화 + normalize
│   └── notion-context.test.ts
├── skills/
│   └── notion-context/SKILL.md     # Notion 캐시 우선 읽기 + 한국어 스펙 정리 skill
├── agents/
│   └── rocky.md                    # 위 skill / 도구 묶음의 게이트웨이 agent (mode: all)
├── .mcp.json                        # context7 MCP 등록 (개발 보조용)
├── package.json / tsconfig.json
├── AGENTS.md / CLAUDE.md
└── README.md
```

> 다른 host (Claude Code, Cursor, Codex CLI) 호환은 후속 작업 — 필요 시 Superpowers 처럼 `.claude-plugin/`, `.cursor-plugin/` 디렉터리를 추가하면 된다. 지금은 opencode 전용.

## 설치 / 사용

`opencode.json` 의 `plugin` 배열에 추가하고 opencode 를 재시작:

```json
{ "plugin": ["agent-toolkit@git+https://github.com/minjun0219/coding-agent-toolkit.git"] }
```

자세한 환경변수 / 검증 흐름은 [`.opencode/INSTALL.md`](./.opencode/INSTALL.md) 참고.

## 환경변수

전부 옵션. 기본값을 바꿔야 할 때만 설정한다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | remote Notion MCP base URL. 인증은 OAuth 가 처리하므로 토큰 변수는 없다. |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | remote 호출 timeout (ms) |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.cache/notion-context/pages` | 페이지 캐시 디렉터리 |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | 캐시 TTL (초) |

## 도구

plugin 이 opencode 에 다음 3 개를 등록한다:

| 도구 | 동작 |
| --- | --- |
| `notion_get` | 캐시 우선. hit 면 즉시 반환, miss 면 remote MCP 호출 → id 검증 → 캐시 저장 |
| `notion_refresh` | 캐시 무시하고 remote 강제 fetch → id 검증 → 캐시 갱신 |
| `notion_status` | 캐시 메타(저장 시각, TTL, 만료 여부) 만 조회. remote 호출 없음 |

`input` 파라미터는 page id 또는 Notion URL 모두 허용.

## Agent

| 이름 | mode | 역할 |
| --- | --- | --- |
| `rocky` | all | agent-toolkit 게이트웨이. Notion URL/page id 를 받아 cached markdown(컨텍스트 모드) 또는 한국어 스펙(스펙 모드) 으로 반환. 코드 작성/구현은 호출자 책임. |

`mode: all` 이라 사용자 직접 호출(primary, Tab 사이클)과 다른 primary agent (e.g. OmO Sisyphus) 의 위임(subagent) 둘 다 가능. 다른 agent 는 turn 시작 시 받는 subagent 목록의 `description` 만으로 라우팅 — Rocky 의 존재를 system prompt 에 박지 않아도 Notion 관련 요청이 알아서 들어온다.

## 캐시 구조

```
<AGENT_TOOLKIT_CACHE_DIR>/
  <pageId>.json   # 메타데이터: pageId, url, cachedAt, ttlSeconds, contentHash, title
  <pageId>.md     # normalize 된 markdown 본문
```

`.json` 또는 `.md` 한쪽이 누락되면 `notion_status` 와 `notion_get` 모두 cache miss 로 본다.

## 개발

```bash
bun install
bun test          # lib/ + .opencode/plugins/ 단위 테스트
bun run typecheck
```
