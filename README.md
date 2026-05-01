# Agent Toolkit

opencode 전용 plugin. Notion 페이지를 캐시 우선으로 읽는 도구 3 개, OpenAPI / Swagger JSON 을 캐시 우선으로 가져와 endpoint 검색·환경별 등록 관리까지 해 주는 도구 5 개, turn 단위 결정 / blocker / 사용자 답변을 append-only 로 적재하고 다음 turn 에 인용 가능하게 하는 저널 도구 4 개, 그 도구들을 묶어 컨텍스트 / 한국어 스펙 / `fetch`·`axios` 호출 코드 / Notion ↔ project-local SPEC 합의 lifecycle 로 정리하는 skill 3 개 (`notion-context`, `openapi-client`, `spec-pact`), 그리고 프론트엔드 전문성을 가진 풀스택 업무 파트너이자 agent-toolkit 의 1차 지휘자인 primary agent 1 개 (`rocky`) + SPEC 합의 lifecycle 의 finalize/lock 권한자인 sub-agent 1 개 (`grace`) 를 제공한다. OpenAPI 쪽은 host(API 묶음) → env(dev/staging/prod) → spec(개별 API) 3-단계 레지스트리를 `agent-toolkit.json` 으로 선언하면 `host:env:spec` handle 로 직접 호출 가능. SPEC 쪽은 `.agent/specs/INDEX.md` 를 LLM-wiki 컨셉을 빌린 wiki-style entry point 로 두고 본문은 `.agent/specs/<slug>.md` (slug 모드) 또는 `**/SPEC.md` (directory 모드, AGENTS.md 스타일) 둘 다 인정. Notion 은 시작 소스이고, 작업 컨텍스트의 표면은 이후 더 넓혀질 수 있다. 런타임은 **Bun (>=1.0)** 만 사용하며, 별도 빌드 단계는 없다 (Bun 이 TS 직접 실행).

