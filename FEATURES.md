# Agent Toolkit — Features

> 이 toolkit 이 노출하는 표면을 한 페이지로 정리한 사람용 카탈로그.
> 대상: GitHub 에서 훑어 보는 사람, 그리고 grep / anchor 로 인용하는 에이전트 (Claude Code / opencode / codex / …).
> 이 파일이 **사람용 단일 source of truth** 다 (한국어). 에이전트용 단일 source 는 [`AGENTS.md`](./AGENTS.md) (영문). 표면이 바뀌면 두 파일을 같이 갱신한다.

## 한 눈에

- **호스트**: Claude Code 가 1차 host — `server/index.ts` 가 `.claude-plugin/plugin.json` + `.mcp.json` 으로 17 tool 노출. opencode 가 2차 host — `.opencode/plugins/agent-toolkit-server.ts` 가 27 tool 노출. v0.2 부터 `bin/openapi-mcp` 가 3차 standalone host — agent-toolkit 의 다른 lib 없이 OpenAPI 7 tool 만 띄운다 (구 `openapi-mcp-server` 흡수). 모두 같은 `skills/` + `agents/` 트리, 같은 `lib/openapi/` 라이브러리를 공유한다.
- **Claude Code surface (17 tool, 1차)**: `openapi_*` (7 — `get` / `refresh` / `status` / `search` / `envs` / `endpoint` / `tags`) + `journal_*` (4) + `mysql_*` (5) + `spec_pact_fragment` (1).
- **opencode-only (10 tool, 제거 후보)**: `notion_*` ×4 + `pr_*` ×6. 자세한 매트릭스는 [`AGENTS.md`](./AGENTS.md) 의 *MVP scope → Removal candidates* 절 참고.
- **스킬 5 개** (`notion-context`, `openapi-client`, `mysql-query`, `spec-pact`, `pr-review-watch`).
- **에이전트 3 명** (`rocky` / `grace` / `mindy`).
- **설정 파일 1 개** — `agent-toolkit.json` (project 의 `./.opencode/agent-toolkit.json` 이 user 의 `~/.config/opencode/agent-toolkit/agent-toolkit.json` 을 leaf 단위로 덮어쓴다).
- **런타임**: Bun ≥ 1.0. 빌드 단계 없음 (Bun 이 TS 직접 실행).
- **GitHub 전송 정책**: 쓰기는 사용자 `gh` CLI, PR 라이브 상태는 외부 GitHub MCP, `pr_*` 큐는 저널 only. toolkit 은 GitHub 토큰을 저장하지 않으며 PR 코멘트용 GitHub API 도 직접 호출하지 않는다.

각 도구 entry 는 한 블록으로 인용할 수 있도록 6-필드 형식을 따른다:

```
What           — 동작 한두 줄
Input          — 필수 + 선택 파라미터
Output         — 반환값의 최상위 shape
Owner          — 이 도구를 conduct 하는 스킬 / 에이전트
Side effects   — 디스크 / 네트워크 영향 (없으면 "none")
Related config — 이 도구가 읽는 env 변수 + agent-toolkit.json 키
```

## 도구

### Notion 캐시 (`notion_*`)

사용자의 Notion 을 Notion remote MCP (OAuth 인증) 통해 단일 페이지·캐시 우선으로 읽는다. 데이터베이스 쿼리와 child-page 순회는 MVP 범위 밖.

#### `notion_get`

- **What**: Notion 단일 페이지 캐시 우선 read. hit 면 즉시 반환, miss 면 remote MCP 호출 → page id 검증 → 캐시 저장.
- **Input**: `input` — Notion page id 또는 페이지 URL.
- **Output**: `NotionPageResult` — `{ entry: { pageId, url, cachedAt, ttlSeconds, contentHash, title }, markdown, fromCache }`. (`fromCache: true` 면 hit, `false` 면 miss.)
- **Owner**: `notion-context` 스킬 (rocky 가 conduct). `spec-pact` 의 DRAFT / DRIFT-CHECK 도 호출.
- **Side effects**: miss 시 `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}` 작성.
- **Related config**: `AGENT_TOOLKIT_NOTION_MCP_URL`, `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS`, `AGENT_TOOLKIT_CACHE_DIR`, `AGENT_TOOLKIT_CACHE_TTL`.

#### `notion_refresh`

- **What**: 캐시 무시하고 remote MCP 에서 강제 재다운로드 → page id 검증 → 캐시 갱신.
- **Input**: `input` — Notion page id 또는 페이지 URL.
- **Output**: `notion_get` 과 같은 `NotionPageResult` shape, 항상 `fromCache: false`.
- **Owner**: `notion-context` 스킬.
- **Side effects**: `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}` 재작성.
- **Related config**: `notion_get` 와 동일.

