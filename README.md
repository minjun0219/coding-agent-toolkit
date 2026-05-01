# Agent Toolkit

opencode 전용 plugin. Notion 페이지를 캐시 우선으로 읽는 도구 3 개, OpenAPI / Swagger JSON 을 캐시 우선으로 가져와 endpoint 검색·환경별 등록 관리까지 해 주는 도구 5 개, 그 도구들을 묶어 컨텍스트 / 한국어 스펙 / `fetch`·`axios` 호출 코드로 정리하는 skill 2 개, 그리고 회사 컨텍스트를 들고 있는 업무 파트너 agent 1 개(`rocky`) 를 제공한다. OpenAPI 쪽은 host(API 묶음) → env(dev/staging/prod) → spec(개별 API) 3-단계 레지스트리를 `agent-toolkit.json` 으로 선언하면 `host:env:spec` handle 로 직접 호출 가능. Notion 은 시작 소스이고, 회사 지식 표면은 이후 더 넓혀질 수 있다. 런타임은 **Bun (>=1.0)** 만 사용하며, 별도 빌드 단계는 없다 (Bun 이 TS 직접 실행).

구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다 — 단일 plugin 파일이 `skills/` / `agents/` 디렉터리를 opencode 탐색 경로에 등록하고 도구를 노출한다. `rocky` 의 캐릭터/네이밍 컨벤션은 [code-yeongyu/oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) 의 named-specialist 패턴에서 빌렸지만, 책임은 회사 컨텍스트 파트너 한 줄로 한정한다.

## 디렉터리

```
.
├── .opencode/
│   ├── INSTALL.md                  # opencode 사용자용 설치 안내
│   └── plugins/
│       ├── agent-toolkit.ts        # plugin entrypoint + 도구 8 개 (notion 3 + swagger 5)
│       └── agent-toolkit.test.ts
├── lib/
│   ├── notion-context.ts           # Notion TTL 파일 캐시 + key 정규화 + normalize
│   ├── notion-context.test.ts
│   ├── openapi-context.ts          # OpenAPI TTL 파일 캐시 + endpoint 검색
│   ├── openapi-context.test.ts
│   ├── openapi-registry.ts         # host:env:spec 핸들 / 스코프 해석 + 평면화
│   ├── openapi-registry.test.ts
│   ├── toolkit-config.ts           # agent-toolkit.json 로더 (project > user 우선순위)
│   └── toolkit-config.test.ts
├── skills/
│   ├── notion-context/SKILL.md     # Notion 캐시 우선 읽기 + 한국어 스펙 정리 skill
│   └── openapi-client/SKILL.md     # 캐시된 OpenAPI spec → fetch / axios 호출 코드 skill
├── agents/
│   └── rocky.md                    # 회사 컨텍스트 업무 파트너 (mode: all, Notion 시작)
├── agent-toolkit.schema.json        # agent-toolkit.json 의 JSON Schema (IDE 자동완성용)
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
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | remote Notion 호출 timeout (ms) |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.config/opencode/agent-toolkit/notion-pages` | Notion 페이지 캐시 디렉터리 |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | Notion 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `~/.config/opencode/agent-toolkit/openapi-specs` | OpenAPI / Swagger spec 캐시 디렉터리 |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `86400` | OpenAPI 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS` | `30000` | OpenAPI spec 다운로드 timeout (ms) |

## 도구

plugin 이 opencode 에 다음 7 개를 등록한다.

### Notion (`notion_*`)

| 도구 | 동작 |
| --- | --- |
| `notion_get` | 캐시 우선. hit 면 즉시 반환, miss 면 remote MCP 호출 → id 검증 → 캐시 저장 |
| `notion_refresh` | 캐시 무시하고 remote 강제 fetch → id 검증 → 캐시 갱신 |
| `notion_status` | 캐시 메타(저장 시각, TTL, 만료 여부) 만 조회. remote 호출 없음 |

`input` 파라미터는 page id 또는 Notion URL 모두 허용.

### OpenAPI / Swagger (`swagger_*`)

| 도구 | 동작 |
| --- | --- |
| `swagger_get` | 캐시 우선. hit 면 즉시 반환, miss 면 spec URL 을 GET 으로 다운로드 → JSON / shape 검증 → 캐시 저장 |
| `swagger_refresh` | 캐시 무시하고 spec URL 에서 강제 다운로드 → 검증 → 캐시 갱신 |
| `swagger_status` | 캐시 메타(저장 시각, TTL, 만료 여부, title, endpointCount) 만 조회. remote 호출 없음 |
| `swagger_search` | 캐시된 spec 들을 가로질러 path / method / tag / operationId / summary 를 substring 으로 검색. `scope` 로 host / host:env / host:env:spec 범위 제한 가능. remote 호출 없음 |
| `swagger_envs` | `agent-toolkit.json` 의 `openapi.registry` 트리를 `[{ host, env, spec, url }]` 로 평면화해서 반환. remote 호출 없음 |

`swagger_get` / `swagger_refresh` / `swagger_status` 의 `input` 은 다음 중 하나를 받는다.

- spec URL (`https://…` / `file://…`)
- 이미 캐시된 16-hex 디스크 key (메타에서 URL 복구)
- `agent-toolkit.json` 에 등록된 `host:env:spec` handle (registry 가 URL 로 해석)

