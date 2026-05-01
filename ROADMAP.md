# ROADMAP

본 toolkit 의 장기 비전 메모. 현재 출하된 MVP 는 [`AGENTS.md`](./AGENTS.md) 의 MVP scope 에 한정한다 — 이 문서는 그 너머의 목표를 정리하고 단계별로 점검한다. 새 기능은 항상 별도 PR 로, 한 번에 한 항목씩.

## 비전

회사 컨텍스트를 들고 코드까지 굴리는 에이전트 오케스트레이션 toolkit. Rocky (현재 회사 컨텍스트 파트너) 를 시작점으로, 기억 → 추적 → 코드 생성으로 표면을 넓혀 간다.

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
| 1 | 에이전트 자동 기억/기록 | 📋 planned | [#5](https://github.com/minjun0219/coding-agent-toolkit/issues/5) | turn / session / 디스크 어느 층까지 영속할지 결정 필요 |
| 2 | 상세 주석 | 🚧 부분 | [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7) | JSDoc 규칙 (`AGENTS.md`) 으로 정책은 박힘; 강제 / 검증은 미구현 |
| 3 | 한글 주석/설명 | ✅ 정책 (검증 미구현) | [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7) | `AGENTS.md` coding rules + output 정책 |
| 4 | Notion 캐싱 + TTL | ✅ MVP | — | `notion_get` / `notion_status` / `notion_refresh`, `lib/notion-context.ts` |
| 5 | Notion → 개발 스펙 분해 | ✅ MVP | — | `skills/notion-context/SKILL.md` spec mode |
| 6 | 스펙 → GitHub Issue 추적 | 📋 planned | [#4](https://github.com/minjun0219/coding-agent-toolkit/issues/4) | GitHub MCP / 자체 도구 어느 쪽으로 갈지 미정 |
| 7 | OpenAPI 캐시 + client 작성 | ✅ MVP | [#6](https://github.com/minjun0219/coding-agent-toolkit/issues/6) | `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search`, `lib/openapi-context.ts`, `skills/openapi-client/SKILL.md` (JSON-only, 단일 endpoint 단위 snippet) |

## 제안 단계

각 단계는 별도 PR. MVP scope 경계는 `AGENTS.md` 가 들고 있고, 이 ROADMAP 은 그 경계를 넓히는 후보 작업의 모음이다.

- **Phase 1 — 완료** *(PR [#3](https://github.com/minjun0219/coding-agent-toolkit/pull/3))*
  - Notion 캐시 + 스펙 추출 + Rocky 회사 컨텍스트 파트너 (`mode: all`)
- **Phase 2 — 스펙 → GitHub Issue / Project 동기화** *(memo #6, issue [#4](https://github.com/minjun0219/coding-agent-toolkit/issues/4))*
  - Rocky 의 spec 모드 출력을 그대로 issue 시리즈로 변환하는 skill / 도구
  - 매핑 후보: 한 Notion 페이지 = 한 epic, "TODO" 섹션의 bullet 1 개 = 한 issue
- **Phase 3 — 에이전트 자동 기억 / 기록** *(memo #1, issue [#5](https://github.com/minjun0219/coding-agent-toolkit/issues/5))*
  - turn 단위 결정 / blocker / 사용자 답변을 캐시 디렉터리 옆에 append-only 로 저장
  - Rocky 가 "이전 turn 에 X 로 결정했음" 같은 기억을 인용 가능하게
- **Phase 4 — OpenAPI 캐시 + client 작성 — 완료** *(memo #7, issue [#6](https://github.com/minjun0219/coding-agent-toolkit/issues/6))*
  - `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` 4 도구 + `lib/openapi-context.ts` TTL 파일 캐시 + `skills/openapi-client/SKILL.md`
  - JSON-only (YAML 미지원), 단일 endpoint → `fetch` / `axios` snippet 한 덩어리
- **횡단 — 코드 품질 정책 강화** *(memo #2, #3, issue [#7](https://github.com/minjun0219/coding-agent-toolkit/issues/7))*
  - 한글 주석 / JSDoc 정책의 lint 단 검증 (필요해지면)

## 미정 / 결정 필요

- memo #1 의 "기억" 이 얼마나 영속적이어야 하는지 (turn → session → 디스크).
- memo #6 의 GitHub 연동을 외부 MCP 로 위임할지 자체 도구로 만들지.
- Rocky 의 책임이 어느 단계에서 분할되어야 하는지 — 현재는 단일 파트너; phase 가 늘면 sub-partner 분리(`linear`, `swagger` 등) 검토.