#### `notion_status`

- **What**: 단일 페이지 캐시 메타만 조회. remote 호출 없음.
- **Input**: `input` — Notion page id 또는 페이지 URL.
- **Output**: `NotionCacheStatus` — `{ pageId, exists, expired, cachedAt?, ttlSeconds?, ageSeconds?, title? }`. 옵셔널 필드는 캐시 파일이 존재할 때만 채워진다.
- **Owner**: `notion-context` 스킬.
- **Side effects**: 없음.
- **Related config**: `AGENT_TOOLKIT_CACHE_DIR`.

#### `notion_extract`

- **What**: 캐시 우선 read 후 Notion markdown 을 heading 기반으로 chunk 화하고 구현 액션 후보 (`requirements` / `screens` / `apis` / `todos` / `questions`) 를 추출.
- **Input**: `input` — Notion page id 또는 페이지 URL. 옵셔널 `maxCharsPerChunk: number` (기본 1400).
- **Output**: `NotionExtractResult` — `{ entry, fromCache, chunkCount, chunks, extracted: { requirements, screens, apis, todos, questions } }`. 키 이름은 `candidates` 가 아니라 **`extracted`** 다.
- **Owner**: `notion-context` 스킬 (한국어 스펙 모드), `spec-pact` 의 DRAFT 모드.
- **Side effects**: miss 시 `notion_get` 과 같은 캐시 작성, 그 외 없음.
- **Related config**: `notion_get` 와 동일.

### OpenAPI / Swagger (`openapi_*`)

OpenAPI 3.x / Swagger 2.0 spec 의 캐시 우선 read (swagger 2.0 → 3.0 자동 변환 + `$ref` deref), 점수화 endpoint 검색, `host:env:spec` 레지스트리. v0.2 부터 (구) `openapi-mcp-server` 의 코어를 흡수해 `lib/openapi/` 한 곳에서 관리한다 — agent-toolkit MCP / opencode plugin / 단독 `openapi-mcp` (3차 host) 가 모두 이 라이브러리를 공유한다.

config leaf 는 두 형태를 받는다:
- **string** — URL 만. baseUrl 없음 → `openapi_endpoint` 의 `fullUrl` 은 path 자체.
- **object** — `{ url, baseUrl?, format? }`. baseUrl 이 있으면 `openapi_endpoint` 의 `fullUrl` = `<baseUrl><path>`. format 으로 `openapi3` / `swagger2` / `auto` 강제 가능.

#### `openapi_get`

- **What**: spec 을 캐시 우선으로 적재. swagger 2.0 은 자동으로 OpenAPI 3.0 으로 변환되고 `$ref` 는 모두 deref 된다. hit 면 메모리 캐시, 만료된 hit 면 stale 반환 + 백그라운드 conditional GET, miss 면 fetch + parse + index + 캐시 저장.
- **Input**: `input` — spec URL (`https://…` / `http://…` / `file://…`) 또는 `agent-toolkit.json` 에 등록된 `host:env:spec` 핸들.
- **Output**: `SwaggerGetResult` — `{ spec, environment, fromCache, document, baseUrl? }`. `document` 는 deref 완료된 OpenAPI 3.x 문서. `spec` 은 flatten 된 내부 이름 (`host:env:spec` 또는 `url:<sha1-16>`, 예: `acme:dev:users`, `url:0123abcd…`).
- **Owner**: `openapi-client` 스킬 (rocky 가 conduct).
- **Side effects**: miss 시 `<AGENT_TOOLKIT_OPENAPI_CACHE_DIR>/<sha1-16>.json` 작성 (schemaVersion 1).
- **Related config**: `AGENT_TOOLKIT_OPENAPI_CACHE_DIR`, `AGENT_TOOLKIT_OPENAPI_CACHE_TTL`, `agent-toolkit.json` 의 `openapi.registry`.

#### `openapi_refresh`

- **What**: 메모리 + 디스크 캐시를 비우고 spec 을 강제 재다운로드. conditional GET 사용 안 함.
- **Input**: `input` — `openapi_get` 과 동일.
- **Output**: `RefreshOutcome[]` — `[{ spec, success, fetchedAt?, error? }]`.
- **Owner**: `openapi-client` 스킬.
- **Related config**: `openapi_get` 와 동일.

#### `openapi_status`

- **What**: 캐시 메타만 조회 (cached / fetchedAt / ttlSeconds / environments). remote 호출 없음.
- **Input**: `input` — `openapi_get` 과 동일.
- **Output**: `SpecSummary` — `{ name, description?, environments, cacheStatus: { cached, fetchedAt?, ttlSeconds } }`.