구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다 — 단일 plugin 파일이 `skills/` / `agents/` 디렉터리를 opencode 탐색 경로에 등록하고 도구를 노출한다. `rocky` 의 캐릭터/네이밍 컨벤션은 [code-yeongyu/oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) 의 named-specialist 패턴에서 빌렸고, `grace` 는 [Project Hail Mary](https://en.wikipedia.org/wiki/Project_Hail_Mary) 의 Ryland Grace (Rocky 의 인간 파트너) 에서 따왔다 — toolkit 안에서는 역할이 뒤집혀 Rocky 가 1차 지휘자, Grace 가 SPEC lifecycle 담당. 책임은 agent-toolkit 1차 지휘 / SPEC 합의 lifecycle / 필요 시 외부 sub-agent / skill 위임 세 줄로 한정한다.

> 개인 프로젝트라 유지보수가 꾸준하지 않을 수 있다.

## 요구사항

- [Bun](https://bun.sh) `>=1.0` (Node.js 미지원 — Bun 이 TS 를 직접 실행하므로 별도 빌드 단계가 없다)
- [opencode](https://opencode.ai) (다른 host — Claude Code / Cursor / Codex CLI — 는 MVP scope 밖)
- (선택) Notion 페이지를 다룰 경우 opencode 에 [Notion remote MCP](https://developers.notion.com/docs/mcp) 가 OAuth 로 연결되어 있어야 한다

## 디렉터리

```
.
├── .opencode/
│   ├── INSTALL.md                  # opencode 사용자용 설치 안내
│   └── plugins/
│       ├── agent-toolkit.ts        # plugin entrypoint + 도구 12 개 (notion 3 + swagger 5 + journal 4)
│       └── agent-toolkit.test.ts
├── lib/
│   ├── notion-context.ts           # Notion TTL 파일 캐시 + key 정규화 + normalize
│   ├── notion-context.test.ts
│   ├── openapi-context.ts          # OpenAPI TTL 파일 캐시 + endpoint 검색
│   ├── openapi-context.test.ts
│   ├── openapi-registry.ts         # host:env:spec 핸들 / 스코프 해석 + 평면화
│   ├── openapi-registry.test.ts
│   ├── toolkit-config.ts           # agent-toolkit.json 로더 (project > user 우선순위)
│   ├── toolkit-config.test.ts
│   ├── agent-journal.ts            # turn 단위 결정/blocker/사용자 답변 append-only JSONL 저널
│   └── agent-journal.test.ts
├── skills/
│   ├── notion-context/SKILL.md     # Notion 캐시 우선 읽기 + 한국어 스펙 정리 skill
│   ├── openapi-client/SKILL.md     # 캐시된 OpenAPI spec → fetch / axios 호출 코드 skill
│   └── spec-pact/SKILL.md          # Notion ↔ project-local SPEC 합의 lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND)
├── agents/
│   ├── rocky.md                    # 풀스택 업무 파트너 / agent-toolkit 1차 지휘자 (mode: all)
│   └── grace.md                    # SPEC 합의 lifecycle sub-agent / spec-pact 의 finalize/lock 권한자 (mode: subagent)
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
| `AGENT_TOOLKIT_JOURNAL_DIR` | `~/.config/opencode/agent-toolkit/journal` | 에이전트 저널 디렉터리 (안에 단일 `journal.jsonl` 파일) |

## 도구

plugin 이 opencode 에 다음 12 개를 등록한다.

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

### Journal (`journal_*`)

turn / session 경계를 넘는 에이전트 메모. 캐시와 달리 **append-only** 이고 만료가 없다 — "다음 turn 에 인용해야 할 결정 / blocker / 사용자 답변" 을 한 줄(JSONL) 씩 적재한다.

| 도구 | 동작 |
| --- | --- |
| `journal_append` | 한 항목 append. (content 필수, kind?: `decision`/`blocker`/`answer`/`note` 등 자유 문자열·기본 `note`, tags?: 문자열 배열, pageId?: Notion page id/URL — 입력 시 `8-4-4-4-12` 형식으로 정규화 후 저장) |
| `journal_read` | 최근 항목부터 필터/limit 적용해 반환. (limit?: 기본 20, kind?, tag?, pageId?: page-key 기반 lookup, since?: ISO8601 — 그 시각 이후만) |
| `journal_search` | content / kind / tags / pageId 를 substring (case-insensitive) 매칭. (query 필수, limit?, kind?) |
| `journal_status` | 파일 경로 / 존재 여부 / 유효 항목 수 (손상 라인 제외) / 바이트 / 마지막 항목 시각만 조회 |

손상 / 부분 쓰기 라인은 read 단계에서 자동 skip — 한 줄이 깨져도 다음 turn 의 read 가 throw 하지 않고 나머지를 반환한다.

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

SPEC-합의 lifecycle (grace + spec-pact) 의 storage 위치도 같은 파일에서 잡는다 — 모두 optional, 기본값을 바꿔야 할 때만 선언:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/coding-agent-toolkit/main/agent-toolkit.schema.json",
  "spec": {
    "dir": ".agent/specs",      // slug-mode SPEC + INDEX 가 사는 디렉터리
    "scanDirectorySpec": true,  // **/SPEC.md (AGENTS.md 스타일) 도 INDEX 에 surface
    "indexFile": "INDEX.md"     // <dir>/<indexFile>
  }
}
```

`spec.dir` / `spec.indexFile` 은 빈 문자열 금지, `spec.scanDirectorySpec` 은 boolean. 같은 leaf 는 project (`./.opencode/agent-toolkit.json`) 가 user 를 덮어쓴다.

## Agents

| 이름 | mode | 역할 |
| --- | --- | --- |
| `rocky` | all | 프론트엔드 전문성을 가진 풀스택 업무 파트너 / agent-toolkit 1차 지휘자. Notion URL·page id, OpenAPI spec URL·16-hex 키·`host:env:spec` 핸들을 받아 `notion-context` / `openapi-client` 중 하나로 라우팅, SPEC 합의 lifecycle 키워드 ("스펙 합의" / "SPEC 작성" / "SPEC 검증" / "SPEC drift" / "기획문서 변경 반영") 면 `@grace` 로 즉시 위임 (passthrough). 모호하면 어느 surface 인지 되묻는다. 출력은 cached markdown(컨텍스트) / 한국어 스펙 / `fetch`·`axios` snippet / `@grace` 결과 / 위임된 sub-agent 결과 중 하나. 작업이 toolkit 범위를 넘으면 외부 sub-agent / skill 에 위임 가능. **직접** multi-step 구현(코드 작성·리팩터·다파일 변경)은 안 함, **`spec-pact` 의 4 모드도 직접 안 굴림 — `@grace` 책임**. |
| `grace` | subagent | SPEC 합의 lifecycle 의 단일 finalize/lock 권한자. `spec-pact` 스킬을 conduct — DRAFT (Notion → 합의 → SPEC write + INDEX 갱신), VERIFY (SPEC 의 합의 TODO / API 의존성 체크리스트화), DRIFT-CHECK (`source_content_hash` vs `notion_get(pageId).entry.contentHash`), AMEND (drift 항목별 keep / update / reject → SPEC patch + version bump). wiki-style entry point 는 `<spec.dir>/<spec.indexFile>` (default `.agent/specs/INDEX.md`). SPEC 본체는 `<spec.dir>/<slug>.md` (slug 모드, default `.agent/specs/<slug>.md`) 또는 `**/SPEC.md` (directory 모드, AGENTS.md 스타일). 직접 호출 (`@grace …`) 또는 Rocky 라우팅으로 들어옴. 외부 에이전트가 협의에 참여해도 SPEC frontmatter / INDEX 는 grace 만 쓴다. |

Rocky 는 `mode: all` 이라 사용자 직접 호출(primary, Tab 사이클)과 다른 primary agent 의 위임(subagent) 둘 다 가능. Grace 는 `mode: subagent` 라 Rocky / 외부 primary / 사용자가 명시적으로 `@grace` 로 호출할 때만 동작. agent frontmatter 에 `model:` 을 박지 않아 사용자가 opencode 세션에서 고른 기본 모델을 그대로 사용한다. 다른 agent 는 turn 시작 시 받는 subagent 목록의 `description` 만으로 라우팅 — Rocky / Grace 의 존재를 system prompt 에 박지 않아도 toolkit-shaped / 작업 컨텍스트 / SPEC lifecycle 관련 요청이 알아서 들어온다. OmO (Sisyphus) / Superpowers 같은 외부 primary agent 가 환경에 있으면 Rocky / Grace 가 자연스럽게 그 위임 대상으로 잡히지만 — **외부 primary 는 토킷의 필수 조건이 아니라 같이 있을 때 시너지가 나는 옵션**이다.

### SPEC layout (`spec-pact` + `grace`)

```
.agent/specs/
├── INDEX.md          # wiki-style entry point — slug / title / source / status / version / sections / path / tags
├── user-auth.md      # slug 모드 (default)
└── ...

apps/web/orders/
└── SPEC.md           # directory 모드 (AGENTS.md 스타일) — INDEX 가 같이 surface
```

`INDEX.md` 는 lifecycle 전이 (DRAFT / AMEND 직후, VERIFY 결과 all-pass 시, DRIFT-CHECK 결과 drift 발견 시) 마다 grace 가 자동 재생성. SPEC 본체의 frontmatter `source_page_id` 가 두 위치 (slug + directory) 에서 일치하면 INDEX 는 두 path 를 한 줄로 surface 하고 caller 결정을 기다린다 — 자동 정리 X.

저널의 SPEC lifecycle 이벤트는 신규 reserved kind **4 종** (`spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result`) 을 사용하고, DRIFT-CHECK clean 케이스는 기존 `note` kind 를 재사용해 `tags: ["spec-pact","drift-clear"]` 로 append 한다 (다섯 번째 reserved kind 가 아니라 의도된 reuse). 따라서 lifecycle history 회수는 kind 단독 필터보다 `journal_search "spec-pact"` 같은 tag 기반 조회를 기준으로 잡는다.

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

### Journal (`AGENT_TOOLKIT_JOURNAL_DIR`)

```
<AGENT_TOOLKIT_JOURNAL_DIR>/
  journal.jsonl   # 한 줄 = 한 항목 (id, timestamp, kind, content, tags, pageId?)
```

캐시와 달리 디렉터리 / TTL 모델이 없다 — 저널 자체가 source of truth 이므로 만료 / 무효화 / 덮어쓰기는 일어나지 않는다. 항목 한 줄이 깨져도 read 단계에서 그 줄만 skip 된다.

## 개발

```bash
bun install
bun test               # lib/ + .opencode/plugins/ 단위 + 통합 테스트
bun run typecheck
bun run lint:comments  # JSDoc + 한글 주석 정책 검증 (tools/check-comments.ts)
```

## Roadmap

MVP 너머의 능력 목표 (자동 기억, GitHub Issue 동기화, OpenAPI client 작성 등) 는 [`ROADMAP.md`](./ROADMAP.md) 참고. 한 번에 한 phase 씩 별도 PR 로.
