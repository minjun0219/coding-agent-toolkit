# ROADMAP

본 toolkit 의 장기 비전 메모. 현재 출하된 MVP 는 [`AGENTS.md`](./AGENTS.md) 의 MVP scope 에 한정한다 — 이 문서는 그 너머의 목표를 정리하고 단계별로 점검한다. 새 기능은 항상 별도 PR 로, 한 번에 한 항목씩.

## 비전

작업 컨텍스트를 들고 코드까지 굴리는 에이전트 오케스트레이션 toolkit. Rocky (프론트엔드 전문성을 가진 풀스택 업무 파트너 / agent-toolkit 1차 지휘자, 외부 sub-agent / skill 위임 가능) 를 시작점으로, 기억 → 추적 → 코드 생성으로 표면을 넓혀 간다.

## 능력 목표

원본 메모 — 분리 단위 그대로 유지.

1. 에이전트가 작업하거나 기억해야 하는 사항을 **자동으로 기억/기록** 해야 한다.
2. 작성한 코드와 관련하여 **주석을 상세하게** 작성해야 하며 설명할 수 있어야 한다.
3. 주석이나 설명을 작성할 때에는 **한글** 로 작성해야 한다.
4. **Notion MCP** 를 활용하여 노션 문서를 캐싱하고, 일정 시간 내 같은 문서를 참고할 때에는 캐싱을 참고해야 한다.
5. 개발 기획 문서는 대부분 Notion 으로 작성되어 있으므로 Notion 문서를 바탕으로 **명확한 개발 스펙으로 분해** 할 수 있어야 한다.
6. 분해된 개발 스펙을 **GitHub Issue / Project** 로 관리하고 추적할 수 있어야 한다.
7. 공유된 **Swagger / OpenAPI JSON** 을 로컬 캐시 → MCP / skill 로 빠르게 탐색 → `fetch` / `axios` 같은 API client 로 작성할 수 있어야 한다.

## 현재 상태