#### `openapi_search`

- **What**: 캐시된 spec 들을 가로질러 endpoint 점수화 검색. 점수: `operationId`(4) > `path`(3) > `summary`(2) > `description`(1). `scope` 로 host / `host:env` / `host:env:spec` 범위 제한 가능. 빈 query 는 limit 까지 모두 나열.
- **Input**: `query: string`, `limit?: number` (기본 20), `scope?: string`.
- **Output**: `SwaggerSearchMatch[]` — `[{ spec, operationId, method, path, summary?, tags?, deprecated }]`.

#### `openapi_envs`

- **What**: `agent-toolkit.json` 의 `openapi.registry` 트리를 평면화. baseUrl / format 이 leaf 에 선언돼 있으면 함께 반환.
- **Output**: `OpenapiRegistryEntry[]` — `[{ host, env, spec, url, baseUrl?, format? }]`. registry 가 비어 있으면 빈 배열.

#### `openapi_endpoint` (v0.2 신규)

- **What**: 단일 endpoint 의 풍부한 detail (parameters / requestBody / responses / examples / fullUrl) 를 반환. `fullUrl` 은 leaf 의 `baseUrl` + path 합성 — baseUrl 이 비어 있으면 path 자체.
- **Input**: `input` — `openapi_get` 과 동일. **그리고** `operationId` 단독, 또는 `method` + `path` 페어 둘 중 하나 필수.
- **Output**: `SwaggerEndpointResult` — `{ spec, environment, endpoint: EndpointDetail }`.
- **Side effects**: 없음 (캐시 read).

#### `openapi_tags` (v0.2 신규)

- **What**: spec 의 OpenAPI tag 목록 + 각 tag 의 endpoint 개수.
- **Input**: `input` — `openapi_get` 과 동일.
- **Output**: `SwaggerTagsResult` — `{ spec, environment, tags: [{ name, description?, endpointCount }] }`.

### 저널 (`journal_*`)

turn 경계를 넘는 에이전트 메모. JSONL append-only, TTL 없음. "다음 turn 에 인용해야 할 결정 / blocker / 사용자 답변" 을 기록한다. read 단계에서 손상 라인은 자동 skip.

#### `journal_append`

- **What**: 한 항목 append.
- **Input**: `content: string` (필수), `kind?: string` (`decision` / `blocker` / `answer` / `note` 등 자유 문자열, 기본 `note`), `tags?: string[]`, `pageId?: string` (Notion page id 또는 URL — 입력 시 `8-4-4-4-12` 형식으로 정규화 후 저장).
- **Output**: append 된 `JournalEntry` — `{ id, timestamp, kind, content, tags, pageId? }`.
- **Owner**: `rocky` (일반 사용), 그리고 lifecycle 이벤트를 기록하는 스킬 (`spec-pact`, `pr-review-watch`).
- **Side effects**: `<AGENT_TOOLKIT_JOURNAL_DIR>/journal.jsonl` 에 한 줄 append.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_read`

- **What**: 최근 항목부터 필터 / limit 적용해 반환.
- **Input**: `limit?: number` (기본 20), `kind?: string`, `tag?: string`, `pageId?: string` (page-key lookup), `since?: string` (ISO 8601 — 이후 항목만).
- **Output**: bare `JournalEntry[]` — 래퍼 객체 없음.
- **Owner**: 이전 컨텍스트 회수가 필요한 모든 에이전트 / 스킬.
- **Side effects**: 없음.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_search`

- **What**: `content` / `kind` / `tags` / `pageId` 를 substring (case-insensitive) 으로 매칭.
- **Input**: `query: string`, `limit?: number`, `kind?: string`.
- **Output**: bare `JournalEntry[]` — 래퍼 객체 없음.
- **Owner**: `spec-pact` 의 lifecycle 회수 (`journal_search "spec-pact"`), `pr-review-watch` 의 lifecycle 회수 (`journal_search "pr-watch"`), 그리고 일반 에이전트 사용.
- **Side effects**: 없음.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

#### `journal_status`

- **What**: 파일 경로 / 존재 여부 / 유효 항목 수 (손상 라인 제외) / 바이트 / 마지막 항목 시각만 조회.
- **Input**: 없음.
- **Output**: `JournalStatus` — `{ path, exists, totalEntries, sizeBytes, lastEntryAt? }`.
- **Owner**: 누구나.
- **Side effects**: 없음.
- **Related config**: `AGENT_TOOLKIT_JOURNAL_DIR`.

### MySQL read-only (`mysql_*`)

