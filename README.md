# Agent Toolkit

opencode 전용 plugin. Notion 페이지를 캐시 우선으로 읽는 도구 3 개와, 그 도구로 페이지를 컨텍스트로 가져오거나 한국어 스펙으로 정리하는 skill 1 개, 그리고 회사 컨텍스트를 들고 있는 업무 파트너 agent 1 개(`rocky`) 를 제공한다. Notion 은 시작 소스이고, 회사 지식 표면은 이후 더 넓혀질 수 있다. 런타임은 **Bun (>=1.0)** 만 사용하며, 별도 빌드 단계는 없다 (Bun 이 TS 직접 실행).

구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다 — 단일 plugin 파일이 `skills/` / `agents/` 디렉터리를 opencode 탐색 경로에 등록하고 도구를 노출한다. `rocky` 의 캐릭터/네이밍 컨벤션은 [code-yeongyu/oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) 의 named-specialist 패턴에서 빌렸지만, 책임은 회사 컨텍스트 파트너 한 줄로 한정한다.

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
│   └── rocky.md                    # 회사 컨텍스트 업무 파트너 (mode: all, Notion 시작)
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
| `rocky` | all | 회사 컨텍스트 업무 파트너. 회사 스펙/요구사항/컨벤션/내부 문서를 들고 있고 모호한 요청에는 어느 페이지인지 되묻는다. 받은 포인터로 cached markdown(컨텍스트) 또는 한국어 스펙(스펙) 반환. Notion 이 현재 소스. 코드 작성/구현은 호출자 책임. |

`mode: all` 이라 사용자 직접 호출(primary, Tab 사이클)과 다른 primary agent (e.g. OmO Sisyphus) 의 위임(subagent) 둘 다 가능. 다른 agent 는 turn 시작 시 받는 subagent 목록의 `description` 만으로 라우팅 — Rocky 의 존재를 system prompt 에 박지 않아도 회사 컨텍스트 관련 요청이 알아서 들어온다.

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

## 코드 리뷰 언어 가이드 (Codex / GitHub Copilot)

코드 리뷰 코멘트를 한국어로 받으려면 리뷰 요청 메시지(프롬프트)에 아래 문장을 포함한다.

- `모든 리뷰 코멘트는 한국어로 작성해 주세요.`
- `리뷰 요약, 인라인 코멘트, 수정 제안까지 전부 한국어로 부탁합니다.`

권장 템플릿:

```text
이 PR을 리뷰해 주세요.
모든 리뷰 코멘트는 한국어로 작성해 주세요.
중요도 순서로 이슈를 정리하고, 가능한 경우 수정 예시도 함께 제안해 주세요.
```

추가 팁:

- GitHub Copilot Chat / PR Review 에서도 동일하게 첫 줄에 한국어 리뷰 요청을 명시한다.
- Codex 기반 리뷰에서도 동일 문구를 반복하면 언어 일관성이 높아진다.

## Roadmap

MVP 너머의 능력 목표 (자동 기억, GitHub Issue 동기화, OpenAPI client 작성 등) 는 [`ROADMAP.md`](./ROADMAP.md) 참고. 한 번에 한 phase 씩 별도 PR 로.
