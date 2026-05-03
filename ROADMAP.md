# ROADMAP

본 toolkit 의 장기 비전 메모. 현재 출하된 MVP 는 [`AGENTS.md`](./AGENTS.md) 의 MVP scope 에 한정한다 — 이 문서는 그 너머의 목표를 정리하고 단계별로 점검한다. 새 기능은 항상 별도 PR 로, 한 번에 한 항목씩.

## 비전

작업 컨텍스트를 들고 코드까지 굴리는 에이전트 오케스트레이션 toolkit. Rocky (프론트엔드 전문성을 가진 풀스택 업무 파트너 / agent-toolkit 1차 지휘자, 외부 sub-agent / skill 위임 가능) 를 시작점으로, 기억 → 추적 → 코드 생성으로 표면을 넓혀 간다.

세 갈래의 장기 방향:

1. **업무/코딩 파트너로서 단독으로도 충분한 토대.** opencode 의 다섯 종 primitive (agent / skill / command / MCP / tool) 를 적재적소에 섞어 쓰는 composition foundation 을 만든다 — 새 skillset 이나 tool 이 추가되면 자동 discovery + token-cost 기반 라우팅으로 cheapest path 를 고른다. (자세한 단계는 **Phase 7**.)
2. **외부 primary 와의 시너지.** OmO Sisyphus / Superpowers 같은 외부 primary agent 가 동일 opencode 세션에 있을 때, agent-toolkit 의 description-driven routing 이 깨지지 않고 자연스럽게 위임이 흘러가도록 coexistence 규약을 둔다. agent-toolkit 은 이들과 경쟁하지 않고 (Notion / OpenAPI / SPEC 등) 토킷 고유 surface 를 책임진다. (자세한 단계는 **Phase 8**.)
3. **회사 맞춤 토킷의 base.** 회사 / 팀이 agent-toolkit 을 의존성으로 들고 자기네 tool / skill / agent 를 얹는 커스텀 토킷을 만들 수 있도록 plugin (현재 형태) + library (`lib/*` exports) 두 형태로 패키징한다. 의존하는 쪽은 Notion 캐시 / OpenAPI / 저널 / SPEC lifecycle 같은 공통 인프라를 재사용하고, 회사 고유 surface 만 추가한다. (자세한 단계는 **Phase 9**.)

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
| 1 | 에이전트 자동 기억/기록 | ✅ MVP | [#5](https://github.com/minjun0219/agent-toolkit/issues/5) | `journal_append` / `journal_read` / `journal_search` / `journal_status`, `lib/agent-journal.ts` (append-only JSONL, 디스크 영속, 시간순 + page-key 기반 lookup) |
| 2 | 상세 주석 | ✅ guidance | [#7](https://github.com/minjun0219/agent-toolkit/issues/7) | runtime/downstream project 대상 agent guidance 로 재정의. 중요한 public/shared method, 복잡한 로직, 공유 contract, 호출자 요청에 JSDoc 적용; hard lint 아님 |
| 3 | 한글 주석/설명 | ✅ guidance | [#7](https://github.com/minjun0219/agent-toolkit/issues/7) | 설명 prose 는 한국어 우선, identifiers / paths / commands / API paths / library names 는 원문 유지; hard lint 아님 |
| 4 | Notion 캐싱 + TTL | ✅ MVP | — | `notion_get` / `notion_status` / `notion_refresh`, `lib/notion-context.ts` |
| 5 | Notion → 개발 스펙 분해 | ✅ MVP+합의 lifecycle | — | `skills/notion-context/SKILL.md` spec mode (단발성) + `skills/spec-pact/SKILL.md` 4 모드 (`grace` sub-agent 가 conduct, INDEX·SPEC·journal 4 종 kind 로 lock / drift / amend 까지 추적) |
| 6 | 스펙 → GitHub Issue 추적 | 📋 planned (Phase 5 SPEC 위에 올라감) | [#4](https://github.com/minjun0219/agent-toolkit/issues/4) | issue body source-of-truth 를 노션 본문 대신 grace 가 잠근 SPEC body 로 — drift / 양방향 sync 단순화 |
| 7 | OpenAPI 캐시 + client 작성 | ✅ MVP+registry | [#6](https://github.com/minjun0219/agent-toolkit/issues/6) | `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` / `swagger_envs`, `lib/openapi-context.ts`, `lib/openapi-registry.ts`, `lib/toolkit-config.ts` + `agent-toolkit.schema.json`, `skills/openapi-client/SKILL.md` (JSON-only, 단일 endpoint 단위 snippet, host:env:spec 핸들 + scope 검색) |

## 제안 단계

각 단계는 별도 PR. MVP scope 경계는 `AGENTS.md` 가 들고 있고, 이 ROADMAP 은 그 경계를 넓히는 후보 작업의 모음이다.

- **Phase 1 — 완료** *(PR [#3](https://github.com/minjun0219/agent-toolkit/pull/3))*
  - Notion 캐시 + 스펙 추출 + Rocky 업무 파트너 / agent-toolkit 1차 지휘자 (`mode: all`)
- **Phase 2 — 스펙 → GitHub Issue / Project 동기화** *(memo #6, issue [#4](https://github.com/minjun0219/agent-toolkit/issues/4))*
  - Rocky 의 spec 모드 출력을 그대로 issue 시리즈로 변환하는 skill / 도구
  - 매핑 후보: 한 Notion 페이지 = 한 epic, "TODO" 섹션의 bullet 1 개 = 한 issue
- **Phase 3 — 에이전트 자동 기억 / 기록 — 완료** *(memo #1, issue [#5](https://github.com/minjun0219/agent-toolkit/issues/5))*
  - `journal_append` / `journal_read` / `journal_search` / `journal_status` 4 도구 + `lib/agent-journal.ts` append-only JSONL (TTL 없음, 손상 라인 graceful skip)
  - 시간순 + `kind` / `tag` / `pageId` / `since` 필터 + substring 검색
  - Rocky 본문에 "read 먼저 → append 마지막" 인용 규칙 박힘 (`agents/rocky.md` Memory 절)
- **Phase 4 — OpenAPI 캐시 + client 작성 — 완료** *(memo #7, issue [#6](https://github.com/minjun0219/agent-toolkit/issues/6))*
  - `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search` 4 도구 + `lib/openapi-context.ts` TTL 파일 캐시 + `skills/openapi-client/SKILL.md`
  - JSON-only (YAML 미지원), 단일 endpoint → `fetch` / `axios` snippet 한 덩어리
- **Phase 4.5 — OpenAPI environment registry — 완료** *(memo #7 확장)*
  - `agent-toolkit.json` (project / user 두 위치, project 우선) 으로 host → env → spec 트리 선언
  - `host:env:spec` 핸들 / `swagger_search` `scope` (host / host:env / host:env:spec) / `swagger_envs` 도구
  - `agent-toolkit.schema.json` JSON Schema (IDE 자동완성) + `lib/toolkit-config.ts` 런타임 검증 (외부 의존성 0)
- **Phase 5 — 기획문서 ↔ SPEC wiki lifecycle (`grace` + `spec-pact`)** *(memo #5 확장)*
  - `skills/spec-pact/SKILL.md` 4 모드 — DRAFT (Notion → 합의 → SPEC write + INDEX 갱신) / VERIFY (SPEC TODO·API 의존성 체크리스트화) / DRIFT-CHECK (`source_content_hash` 비교) / AMEND (drift 항목별 keep/update/reject + version bump)
  - `agents/grace.md` (`mode: subagent`) — 단일 finalize/lock 권한자, Rocky 가 Notion URL + lifecycle 키워드 감지 시 `@grace` 로 즉시 위임 (passthrough)
  - wiki-style entry point (LLM-wiki 컨셉 차용) — `.agent/specs/INDEX.md` 가 slug 모드 (`.agent/specs/<slug>.md`) + directory 모드 (`**/SPEC.md`, AGENTS.md 스타일) 양쪽을 surface
  - Journal 4 종 신규 reserved kind (`spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result`) + DRIFT-CHECK clean 케이스는 기존 `note` kind 를 `spec-pact` / `drift-clear` 태그로 재사용 — `journal_search "spec-pact"` 같은 tag 기반 조회 한 방으로 lifecycle history 회수
  - `agent-toolkit.json` `spec` 객체 (`dir` / `scanDirectorySpec` / `indexFile`) — IDE 자동완성 (`agent-toolkit.schema.json`) + 런타임 검증 (`lib/toolkit-config.ts`) lockstep
  - **Phase 2 (스펙 → GitHub Issue 동기화) 가 이 SPEC layer 위에 올라간다** — issue body source-of-truth 가 노션 본문이 아니라 grace 가 잠근 SPEC body 가 되면 drift 추적 / 양방향 sync 가 단순해진다
- **Phase 6 — TS-based dynamic agent / skill / command loader** *(후보)*
  - 현재 `agents/*.md` / `skills/*/SKILL.md` 는 정적 파일이라 컨텍스트별로 prompt / 위임 규칙을 분기하기 어렵다. OmO 의 [`AgentConfig` TypeScript 정의](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/CONTRIBUTING.md) 처럼 `.ts` 파일에서 prompt / model / temperature / 위임 규칙을 동적으로 산출하는 layer 가 있으면 — 같은 grace 라도 "처음 DRAFT 인지 / drift 검증 turn 인지" 에 따라 다른 prompt 를 줄 수 있다.
  - **opencode 단독 능력 한계**: opencode plugin API 의 `tool` 만 동적 등록 가능, agent / skill / command 는 path-based (`.md` 정적). 즉 TS-based loader 는 (a) OmO 같은 외부 harness 가 있는 환경에서만 의미가 있거나 (b) 토킷이 자체 loader 를 만들어 `.ts` AgentConfig → runtime `.md` 로 emit 해야 한다.
  - **방향**: `.md` 가 baseline 으로 남고, `.ts` 정의는 OmO 가 있을 때 옵트인으로 활성화 — 토킷이 OmO 의존을 강제하지 않는다. plugin entrypoint 가 `agents/*.ts` 가 있으면 OmO loader 에 위임, 없으면 `.md` 만 노출.
  - 의존성 0 의 자체 loader (b) 는 별도 PR 로 검토 — 트리거는 "정적 prompt 로는 부족한 첫 use case 가 등장할 때". 지금은 추적만.
  - **Phase 6.A — Runtime 프롬프트 동적 조립** *(6 의 sub, OmO 없이도 자체 적용 가능)*
    - 정적 prompt 를 두 부분으로 쪼갠다 — "고정 (persona / scope / 일반 규칙)" + "조건부 fragment (모드별 본문, 최근 journal entry, INDEX row, drift diff)".
    - agent 가 turn 시작 시 caller 입력 → 모드 결정 → 필요한 fragment 만 끼워 넣어 최종 prompt 생성. DRAFT turn 일 때 VERIFY/AMEND 본문이 prompt 에 안 들어가는 식의 token 절감.
    - fragment 카탈로그 (예시): `grace.fragment.{draft,verify,drift-check,amend}.md`, `grace.fragment.journal-recent.md`, `grace.fragment.index-row.md`.
    - **Phase 7 와의 관계**: 각 fragment 도 capability manifest (`tokenClass` / `requires`) 를 갖게 되면 Phase 7 router 가 cheapest fragment 만 활성화 가능. 즉 6.A = primitive **내부** token cost, Phase 7 = primitive **사이** token cost — 두 층이 서로 보완.
    - **트리거**: 한 agent 의 정적 prompt 가 ~3-4k token 을 넘기 시작할 때 (현재 grace.md ~150 줄, 한참 멀음).
  - **Phase 6.B — OmO harness leverage** *(6 의 sub, OmO 가 있을 때만; 없으면 6.A 또는 baseline `.md` 로 fallback)*
    - OmO 의 두 layer 가 명확히 분리되어 있다 (context7 source 확인):
      - **`claude-code-plugin-loader`** (`src/features/claude-code-plugin-loader/`) — 순수 ingestion 파이프라인. `.opencode/plugins` / `~/.claude/plugins` 스캔, `plugin.json` 매니페스트 파싱, commands / agents / skills / hooks / MCP / LSP 를 OmO registry 에 등록. WHY: "existing Claude Code plugins can be used unchanged within OmO".
      - **Harness layer** (`src/shared/model-resolver.ts` + `model-resolution-pipeline.ts` + agent invocation) — Model Resolution 4-step (override → category-default → provider-fallback → system-default), 모델 변경 시 prompt variant 자동 스위치 (예: `"prometheus": { "model": "openai/gpt-5.4" }` → "Auto-switches to the GPT prompt"), Hook tier (Session 24 / Tool-Guard 14 / Transform 5 / Continuation 7 / Skill 2).
    - **agent-toolkit 의 leverage 그림**:
      1. agent-toolkit 이 `plugin.json` 매니페스트를 ship → OmO 의 `claude-code-plugin-loader` 가 자동 ingest (코드 변경 없이 OmO 환경에서 자동 인식)
      2. 그 뒷단 OmO harness 가 model resolution + prompt variant 스위치를 알아서 처리 — **6.A 의 fragment 조립을 직접 짜지 않아도 OmO 가 있으면 거의 무료**
      3. agent-toolkit 단독 사용 (OmO 없음) 시에도 정상 동작 — `.md` baseline / 6.A fragment 가 fallback
    - **6.A 와 6.B 의 분담**: 모드 / journal / INDEX state 같은 토킷 고유 분기는 6.A 가 처리, 모델별 prompt variant 분기는 6.B (OmO harness) 에 위임. 둘이 충돌하지 않는다.
    - **감지 방법**: opencode plugin API 가 다른 plugin 을 introspect 못 하므로, 환경변수 (`AGENT_TOOLKIT_OMO_HARNESS=1`) 또는 `opencode.json` 의 `plugin` 배열에 `oh-my-openagent` 가 보이는지로 판단. 자동 감지가 어려우면 사용자 명시적 opt-in.
    - **Out-of-scope**: OmO source 변경, OmO 가 없는 환경에서 OmO harness 흉내내기.
    - **트리거**: 첫 사용자 환경에서 OmO 와 함께 굴리면서 "이 부분은 OmO 에 맡기는 게 더 깔끔하다" 가 관찰될 때.
  - **Phase 6.C — Journal 기반 compaction snapshot** *(6 의 sub, deps 0)*
    - opencode `experimental.session.compacting` hook 에서 journal 의 최근 항목을 우선순위 정렬 (`spec_anchor` / `spec_amendment` / `decision` / `blocker` 우선, `note` 후순위, 같은 kind 면 최신순) 해 짧은 스냅샷 파일 (`.agent/session-resume.md`) 로 떨궈두고, 다음 turn 시작 시 Rocky 가 자동 read.
    - 스냅샷 크기는 짧게 유지 (e.g., 파일 ≤2 KB) — 한도 초과 시 낮은 우선순위 항목부터 drop. journal 자체는 손대지 않는다 (스냅샷은 파생 산출물).
    - opencode SessionStart hook 이 ship 되면 — 새 세션 / `--continue` 진입 시점에서도 같은 스냅샷을 자동 주입해 "직전 작업 재개" 가 한 hop 으로 줄어든다. 현재는 사용자가 명시적으로 `journal_search` 해야 하는 단계.
    - 의존성 0 — 외부 store (SQLite / FTS5 등) 는 도입하지 않는다. journal 은 이미 디스크에 있고 우선순위 정렬은 in-memory 로 충분.
    - **6.A 와의 관계**: 스냅샷은 6.A 의 "조건부 fragment" 의 한 종류 (`rocky.fragment.session-resume.md` 류). 6.A 가 정착하면 같은 layer 위에 자연스럽게 올라간다.
    - **트리거**: 사용자가 compaction 후 "직전 turn 의 결정 / blocker 를 다시 인용" 을 두 번 이상 호소할 때, 또는 opencode SessionStart hook 이 ship 될 때.
- **Phase 7 — Primitive composition foundation** *(미정 후보, 토대 우선)*
  - 새 tool / skill / agent / command / MCP 가 추가될 때 자동으로 "어느 자리에 슬롯되는지 / 어떤 token cost 를 갖는지" 를 surface 하는 **manifest 층**.
  - 각 primitive 가 frontmatter / config 로 다음을 선언:
    - `requires` — 의존 primitive ID 목록
    - `tokenClass` — `low` | `medium` | `high` (대략 비용 표시; 정밀 측정은 후속)
    - `cacheLayer` — `yes` (cache-first) / `no` (remote-first)
    - `inputShape` / `outputShape` — 입력/출력 패턴 (e.g., `notion-url`, `openapi-handle`, `code-snippet`, `checklist`)
  - **Composition router** (Rocky 같은 1차 conductor 가 사용) 가 manifest 를 보고 cheapest path 선택 — 같은 비용이면 cache-first 우선. 같은 input shape 에 대해 두 primitive 가 매칭되면 `tokenClass` 가 낮은 쪽이 우선.
  - **자동 discovery** — 새 skill 이 `skills/` 에 들어오거나 새 plugin 이 등록되면 manifest 를 읽어 라우팅 표 자동 갱신. Rocky / Grace 의 `description` 도 description-driven routing 깨지 않게 동기화.
  - **트리거**: skill / tool 갯수가 description-driven routing 의 한계를 넘을 때. 현재 3 skill / 2 agent / 12 tool — 5+ skill / 4+ agent / 20+ tool 단계에서 검토. 지금은 토대만 박아두고 routing 자체는 description 으로 충분.
- **Phase 8 — 외부 primary 와의 coexistence** *(미정 후보, doc-heavy)*
  - OmO Sisyphus / Hephaestus / Superpowers 같은 외부 primary agent 와 동일 opencode 세션에서 동작할 때의 협조 규약. agent-toolkit 은 이들과 **경쟁하지 않고** Notion / OpenAPI / SPEC 등 토킷 고유 surface 만 책임진다.
  - In-scope:
    - 외부 primary 별 trigger keyword set 의 주기 audit (overlap 감지 — agent-toolkit 의 키워드와 충돌하면 한 쪽이 양보)
    - "input shape → 어느 primary" 라우팅 매트릭스 문서 (`COEXISTENCE.md` 후보)
    - 외부 primary 가 description 에 토킷 surface 키워드를 박지 않도록 권고 (사용자가 어느 쪽으로 보낼지 직접 선택)
    - 토킷 sub-agent (`@grace`) 를 외부 primary 가 직접 호출할 때의 contract / 결과 형식 고정
    - opencode hook (`tool.execute.before`, `experimental.session.compacting`) 에서 plugin 끼리 충돌하지 않는 방어 패턴
  - Out-of-scope: 외부 primary 의 source 변경, 자동 감지/등록 (opencode plugin API 가 다른 plugin 을 introspect 못 함).
  - **트리거**: 사용자가 OmO / Superpowers 를 함께 쓰면서 trigger 충돌이 처음 관찰될 때. 현재는 단독 사용이 많아 우선순위 낮음.
- **Phase 9 — Extensible base for downstream toolkits** *(미정 후보, packaging-heavy)*
  - 회사 / 팀이 agent-toolkit 을 의존성으로 들고 자기네 tool / skill / agent 를 얹는 커스텀 토킷을 만들 수 있게.
  - 패키지 형태 두 가지 병행:
    - **Plugin (현재 형태)** — `opencode.json` 의 `plugin` 배열에 git+ ref 로 추가. 변경 없음.
    - **Library (신규)** — `lib/*.ts` (`notion-context`, `openapi-context`, `agent-journal`, `toolkit-config`) 을 `package.json` `exports` 로 공개해 downstream 이 직접 `import` 가능.
  - Downstream 사용 패턴 (예시):
    ```ts
    // company-toolkit/.opencode/plugins/company-toolkit.ts
    import { resolveCacheKey, notionToMarkdown } from "agent-toolkit/notion-context";
    import { type Plugin } from "@opencode-ai/plugin";

    export const CompanyToolkit: Plugin = async (ctx) => ({
      tool: { /* 회사 고유 tools */ },
      // 회사 고유 skills / agents 는 자체 ./skills, ./agents 에서 path-based 로 노출
    });
    ```
  - `opencode.json` 에 두 plugin 모두 등록:
    ```jsonc
    { "plugin": ["agent-toolkit@git+https://...", "./company-toolkit"] }
    ```
  - 두 plugin 의 tool 이 같은 이름이면 opencode 정책상 후순위가 이긴다 — downstream 이 명시적으로 override 하지 않는 한 agent-toolkit 의 tool 이 그대로 노출.
  - 함께 결정해야 할 것: npm publish 여부 (`@minjun0219/agent-toolkit` 또는 unscoped `agent-toolkit`) vs git+ 만 유지, semver 정책 (현재 `0.1.0`).
  - **트리거**: 첫 회사 use case 가 등장할 때 (현재는 사용자 본인 N=1).
- **횡단 — 코드 품질 정책 강화** *(memo #2, #3, issue [#7](https://github.com/minjun0219/agent-toolkit/issues/7))*
  - repository 자체의 최소 lint 는 별도 Biome 도입 PR에서 관리한다.
  - JSDoc / 한글 주석은 runtime/downstream project 에서 agent 가 따르는 guidance 로 유지한다. 모든 exported symbol 강제나 hint-level hard lint 는 기본값이 아니다.

## 워크플로 관리

- **ROADMAP.md (이 문서)** — phase 단위 narrative ("왜 이 순서로 / 무엇을 / 무엇을 안 한다"). 능력 목표와 phase 사이의 의존 관계를 잡는다. Reserved agent names 도 여기서 보관.
- **GitHub Issue (#4 / #5 / #6 / #7 등)** — in-flight 작업 추적, PR/CI 자동 링크, label 기반 triage. 한 phase 진입 시 issue 한 개를 잡고 PR 들이 닫는다.
- **하이브리드 운영 원칙**: 새 phase 가 시작되거나 새 에이전트가 도입될 때, ROADMAP 의 잠정 매핑을 issue 의 contract (acceptance criteria) 로 옮긴다. `spec-pact` 가 성숙하면 (Phase 2 도달) Notion 기획문서 → grace 의 SPEC body → GitHub Issue body 라인이 자동화 후보.

## Reserved agent names

향후 phase 에서 새 에이전트가 필요할 때 사용할 후보 이름 — Rocky/Grace 와 동일하게 [Andy Weir](https://en.wikipedia.org/wiki/Andy_Weir) 작품 (*Project Hail Mary*, *The Martian*) 의 캐릭터에서 따왔다. **이름은 reservation 일 뿐, 해당 phase 진입 시 별도 GitHub Issue / PR 로 actual contract 를 정의한다.** 매핑이 안 맞으면 후보 캐릭터 (PHM 의 Dimitri/Yáo, Artemis 의 Jazz/Svoboda 등) 로 교체 가능 — 이 표는 잠정안.

| 후보 이름 | 출처 | 캐릭터 특징 | 잠정 매핑 |
|---|---|---|---|
| `watney` | *The Martian* — Mark Watney | 식물학자/엔지니어, log-keeper, "science the shit out of this" 식 step-by-step | code authoring / refactor sub-agent — Rocky/Grace 가 직접 안 굴리는 multi-step 구현의 위임 대상 |
| `stratt` | *Project Hail Mary* — Eva Stratt | 무자비한 결정권자, prioritization | Phase 2 (SPEC → GitHub Issue sync) 의 triage / 우선순위 / open vs close 결정 |
| `johanssen` | *The Martian* — Beth Johanssen | Hermes 의 sysadmin / programmer | CI / build runner agent — `bun run typecheck` / `bun test` 자동화 + 회귀 가드 |
| `mindy` | *The Martian* — Mindy Park | 위성 이미지 분석가, pattern detection | Observability / drift detector — repo-wide 상태 점검 (SPEC drift / 캐시 stale / journal 회수 한 방) |
| `vogel` | *The Martian* — Alex Vogel | 화학자 / 항법사, 외부 자료 탐색 | Research agent — context7 / docs MCP / 외부 문서 탐색을 라우팅 |

## 미정 / 결정 필요

- memo #1 의 "기억" 영속 층은 디스크로 결정 (Phase 3 MVP). cross-machine 동기화 / 자연어 검색 / 자동 요약 / 압축은 후속 phase.
- memo #6 의 GitHub 연동을 외부 MCP 로 위임할지 자체 도구로 만들지.
- Rocky 의 책임이 어느 단계에서 분할되어야 하는지 — Phase 5 에서 SPEC 합의 lifecycle 이 `@grace` sub-agent 로 분리됨 (`spec-pact` 스킬 + INDEX 자동 갱신). 추가 분리(`linear`, `swagger` 등 sub-partner) 트리거의 임계는 그만큼 높아졌고, 분리는 "특정 surface 가 충분히 두꺼워져 별도 persona / 별도 contract 가 필요해질 때" 로 제한한다 — 이번 Grace 분리도 같은 기준 (lifecycle 의 finalize/lock 권한이 Rocky 의 라우팅 책임과 충돌) 으로 결정됨.
- **Phase 6.A 의 fragment 분리 단위** — agent 단위 / 모드 단위 / journal 항목 단위 중 어디까지 쪼갤지. 너무 잘게 쪼개면 조립 비용이 fragment 절감을 상쇄하고, 너무 거칠게 쪼개면 token 절감 효과가 미미. 첫 도입 시점에 측정으로 결정.
- **Phase 6.B 의 OmO 감지 방식** — 환경변수 명시 opt-in (`AGENT_TOOLKIT_OMO_HARNESS=1`) vs `opencode.json` 의 `plugin` 배열 자동 감지. 자동 감지는 매끄럽지만 잘못된 위임 위험 (OmO 와 호환 안 되는 변경이 들어왔을 때 silent fail).
- **Phase 7 의 composition router 자동 vs 수동** — manifest 기반 라우팅이 description-driven routing 을 자동 대체할지, Rocky 가 명시적으로 manifest 를 lookup 할지. 자동화는 token 절감이 크지만 디버그 가능성 / 사용자 control 이 떨어진다. 첫 도입 시점에 결정.
- **Phase 8 의 외부 primary 충돌 해소 정책** — agent-toolkit 의 키워드와 외부 primary 의 키워드가 겹칠 때, 어느 쪽이 양보할지의 기본 원칙 (트리거 빈도 vs 해당 surface 책임 vs 사용자 선택권). 첫 충돌 사례가 등장하면 해당 규약을 `COEXISTENCE.md` 에 박는다.
- **Phase 9 의 license / publish 전략** — npm 공개 vs git+ 내부만, scoped vs unscoped, MIT 유지 vs 회사 정책 대응. Phase 9 진입 시 결정.
- **표면별 출력 cap 정책의 공통화 여부** — `mysql_query` 의 자동 LIMIT, `swagger_search` 의 endpoint 단위 매칭 등 표면별로 큰 응답을 자르는 정책이 박혀 있다. 새 surface 가 늘 때마다 임의 결정하기보다 공통 규칙 (응답 size threshold 넘으면 호출자 intent 로 substring 필터 + 후속 검색용 vocab 노출 같은 패턴) 을 `lib/` 한 곳에 모을지의 결정. 트리거: 새 surface (e.g., GitHub Issue 조회) 가 추가되며 표면별 임의 정책이 두 종 이상 더 늘 때.