`agent-toolkit.json` 의 `host:env:db` 핸들 기반 MySQL read-only 검사. INSERT / UPDATE / DELETE / DDL / `SET` / `CALL` / `LOAD` / `INTO OUTFILE` / multi-statement 는 모두 거부. **DB 계정 자체에 `GRANT SELECT` 만 주는 것이 1차 방어선이다.**

#### `mysql_envs`

- **What**: `mysql.connections` 트리를 평면화. **자격증명 *값* 은 노출하지 않고 env 변수 이름만 보여 준다.**
- **Input**: 없음.
- **Output**: bare `MysqlRegistryEntry[]` — `[{ host, env, db, handle, authMode, authEnv, hostName, port, user, database }]`. 래퍼 객체 없음. connections 미구성 시 빈 배열.
- **Owner**: `mysql-query` 스킬 (rocky 가 conduct).
- **Side effects**: 없음 (DB 호출 없음).
- **Related config**: `agent-toolkit.json` 의 `mysql.connections`.

#### `mysql_status`

- **What**: 핸들 해석 → `passwordEnv` / `dsnEnv` 로 connection 구성 → `SELECT 1` ping 한 번.
- **Input**: `handle: string` (`host:env:db`).
- **Output**: `MysqlRegistryEntry & { ok: boolean }` — 위의 `mysql_envs` row 와 같은 메타 + ping 결과 `ok`.
- **Owner**: `mysql-query` 스킬.
- **Side effects**: 대상 서버에 잠시 connection 1 개 오픈.
- **Related config**: `mysql.connections`; `passwordEnv` / `dsnEnv` 가 가리키는 env 변수.

#### `mysql_tables`

- **What**: 해석된 DB 에서 `SHOW FULL TABLES` 실행 — 테이블 / 뷰 목록.
- **Input**: `handle: string`.
- **Output**: bare `Array<{ name: string; type: string }>`. 래퍼 객체 없음. `type` 은 `SHOW FULL TABLES` 가 돌려주는 raw 값 (예: `BASE TABLE` / `VIEW`).
- **Owner**: `mysql-query` 스킬.
- **Side effects**: connection 1 개 오픈 + read 쿼리 1 회.
- **Related config**: `mysql.connections`.

#### `mysql_schema`

- **What**: `table` 미지정 시 현재 DB 의 `INFORMATION_SCHEMA.COLUMNS` 요약. `table` 지정 시 `SHOW CREATE TABLE` + `SHOW INDEX FROM` 합본.
- **Input**: `handle: string`, `table?: string`.
- **Output**: `mode` 로 분기되는 discriminated union. summary 모드 (`table` 없음): `{ mode: "summary", columns: [{ table, column, type, nullable, key, default, extra }] }`. detail 모드 (`table` 지정): `{ mode: "detail", createTable: string, indexes: [{ keyName, column, nonUnique, type }] }`.
- **Owner**: `mysql-query` 스킬.
- **Side effects**: connection 1 개 오픈 + read 쿼리 1~2 회.
- **Related config**: `mysql.connections`.

#### `mysql_query`

- **What**: 단일 read-only SQL 실행. 파이프라인: `assertReadOnlySql(sql)` → `enforceLimit(sql, { limit })` → 실행. 첫 키워드는 `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH` 만 허용. row 반환 statement 에는 `LIMIT` 자동 부착 (기본 100, 절대 상한 1000).
- **Input**: `handle: string`, `sql: string`, `limit?: number`.
- **Output**: `MysqlQueryResult` — `{ sql, rows, columns, rowCount, truncated, effectiveLimit }`. `effectiveLimit` 은 `SHOW` / `DESCRIBE` / `EXPLAIN` 일 때 `null`.
- **Owner**: `mysql-query` 스킬.
- **Side effects**: connection 1 개 오픈 + read 쿼리 1 회.
- **Related config**: `mysql.connections`.

### PR review watch (`pr_*`)

polling-only PR lifecycle. toolkit 은 PR 코멘트용 GitHub API 를 *직접 호출하지 않는다* — PR 메타 / 코멘트 / 답글 / 머지 상태 조회는 사용자 opencode 세션에 별도로 등록된 외부 GitHub MCP 서버 책임. 이 도구들은 로컬 큐와 lifecycle state 만 가진다.

#### `pr_watch_start`

- **What**: PR 핸들을 active watch 로 등록 + `pr_watch_start` 저널 entry 박음 + 갱신된 watch state 반환.
- **Input**: `handle: string` (`owner/repo#NUMBER` 또는 github.com PR URL), `note?: string`, `labels?: string[]`, `mergeMode?: "merge" | "squash" | "rebase"`. `mergeMode` 는 enum 검증 — 외부 값은 throw.
- **Output**: `{ entry: JournalEntry, state: PrWatchState }`. `state` = `{ handle, active, startedAt?, stoppedAt?, note? }`.
- **Owner**: `pr-review-watch` 스킬 (mindy 가 conduct).
- **Side effects**: 저널에 `pr_watch_start` entry append.
- **Related config**: `agent-toolkit.json` 의 `github.repositories`.

