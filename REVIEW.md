# 리뷰 지침

이 파일은 Claude Code Code Review 가 PR 을 검토할 때 따르는 최우선 규칙이다. `CLAUDE.md` / `AGENTS.md` 보다 우선한다. 모든 리뷰 코멘트는 한국어로 작성한다 — 코드 식별자 / 경로 / 명령어는 영어 그대로 둔다.

## 코멘트 형식

- summary 첫 줄에 한 줄 집계: `🔴 N 중요 / 🟡 M nit / 🟣 K 기존`. 중요 0 개면 "중요 이슈 없음" 으로 시작.
- inline 코멘트는 `문제 / 영향 / 제안` 3 줄. 가능하면 적용 가능한 수정 예시를 함께.

## 🔴 Important 의 정의 (이 repo 한정)

아래만 Important 로 올린다. 나머지는 Nit 이하.

- **MVP 스코프 위반**: `AGENTS.md` "MVP scope" 의 *Out* 을 들이는 변경 — YAML OpenAPI 파서, multi-spec merge, mock server, multi-host plugin layout, OAuth, Notion child page, 저널 TTL / 요약 / 임베딩, Rocky 의 직접 multi-step 구현 등.
- **공개 contract 깨짐**: 12 개 plugin 도구 (`notion_*` / `swagger_*` / `journal_*`) 의 입력·출력 shape, agent (`rocky`) 라우팅, skill (`notion-context` / `openapi-client`) 의 사용 규칙.
- **lockstep 드리프트**: `agent-toolkit.json` shape 가 바뀌었는데 `agent-toolkit.schema.json` 과 `lib/toolkit-config.ts` 가 둘 다 동기화되지 않은 경우.
- **문서 동기화 누락**: 사용자 노출 표면 (도구 / 환경변수 / handle 형식) 이 바뀌었는데 `README.md` / `.opencode/INSTALL.md` 가 따라오지 않은 경우. 새 환경변수가 plugin `readEnv()` 에 추가되지 않은 경우. plugin 의 도구 contract 가 바뀌었는데 해당 skill / `agents/rocky.md` 가 갱신되지 않은 경우.
- **런타임 안전 위반**: `__dirname` 사용 (ESM 금지 — `import.meta.url` / `import.meta.dir` 만), import 에 `.js` / `.ts` 확장자 부착, Bun 전용 런타임 가정을 깨는 Node 한정 API 도입.
- **에러·보안**: 비밀값 / 토큰 / Notion 인증 흐름의 민감 정보 로깅, 에러 메시지에 컨텍스트 (입력값 / timeout / status / pageId mismatch 등) 누락, 외부 입력으로 만든 fs path 의 정규화 / sanitize 누락.
- **journal 무결성**: append-only / corruption-tolerant 계약을 깨는 변경 (한 줄 깨졌다고 read 가 throw, 기존 라인 mutate, TTL 도입 등).
- **의존성 추가**: `package.json` 에 새 runtime dep 이 들어왔는데 standard library / Bun built-in 으로 대체 가능하거나 정당화가 없는 경우.

## 🟡 Nit (한 리뷰당 최대 5 개)

스타일 / 네이밍 / 소소한 JSDoc 누락 / 테스트 파일 위치 (`*.test.ts` 가 소스 옆에 있어야 함) / fs 의존 테스트의 `mkdtempSync` 격리 누락 / 가독성 개선은 모두 Nit. inline 은 5 개까지만 달고, 나머지는 summary 끝에 `유사 항목 N 개 더` 로 집계만.

## 보고하지 않는다

- `bun.lock`, `node_modules/`, `dist/`, `*.tsbuildinfo`, `.env*` (gitignore 대상).
- `bun run typecheck` / `bun test` 로 이미 잡히는 타입·테스트 실패 — CI 가 처리한다. 단, 새 lib 모듈에 인접 `*.test.ts` 자체가 빠진 경우는 Nit 으로 보고.
- `ROADMAP.md` 의 phase 항목을 MVP 로 끌어들이는 PR 이 *명시적으로 그렇게 요청된* 경우, 스코프 확장 그 자체는 Important 가 아니다 (요청 범위 안의 변경).

## 항상 확인

- `AGENTS.md` "Change checklist" 6 개 항목과 PR 변경 표면이 일치하는가.
- 새 export 함수 / 클래스에 JSDoc 이 붙었는가.
- 에러 메시지에 식별 가능한 컨텍스트가 포함됐는가.
- 사용자 노출 텍스트 (`README.md`, `.opencode/INSTALL.md`, `skills/*/SKILL.md`, `agents/rocky.md`) 가 변경된 도구 / 환경변수 / handle 형식과 일치하는가.

## 인용 기준

"이 코드가 X 한다" 류의 행동 단정은 추정이 아니라 `파일경로:라인` 인용으로 뒷받침한다. 네이밍에서 추론한 행동만으로 Important 를 올리지 않는다.

## 재리뷰 수렴

같은 PR 의 두 번째 리뷰부터는 새 Nit 을 올리지 않는다 — Important 와 새로 도입된 Pre-existing 만 올린다. 이전 리뷰에서 지적된 항목이 고쳐지면 thread 가 자동 resolve 된다는 점을 신뢰한다.
