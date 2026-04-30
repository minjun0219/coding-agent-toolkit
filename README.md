# Agent Toolkit

opencode 전용 plugin. Notion 페이지를 캐시 우선으로 읽는 도구 3 개와, 그 도구를 사용해 한국어 스펙으로 정리하는 skill 1 개를 제공한다. 런타임은 **Bun (>=1.0)** 만 사용하며, 별도 빌드 단계는 없다 (Bun 이 TS 직접 실행).

구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다 — 단일 plugin 파일이 `skills/` 디렉터리를 opencode skill 경로에 등록하고 도구를 노출한다.

## 디렉터리

```
.
├── .opencode/
│   ├── INSTALL.md                  # opencode 사용자용 설치 안내
│   └── plugins/
│       ├── agent-toolkit.ts        # plugin entrypoint + 도구 3 개
│       └── agent-toolkit.test.ts
├── lib/
│   ├── notion-cache.ts             # TTL 파일 캐시 + key 정규화 + normalize
│   └── notion-cache.test.ts
├── skills/
│   └── notion-spec-reader/SKILL.md # Notion → 한국어 스펙 정리 skill
├── .mcp.json                        # context7 MCP 등록 (개발 보조용)
├── package.json / tsconfig.json
├── AGENTS.md / CLAUDE.md
└── README.md
```

> 다른 host (Claude Code, Cursor, Codex CLI) 호환은 후속 작업 — 필요 시 Superpowers 처럼 `.claude-plugin/`, `.cursor-plugin/` 디렉터리를 추가하면 된다. 지금은 opencode 전용.

## 설치 / 사용

`opencode.json` 의 `plugin` 배열에 추가하고 opencode 를 재시작:

```json
{ "plugin": ["agent-toolkit@git+https://github.com/<owner>/coding-agent-toolkit.git"] }
```

자세한 환경변수 / 검증 흐름은 [`.opencode/INSTALL.md`](./.opencode/INSTALL.md) 참고.

## 환경변수

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | ✅ | remote Notion MCP base URL (`POST {url}/getPage` 가정) |
| `AGENT_TOOLKIT_NOTION_MCP_TOKEN` | ⛔️ | bearer token |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | ⛔️ | 기본 `15000` |
| `AGENT_TOOLKIT_CACHE_DIR` | ⛔️ | 기본 `.agent-cache/notion/pages` |
| `AGENT_TOOLKIT_CACHE_TTL` | ⛔️ | 초 단위, 기본 `86400` |

## 도구

plugin 이 opencode 에 다음 3 개를 등록한다:

| 도구 | 동작 |
| --- | --- |
| `notion_get` | 캐시 우선. hit 면 즉시 반환, miss 면 remote MCP 호출 → id 검증 → 캐시 저장 |
| `notion_refresh` | 캐시 무시하고 remote 강제 fetch → id 검증 → 캐시 갱신 |
| `notion_status` | 캐시 메타(저장 시각, TTL, 만료 여부) 만 조회. remote 호출 없음 |

`input` 파라미터는 page id 또는 Notion URL 모두 허용.

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