#### `pr_watch_stop`

- **What**: watch 종료 + `pr_watch_stop` 저널 entry append + final state 반환.
- **Input**: `handle: string`, `reason?: "merged" | "closed" | "manual"`. `reason` 은 enum 검증 — 자유 문자열은 거부 (저널 `reason:<value>` 태그가 항상 같은 enum 으로만 박혀 회수 / 집계 안정).
- **Output**: `{ entry: JournalEntry, state: PrWatchState }` (`active: false`, `stoppedAt` 채워짐).
- **Owner**: `pr-review-watch` 스킬.
- **Side effects**: 저널에 `pr_watch_stop` entry append.
- **Related config**: `github.repositories`.

#### `pr_watch_status`

- **What**: 저널을 한 번 reduce 해 모든 active watch 와 핸들 별 미처리 이벤트 합계를 반환.
- **Input**: 없음.
- **Output**: `{ active: PrWatchState[], totals: { active: number, pending: number } }`. `pending` 은 모든 active watch 에 걸친 합.
- **Owner**: `pr-review-watch` 스킬.
- **Side effects**: 없음.
- **Related config**: `github.repositories`.

#### `pr_event_record`

- **What**: 외부 GitHub MCP 가 가져온 inbound 이벤트 1 건 (코멘트 / 리뷰 / 리뷰 코멘트 / 체크 / 머지 / 닫힘) 을 큐에 등록. 같은 `(handle, type, externalId)` 가 다시 들어와도 디스크에는 append 되지만 (append-only 원칙), 응답에 `alreadySeen: true` 표시.
- **Input**: `handle: string`, `type: "issue_comment" | "pr_review" | "pr_review_comment" | "check_run" | "status" | "merge" | "close"`, `externalId: string`, `summary: string` (caller 가 정제한 한 줄 요약 — author + 짧은 발췌. 외부 MCP 의 raw payload 는 여기에 저장되지 않는다).
- **Output**: `{ entry: JournalEntry, ref: { type, externalId, toolkitKey }, alreadySeen }`.
- **Owner**: `pr-review-watch` 스킬.
- **Side effects**: 저널에 `pr_event_inbound` entry append.
- **Related config**: `github.repositories`.

#### `pr_event_pending`

- **What**: 한 핸들의 미처리 이벤트 (inbound 가 있고 같은 toolkitKey 의 resolved 가 없는 것) 를 시간 오름차순으로 반환.
- **Input**: `handle: string`.
- **Output**: bare `PendingPrEvent[]` — `[{ handle, ref, receivedAt, summary, inboundEntryId }]`. 래퍼 객체 없음.
- **Owner**: `pr-review-watch` 스킬.
- **Side effects**: 없음.
- **Related config**: `github.repositories`.

#### `pr_event_resolve`

- **What**: 한 inbound 이벤트에 대한 mindy 의 검증 결과를 박음. 외부 GitHub MCP 의 reply id 를 `replyExternalId` 로 함께 박아 다음 polling 의 correlation 에 사용.
- **Input**: `handle: string`, `type: "issue_comment" | "pr_review" | …` (`pr_event_record` 와 같은 enum), `externalId: string`, `decision: "accepted" | "rejected" | "deferred"`, `reasoning: string`, `replyExternalId?: string`. `toolkitKey` 는 핸들러가 `(type, externalId)` 로부터 내부에서 합성한다. 같은 (handle, toolkitKey) 의 `pr_event_inbound` 가 없으면 throw (orphan-resolve 가드).
- **Output**: `{ entry: JournalEntry, resolved: { type, externalId, toolkitKey } }`.
- **Owner**: `pr-review-watch` 스킬 — `pr_event_resolved` entry 의 단독 권한자는 `mindy`.
- **Side effects**: 저널에 `pr_event_resolved` entry append.
- **Related config**: `github.repositories`.

### spec-pact (`spec_pact_fragment`)

`spec-pact` 의 4 모드 본문은 SKILL.md 안에 인라인이 아니라 `<plugin>/skills/spec-pact/fragments/<mode>.md` 별도 파일들로 분리되어 있다. grace 가 모드를 결정한 뒤 한 turn 에 정확히 한 번 호출.

#### `spec_pact_fragment`