`swagger_search` 는 `query: string`, `limit?: number` (기본 20), `scope?: string` (host / host:env / host:env:spec — registry 안에 등록되어야 한다). YAML spec 은 MVP 에서 미지원 — JSON 만 받는다.

## Config (`agent-toolkit.json`)

OpenAPI registry 를 선언하면 `swagger_*` 도구를 URL 대신 `host:env:spec` handle 로 호출할 수 있다. 우선순위는 **project > user**:

1. `./.opencode/agent-toolkit.json` (프로젝트 로컬)
2. `~/.config/opencode/agent-toolkit/agent-toolkit.json` (사용자 단위) — `AGENT_TOOLKIT_CONFIG` 로 경로 override

같은 leaf (`host:env:spec`) 가 양쪽에 있으면 project 가 이긴다. 새 host / env / spec 은 project 에서 추가 가능.

스키마는 [`agent-toolkit.schema.json`](./agent-toolkit.schema.json) — VS Code 등 JSON Schema-aware 에디터는 `$schema` 만 박아 두면 자동완성 / 검증을 해 준다.

```jsonc
// ~/.config/opencode/agent-toolkit/agent-toolkit.json
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/coding-agent-toolkit/main/agent-toolkit.schema.json",
  "openapi": {
    "registry": {
      "acme": {
        "dev":  { "users": "https://dev.acme.example/users/openapi.json",
                  "orders": "https://dev.acme.example/orders/openapi.json" },
        "prod": { "users": "https://api.acme.example/users/openapi.json" }
      }
    }
  }
}
```

`host` / `env` / `spec` 식별자는 `^[a-zA-Z0-9_-]+$` — 콜론은 handle separator 로 예약. URL 은 비어 있지 않은 문자열이어야 한다 (YAML 는 후속 이슈에서 다룬다).

## Agent

| 이름 | mode | 역할 |
| --- | --- | --- |
| `rocky` | all | 회사 컨텍스트 업무 파트너. 회사 스펙/요구사항/컨벤션/내부 문서를 들고 있고 모호한 요청에는 어느 페이지인지 되묻는다. 받은 포인터로 cached markdown(컨텍스트) 또는 한국어 스펙(스펙) 반환. Notion 이 현재 소스. 코드 작성/구현은 호출자 책임. |

`mode: all` 이라 사용자 직접 호출(primary, Tab 사이클)과 다른 primary agent (e.g. OmO Sisyphus) 의 위임(subagent) 둘 다 가능. 다른 agent 는 turn 시작 시 받는 subagent 목록의 `description` 만으로 라우팅 — Rocky 의 존재를 system prompt 에 박지 않아도 회사 컨텍스트 관련 요청이 알아서 들어온다.

## 캐시 구조

### Notion (`AGENT_TOOLKIT_CACHE_DIR`)

```
<AGENT_TOOLKIT_CACHE_DIR>/
  <pageId>.json   # 메타데이터: pageId, url, cachedAt, ttlSeconds, contentHash, title
  <pageId>.md     # normalize 된 markdown 본문
```

`.json` 또는 `.md` 한쪽이 누락되면 `notion_status` 와 `notion_get` 모두 cache miss 로 본다.

### OpenAPI (`AGENT_TOOLKIT_OPENAPI_CACHE_DIR`)

```
<AGENT_TOOLKIT_OPENAPI_CACHE_DIR>/
  <key>.json        # 메타데이터: key, specUrl, cachedAt, ttlSeconds, specHash, title, version, openapi, endpointCount
  <key>.spec.json   # 다운로드한 OpenAPI document (parsed → re-stringified)
```

`<key>` 는 `sha256(specUrl)` 의 앞 16자 hex. `.json` 또는 `.spec.json` 한쪽이 누락되면 `swagger_status` / `swagger_get` 모두 cache miss 로 본다.

## 개발

```bash
bun install
bun test          # lib/ + .opencode/plugins/ 단위 테스트
bun run typecheck
```

## Roadmap

MVP 너머의 능력 목표 (자동 기억, GitHub Issue 동기화, OpenAPI client 작성 등) 는 [`ROADMAP.md`](./ROADMAP.md) 참고. 한 번에 한 phase 씩 별도 PR 로.