| # | 항목 | 상태 | 추적 issue | 비고 |
| --- | --- | --- | --- | --- |
| 1 | 에이전트 자동 기억/기록 | ✅ MVP | [#5](https://github.com/minjun0219/coding-agent-toolkit/issues/5) | `journal_append` / `journal_read` / `journal_search` / `journal_status`, `lib/agent-journal.ts` (append-only JSONL, 디스크 영속, 시간순 + page-key 기반 lookup) |
| 2 | 상세 주석 | 🚧 부분 | [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7) | JSDoc 규칙 (`AGENTS.md`) 으로 정책은 박힘; 강제 / 검증은 미구현 |
| 3 | 한글 주석/설명 | ✅ 정책 (검증 미구현) | [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7) | `AGENTS.md` coding rules + output 정책 |
| 4 | Notion 캐싱 + TTL | ✅ MVP | — | `notion_get` / `notion_status` / `notion_refresh`, `lib/notion-context.ts` |
| 5 | Notion → 개발 스펙 분해 | ✅ MVP+합의 lifecycle | — | `skills/notion-context/SKILL.md` spec mode (단발성) + `skills/spec-pact/SKILL.md` 4 모드 (`grace` sub-agent 가 conduct, INDEX·SPEC·journal 4 종 kind 로 lock / drift / amend 까지 추적) |
| 6 | 스펙 → GitHub Issue 추적 | 📋 planned (Phase 5 SPEC 위에 올라감) | [#4](https://github.com/minjun0219/coding-agent-toolkit/issues/4) | issue body source-of-truth 를 노션 본문 대신 grace 가 잠근 SPEC body 로 — drift / 양방향 sync 단순화 |
| 7 | OpenAPI 캐시 + client 작성 | ✅ MVP+registry | [#6](https://github.com/minjun0219/coding-agent-toolkit/issues/6) | `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` / `swagger_envs`, `lib/openapi-context.ts`, `lib/openapi-registry.ts`, `lib/toolkit-config.ts` + `agent-toolkit.schema.json`, `skills/openapi-client/SKILL.md` (JSON-only, 단일 endpoint 단위 snippet, host:env:spec 핸들 + scope 검색) |

## 제안 단계

각 단계는 별도 PR. MVP scope 경계는 `AGENTS.md` 가 들고 있고, 이 ROADMAP 은 그 경계를 넓히는 후보 작업의 모음이다.

- **Phase 1 — 완료** *(PR [#3](https://github.com/minjun0219/coding-agent-toolkit/pull/3))*
  - Notion 캐시 + 스펙 추출 + Rocky 업무 파트너 / agent-toolkit 1차 지휘자 (`mode: all`)
- **Phase 2 — 스펙 → GitHub Issue / Project 동기화** *(memo #6, issue [#4](https://github.com/minjun0219/coding-agent-toolkit/issues/4))*
  - Rocky 의 spec 모드 출력을 그대로 issue 시리즈로 변환하는 skill / 도구
  - 매핑 후보: 한 Notion 페이지 = 한 epic, "TODO" 섹션의 bullet 1 개 = 한 issue
- **Phase 3 — 에이전트 자동 기억 / 기록 — 완료** *(memo #1, issue [#5](https://github.com/minjun0219/coding-agent-toolkit/issues/5))*
  - `journal_append` / `journal_read` / `journal_search` / `journal_status` 4 도구 + `lib/agent-journal.ts` append-only JSONL (TTL 없음, 손상 라인 graceful skip)
  - 시간순 + `kind` / `tag` / `pageId` / `since` 필터 + substring 검색
  - Rocky 본문에 "read 먼저 → append 마지막" 인용 규칙 박힘 (`agents/rocky.md` Memory 절)
- **Phase 4 — OpenAPI 캐시 + client 작성 — 완료** *(memo #7, issue [#6](https://github.com/minjun0219/coding-agent-toolkit/issues/6))*
  - `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` 4 도구 + `lib/openapi-context.ts` TTL 파일 캐시 + `skills/openapi-client/SKILL.md`
  - JSON-only (YAML 미지원), 단일 endpoint → `fetch` / `axios` snippet 한 덩어리
- **Phase 4.5 — OpenAPI environment registry — 완료** *(memo #7 확장)*
  - `agent-toolkit.json` (project / user 두 위치, project 우선) 으로 host → env → spec 트리 선언
  - `host:env:spec` 핸들 / `swagger_search` `scope` (host / host:env / host:env:spec) / `swagger_envs` 도구
  - `agent-toolkit.schema.json` JSON Schema (IDE 자동완성) + `lib/toolkit-config.ts` 런타임 검증 (외부 의존성 0)
- **Phase 5 — 기획문서 ↔ SPEC wiki lifecycle (`grace` + `spec-pact`)** *(memo #5 확장)*
  - `skills/spec-pact/SKILL.md` 4 모드 — DRAFT (Notion → 합의 → SPEC write + INDEX 갱신) / VERIFY (SPEC TODO·API 의존성 체크리스트화) / DRIFT-CHECK (`source_content_hash` 비교) / AMEND (drift 항목별 keep/update/reject + version bump)
  - `agents/grace.md` (`mode: subagent`) — 단일 finalize/lock 권한자, Rocky 가 Notion URL + lifecycle 키워드 감지 시 `@grace` 로 즉시 위임 (passthrough)
  - LLM-wiki 형 entry point — `.agent/specs/INDEX.md` 가 slug 모드 (`.agent/specs/<slug>.md`) + directory 모드 (`**/SPEC.md`, AGENTS.md 스타일) 양쪽을 surface
  - Journal 4 종 신규 kind (`spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result`) — `journal_search "spec-pact"` 한 방으로 lifecycle history 회수
  - `agent-toolkit.json` `spec` 객체 (`dir` / `scanDirectorySpec` / `indexFile`) — IDE 자동완성 (`agent-toolkit.schema.json`) + 런타임 검증 (`lib/toolkit-config.ts`) lockstep
  - **Phase 2 (스펙 → GitHub Issue 동기화) 가 이 SPEC layer 위에 올라간다** — issue body source-of-truth 가 노션 본문이 아니라 grace 가 잠근 SPEC body 가 되면 drift 추적 / 양방향 sync 가 단순해진다
- **Phase 6 — TS-based dynamic agent / skill / command loader** *(후보)*
  - 현재 `agents/*.md` / `skills/*/SKILL.md` 는 정적 파일이라 컨텍스트별로 prompt / 위임 규칙을 분기하기 어렵다. OmO 의 [`AgentConfig` TypeScript 정의](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/CONTRIBUTING.md) 처럼 `.ts` 파일에서 prompt / model / temperature / 위임 규칙을 동적으로 산출하는 layer 가 있으면 — 같은 grace 라도 "처음 DRAFT 인지 / drift 검증 turn 인지" 에 따라 다른 prompt 를 줄 수 있다.
  - **opencode 단독 능력 한계**: opencode plugin API 의 `tool` 만 동적 등록 가능, agent / skill / command 는 path-based (`.md` 정적). 즉 TS-based loader 는 (a) OmO 같은 외부 harness 가 있는 환경에서만 의미가 있거나 (b) 토킷이 자체 loader 를 만들어 `.ts` AgentConfig → runtime `.md` 로 emit 해야 한다.
  - **방향**: `.md` 가 baseline 으로 남고, `.ts` 정의는 OmO 가 있을 때 옵트인으로 활성화 — 토킷이 OmO 의존을 강제하지 않는다. plugin entrypoint 가 `agents/*.ts` 가 있으면 OmO loader 에 위임, 없으면 `.md` 만 노출.
  - 의존성 0 의 자체 loader (b) 는 별도 PR 로 검토 — 트리거는 "정적 prompt 로는 부족한 첫 use case 가 등장할 때". 지금은 추적만.
- **횡단 — 코드 품질 정책 강화** *(memo #2, #3, issue [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7))*
  - 한글 주석 / JSDoc 정책의 lint 단 검증 (필요해지면)

## 미정 / 결정 필요

- memo #1 의 "기억" 영속 층은 디스크로 결정 (Phase 3 MVP). cross-machine 동기화 / 자연어 검색 / 자동 요약 / 압축은 후속 phase.
- memo #6 의 GitHub 연동을 외부 MCP 로 위임할지 자체 도구로 만들지.
- Rocky 의 책임이 어느 단계에서 분할되어야 하는지 — Phase 5 에서 SPEC 합의 lifecycle 이 `@grace` sub-agent 로 분리됨 (`spec-pact` 스킬 + INDEX 자동 갱신). 추가 분리(`linear`, `swagger` 등 sub-partner) 트리거의 임계는 그만큼 높아졌고, 분리는 "특정 surface 가 충분히 두꺼워져 별도 persona / 별도 contract 가 필요해질 때" 로 제한한다 — 이번 Grace 분리도 같은 기준 (lifecycle 의 finalize/lock 권한이 Rocky 의 라우팅 책임과 충돌) 으로 결정됨.