- **What**: 한 모드 (`draft` / `verify` / `drift-check` / `amend`) 에 해당하는 fragment markdown 을 plugin 절대경로 (`import.meta.url` 기반) 에서 read. 외부 설치 (`agent-toolkit@git+…`) 환경에서도 사용자 cwd 와 무관하게 동작.
- **Input**: `mode: "draft" | "verify" | "drift-check" | "amend"`.
- **Output**: `{ mode, path, content }`.
- **Owner**: `spec-pact` 스킬 (grace 가 conduct). turn 당 정확히 한 번 호출하도록 설계됨 (두 번째 호출은 fragment 절감 효과 무효).
- **Side effects**: 없음 (plugin install 디렉터리 내부 read).
- **Related config**: 없음.

## 스킬

각 스킬은 작은 도구 묶음을 단계별 prompt 로 감싼다. `skills/<name>/SKILL.md` 에 위치.

### `notion-context`

- **Conducted by**: `rocky`.
- **사용 도구**: `notion_get`, `notion_status`, `notion_refresh`, `notion_extract`.
- **목적**: 캐시 우선 Notion read 를 두 가지 출력 스타일로 제공 — markdown 그대로 LLM 컨텍스트로 넘기거나, 한국어 스펙으로 구조화. Notion URL 입력의 기본값.

### `openapi-client`

- **Conducted by**: `rocky`.
- **사용 도구**: `openapi_get`, `openapi_status`, `openapi_refresh`, `openapi_search`, `openapi_envs`, `openapi_endpoint`, `openapi_tags`.
- **목적**: 캐시된 OpenAPI / Swagger JSON spec 에서 endpoint 1 개를 찾아 `fetch` (기본) 또는 `axios` TypeScript 호출 snippet 을 생성.

### `mysql-query`

- **Conducted by**: `rocky`.
- **사용 도구**: `mysql_envs`, `mysql_status`, `mysql_tables`, `mysql_schema`, `mysql_query`.
- **목적**: read-only MySQL 검사 — env 목록, ping, 테이블 목록, schema 점검, 허용된 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `WITH` 한 줄 실행.

### `spec-pact`

- **Conducted by**: `grace` (단일 finalize / lock 권한자).
- **모드**: `DRAFT` (Notion → 합의 → SPEC write + INDEX 갱신), `VERIFY` (SPEC 의 합의 TODO + API 의존성을 체크리스트화), `DRIFT-CHECK` (SPEC 의 `source_content_hash` vs `notion_get(pageId).entry.contentHash` 비교), `AMEND` (drift 항목별 keep / update / reject → SPEC patch + version bump).
- **사용 도구**: `notion_get`, `notion_extract`, `journal_append`, `journal_read`, `journal_search`, `spec_pact_fragment`, 그리고 opencode 의 `read` / `write` / `edit` / `glob`.
- **저장소**: `<spec.dir>/<spec.indexFile>` (기본 `.agent/specs/INDEX.md`) wiki-style entry point + `<spec.dir>/<slug>.md` (기본 `.agent/specs/<slug>.md`) 그리고/또는 `**/SPEC.md`.
- **lifecycle 저널 kind**: `spec_anchor`, `spec_drift`, `spec_amendment`, `spec_verify_result`. DRIFT-CHECK clean 케이스는 `note` kind 를 재사용 (`tags: ["spec-pact", "drift-clear"]`). 회수는 tag-shaped query `journal_search "spec-pact"` 로.

### `pr-review-watch`

- **Conducted by**: `mindy` (`pr_event_resolved` 단일 권한자). PR URL/handle 만으로는 시작하지 않고, 사용자가 리뷰 확인/코멘트 확인/watch 를 명시한 경우에만 트리거한다.
- **모드**: `WATCH-START`, `PULL`, `VALIDATE`, `WATCH-STOP`.
- **사용 도구**: `pr_watch_start`, `pr_watch_stop`, `pr_watch_status`, `pr_event_record`, `pr_event_pending`, `pr_event_resolve`, `journal_append`, `journal_read`, `journal_search`, opencode 의 `read` / `glob` / `grep`. **외부 GitHub MCP 가 opencode 세션에 등록되어 있어야** mindy 가 PR 메타·코멘트·답글·머지 상태를 가져올 수 있다.
- **PR 핸들**: `owner/repo#NUMBER` 또는 github.com PR URL. 저널 측 핸들은 tag `pr:<canonical>`. `pageId` 슬롯은 의도적으로 사용 안 함 (Notion id 패턴이 아니므로).
- **lifecycle 저널 kind**: `pr_watch_start`, `pr_watch_stop`, `pr_event_inbound`, `pr_event_resolved`. 회수는 `journal_search "pr-watch"` 로.

## 에이전트

각 에이전트의 풀 prompt 와 정확한 도구 / 권한 frontmatter 는 `agents/<name>.md` 에 있다. 아래는 mode / 권한 / 라우팅 룰 요약.

### `rocky`

- **Mode**: `all` (사용자 직접 호출 = primary, 외부 primary 의 위임 = subagent 둘 다 가능).
- **권한**: `edit: deny`, `bash: deny` — rocky 는 코드를 직접 쓰지도, 셸 명령을 직접 실행하지도 않는다.
- **전문**: 프론트엔드 (풀스택 reach).
- **Conducts**: `notion-context`, `openapi-client`, `mysql-query`, 그리고 저널 사용.
- **라우팅**:
  - SPEC 합의 lifecycle 키워드 ("스펙 합의" / "SPEC 작성" / "SPEC 검증" / "SPEC drift" / "기획문서 변경 반영") → `@grace`.
  - PR review watch 명시 키워드 ("PR review" / "리뷰 봐줘" / "리뷰 확인" / "코멘트 확인" / "머지까지 watch" / "리뷰 답글" / "PR drift") + PR 핸들 → `@mindy`. 단순 PR 링크/참고 언급은 watch 를 시작하지 않는다.
  - 다단계 구현 (코드 작성 / 리팩터 / 다파일 변경) → 외부 sub-agent / skill 위임 또는 caller 에게 반환. rocky 가 직접 구현하지 않음.
- **하드 거부**: MySQL 쓰기 / DDL (SQL guard 가 거부), GitHub API 직접 호출 (외부 GitHub MCP 책임).

### `grace`

- **Mode**: `subagent` (`@grace` 직접 호출 또는 rocky 라우팅).
- **권한**: `edit: allow`, `bash: deny`.
- **Conducts**: `spec-pact` end-to-end (DRAFT / VERIFY / DRIFT-CHECK / AMEND).
- **권한**: `<spec.dir>/<spec.indexFile>` 와 SPEC 파일들의 단일 finalize / lock 권한자. 외부 에이전트가 합의에 참여해도 SPEC frontmatter 와 INDEX 는 grace 만 쓴다.
- **범위 밖**: GitHub Issue / PR / 일반 `gh` 호출 (toolkit 밖 — 사용자 / Claude Code / 외부 GitHub MCP 책임), 코드 구현.

### `mindy`

- **Mode**: `subagent` (`@mindy` 직접 호출 또는 rocky 라우팅).
- **권한**: `edit: deny`, `bash: deny` — mindy 는 코드를 편집하지 않고 `gh` / `bun test` / `tsc` / `curl` 도 직접 실행하지 않는다.
- **Conducts**: `pr-review-watch` end-to-end (WATCH-START / PULL / VALIDATE / WATCH-STOP).
- **권한**: `pr_event_resolved` 저널 entry 의 단일 권한자.
- **범위 밖**: PR 생성, PR 머지, 코드 commit, VALIDATE 도중 typecheck / test / lint 실행 (사용자가 실행하고 결과를 한 줄로 mindy 에게 알려 준다).
- **외부 의존성**: 외부 GitHub MCP 서버가 opencode 세션에 등록되어 있어야 PR 메타·코멘트를 가져올 수 있다. toolkit 자체 GitHub HTTP client 는 없다.

## Config (`agent-toolkit.json`)

project (`./.opencode/agent-toolkit.json`) 가 user (`~/.config/opencode/agent-toolkit/agent-toolkit.json` 또는 `$AGENT_TOOLKIT_CONFIG`) 를 leaf 단위로 덮어쓴다. 전체 grammar 는 [`agent-toolkit.schema.json`](./agent-toolkit.schema.json) 에 정의되어 있다 — 에디터 JSON Schema 설정에 이 스키마를 가리키면 자동완성과 검증이 붙는다.

| 키 | 용도 | leaf shape | 비고 |
| --- | --- | --- | --- |
| `openapi.registry` | `host:env:spec` 핸들 → spec URL | `{ [host]: { [env]: { [spec]: "https://…" } } }` | 식별자는 `^[a-zA-Z0-9_-]+$`, URL 은 비어 있지 않은 문자열. YAML 미지원. |
| `spec.dir` / `spec.scanDirectorySpec` / `spec.indexFile` | `spec-pact` 의 SPEC 레이아웃 | `string` / `boolean` / `string` | 기본 `.agent/specs` / `true` / `INDEX.md`. |
| `mysql.connections` | `host:env:db` 핸들 → MySQL 프로파일 | `{ [host]: { [env]: { [db]: { passwordEnv } | { dsnEnv } } } }` | **이 파일에 평문 비밀번호 / DSN 을 박는 것은 loader 가 거부한다.** `passwordEnv` (`host` / `user` / `database` / 선택 `port` 와 함께) 또는 `dsnEnv` (한 줄짜리 `mysql://user:pass@host:port/db` env 변수) 중 정확히 하나만 사용. |
| `github.repositories` | PR review watch 의 `owner/repo` allow-list | `{ [owner/repo]: { alias?, labels?, defaultBranch?, mergeMode? } }` | 키는 `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` (정확히 슬래시 1 개, 예: `minjun0219/agent-toolkit`) — `host:env:spec` / `host:env:db` 의 콜론 핸들과 다른 형식. 토큰 / 시크릿 leaf 는 거부 — 인증은 외부 GitHub MCP. `mergeMode ∈ {"merge", "squash", "rebase"}`. |

## 저장소 레이아웃

| 표면 | 경로 | TTL | 비고 |
| --- | --- | --- | --- |
| Notion 캐시 | `<AGENT_TOOLKIT_CACHE_DIR>/<pageId>.{json,md}` | `AGENT_TOOLKIT_CACHE_TTL` (기본 86400 초) | 두 파일 모두 있어야 hit. 한쪽 누락 시 cache miss 처리. |
| OpenAPI 캐시 | `<AGENT_TOOLKIT_OPENAPI_CACHE_DIR>/<key>.{json,spec.json}` | `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `key = sha256(specUrl)[:16]`. 같은 dual-file 룰. |
| 저널 | `<AGENT_TOOLKIT_JOURNAL_DIR>/journal.jsonl` | 없음 | append-only, 만료 없음. read 단계에서 손상 라인은 skip. |
| SPEC | `<spec.dir>/<spec.indexFile>` + `<spec.dir>/<slug>.md` 그리고/또는 `**/SPEC.md` | 없음 | `grace` 가 단일 writer. |

## 범위 밖 (MVP)

- **Notion 데이터베이스 쿼리** 와 child-page 순회 (단일 페이지 only).
- **MySQL 쓰기 / DDL / multi-statement / 저장 프로시저 호출 / `SET` / `LOAD` / `INTO OUTFILE` / `INTO DUMPFILE`**, MySQL TLS / SSH 터널 옵션, OS keychain 통합.
- 다른 DBMS (Postgres / SQLite / Oracle / MSSQL), MySQL 결과 디스크 캐시.
- OpenAPI YAML 파싱, runtime base-URL override (대신 `spec.servers` 사용), 풀 SDK 코드 생성, multi-spec merge, mock 서버.
- 추가 host 통합 (`.cursor-plugin/`, codex 등) — MVP 는 Claude Code (1차) + opencode (2차) 두 host 만.
- **GitHub webhook 수신 / 이벤트 구독** — `pr-review-watch` 는 polling-only, turn-bound, 스케줄러 없음.
- **`rocky` / `grace` / `mindy` 의 GitHub API 직접 호출 / `gh` CLI 직접 실행** — toolkit 안에는 GitHub 쓰기 surface 가 없다. PR / Issue / 일반 `gh` 호출은 사용자 / Claude Code / 외부 GitHub MCP 책임.
- **`mindy` 의 PR 생성 / 머지** — caller 책임으로 반환.
- **VALIDATE 중 `mindy` 의 typecheck / test / lint 실행** — `mindy` 는 `bash: deny`, 사용자가 명령을 실행하고 한 줄 결과만 mindy 에게 전달.
- 머신 간 저널 / SPEC sync, embedding 기반 검색, 저널 압축 / 요약.
- 자동 drift polling, INDEX 자동 commit / push, 멈춘 PR watch 의 자동 re-arm.
- alias-prefix PR 핸들 파싱 (`<alias>#<num>`) — config 에 등록은 되지만 파싱은 보류.
- **`rocky` / `grace` / `mindy` 의 직접 다단계 구현** (코드 작성 / 리팩터 / 다파일 변경) — 셋 모두 위임 / 반환만 가능, 직접 실행은 안 함.

## 같이 보기

- [`README.md`](./README.md) — 1 페이지 진입점 (Claude Code 우선)
- [`AGENTS.md`](./AGENTS.md) — 에이전트용 단일 source (영문, MVP 범위 / change checklist / removal candidates)
- [`.opencode/INSTALL.md`](./.opencode/INSTALL.md) — opencode 호스트 설치 가이드
- [`agent-toolkit.schema.json`](./agent-toolkit.schema.json) — `agent-toolkit.json` 의 JSON Schema
- [`ROADMAP.md`](./ROADMAP.md) — post-MVP phase 들
