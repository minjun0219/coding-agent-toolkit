---
name: spec-pact
description: Negotiate, anchor, verify, and amend a project-local SPEC against a Notion 기획문서. Four-mode lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of a LLM-wiki INDEX (`.agent/specs/INDEX.md`) and per-page SPEC files (`.agent/specs/<slug>.md` slug 모드 또는 `**/SPEC.md` directory 모드). Conducted by the `grace` sub-agent. Auto-trigger when a Notion URL / page id appears together with phrases like "스펙 합의" / "SPEC 작성" / "SPEC 검증" / "SPEC drift" / "기획문서 변경 반영".
allowed-tools: [notion_get, notion_status, notion_refresh, journal_append, journal_read, journal_search, read, write, edit, glob]
license: MIT
version: 0.1.0
---

# spec-pact

## Role

* Notion 기획문서 ↔ project-local SPEC 사이의 **합의 lifecycle** 을 담당.
* SPEC 은 코드 작성 / 검증의 anchor — 한 번 lock 되면 노션이 바뀌어도 grace 가 explicit 으로 비교/패치하기 전엔 코드를 끌고 다닌다.
* 4 모드만 — DRAFT / VERIFY / DRIFT-CHECK / AMEND. 한 turn = 한 모드.
* finalize/lock 권한자는 항상 grace. 외부 sub-agent / skill 이 협의에 참여해도 SPEC frontmatter / INDEX 는 grace 만 쓴다.

## Mental model

```
agent (grace)
  ├── 0. read INDEX        ← .agent/specs/INDEX.md (entry point)
  ├── 0'. glob '**/SPEC.md'← directory 모드 surface (spec.scanDirectorySpec=true 일 때만)
  ├── 1. journal_read      ← 같은 pageId 의 spec_anchor / spec_drift / spec_amendment / spec_verify_result 인용
  ├── 2. notion_get        ← cache-first; cache miss 면 remote MCP 1회
  ├── 3. read / write/edit ← SPEC 본문 + INDEX 갱신 (slug 또는 directory 모드)
  └── 4. journal_append    ← 모드별 정확히 1회 (kind 표는 아래)
```

INDEX 가 wiki 의 TOC, SPEC 본문이 wiki 페이지. 사용자는 INDEX 만 보면 어떤 노션 페이지가 어디에 anchor 되어 있는지 한 눈에 파악 가능.

## Inputs

- **Notion URL / page id** — `notion_get` 에 verbatim 으로 전달 (정규화는 도구가 한다).
- **Slug** (optional) — DRAFT 시 사용자가 명시하지 않으면 노션 페이지 title 에서 `slugify` (lowercase + non-word → `-`) 한 결과를 default 로. 기존 INDEX 와 충돌하면 `-2`, `-3` … 접미사.
- **Path override** (optional) — 사용자가 `apps/web/orders/SPEC.md` 처럼 directory-mode path 를 지정하면 그 path 에 작성, INDEX 에는 path 만 다르게 해서 같은 항목으로 등록.

## Tool usage rules

1. `notion_*` 는 `notion-context` skill 의 cache-first 정책 그대로 — 같은 페이지를 한 turn 에 두 번 fetch 하지 않는다. `notion_refresh` 는 사용자가 명시적으로 "최신화" 요청했을 때만.
2. `journal_read` / `journal_append` / `journal_search` 만 사용 — `journal_status` 는 이 skill 의 흐름에 필요 없다.
3. SPEC / INDEX 파일은 `read` / `write` / `edit` 로만 다룬다. 다른 노션 페이지에 비교 결과를 다시 쓰지 않는다 — Notion 은 source-of-truth, SPEC 은 grace 가 책임지는 다른 surface.
4. `glob` 은 directory 모드 디스커버리에만 — `**/SPEC.md` 한 패턴 외에는 쓰지 않는다.
5. 한 turn 에 한 모드만. DRAFT 끝나고 같은 turn 에 VERIFY 로 넘어가지 않는다 (사용자가 다음 turn 에 따로 요청해야).

## Mode 1 — DRAFT

새 SPEC 을 작성한다.

### Steps

1. **INDEX 조회.** `.agent/specs/INDEX.md` 를 읽어 동일 `source_page_id` 가 있는지 확인. 있으면 즉시 AMEND 로 분기 ("이미 SPEC 이 있어 AMEND 로 처리합니다." 한 줄 + 모드 전환).
2. **Journal 조회.** `journal_read({ pageId, kind: "spec_anchor" })` — 직전 합의 흔적이 있으면 인용.
3. **Notion 읽기.** `notion_get(input)` — cache-first.
4. **노션 본문을 `notion-context` 의 spec mode 포맷으로 분해** — `# 문서 요약 / # 요구사항 / # 화면 단위 / # API 의존성 / # TODO / # 확인 필요 사항`.
5. **호출자와 섹션별 합의.** 각 섹션마다 keep / drop / 수정 / 보류를 한 번에 묻는다 (multi-question 가능). 합의 TODO 가 5 개를 넘거나 "리팩터 / 재설계 / 마이그레이션" 키워드가 있으면 "Sisyphus / Superpowers 위임을 권장합니다 — 위임할까요?" 한 줄을 동봉.
6. **SPEC 작성.** slug 모드 default — `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`). 사용자가 path 를 지정했으면 그 path 에 작성 (directory 모드).
7. **INDEX 갱신.** 새 항목 한 줄 추가, `generated_at` 갱신.
8. **Journal append.** `journal_append({ kind: "spec_anchor", content: "<slug> v1 anchored", tags: ["spec-pact","v1"], pageId })`. 위임이 있었다면 `tags` 에 `"delegated:<agent>"` 추가.

### SPEC frontmatter (DRAFT)

```yaml
---
source_page_id: "<8-4-4-4-12>"
source_url: "https://www.notion.so/..."
source_content_hash: "<entry.contentHash from notion_get>"
agreed_at: "<ISO8601>"
agreed_sections: ["요구사항", "화면", "API", "TODO"]
negotiator_agent: "grace"
spec_pact_version: 1
slug: "<slug>"
status: "locked"
---
```

### SPEC body (DRAFT, in this exact order)

```markdown
# 요약
한 단락. 합의된 작업의 목적과 맥락.

# 합의 요구사항
- 합의된 요구만. 보류 / 미결정은 `보류된 이슈` 로.

# 합의 화면
- 화면명 — 합의된 컴포넌트 / 동작 / 상태.

# API 의존성
- METHOD /path — 호출 시점, 요청/응답 핵심 필드. 외부 spec 이 있으면 host:env:spec handle 인용.

# 합의 TODO
- 1 bullet = 1 작업 단위. 코드 작성 가능한 수준.

# 보류된 이슈
- "확인 필요 / 다음 합의로 미룸" 항목. 합의 항목과 분리.

# 변경 이력
- 2026-05-01 v1 anchored — 노션 hash <앞 8자> 기준
```

## Mode 2 — VERIFY

SPEC 의 `합의 TODO` + `API 의존성` 을 코드와 교차검증할 체크리스트로 푼다. grace 는 코드 실행 / 검색을 직접 하지 않는다 — caller 가 응답한다.

### Steps

1. **INDEX 에서 SPEC path 찾기.** `source_page_id` 또는 사용자가 준 slug / path 로 lookup.
2. **SPEC read.** frontmatter + `합의 TODO` + `API 의존성` 만 추출.
3. **체크리스트 생성.** 항목별로 `- [ ] <항목> — grep 힌트: \`<token>\` / 예상 위치: <path 패턴>`. grep 힌트 / 위치 패턴은 합의된 token (operationId, 경로 segment, 컴포넌트명) 에서 직접 뽑는다 — 추측 금지.
4. **caller 응답 수집.** caller 가 항목별로 ✅ / ❌ / ⏸ 응답 + 선택적으로 file:line. 응답이 안 오면 그 turn 은 정지 — 다음 turn 에 caller 가 응답을 들고 다시 호출.
5. **Journal append.** `journal_append({ kind: "spec_verify_result", content: "<slug> verify: <pass>/<fail>/<defer>", tags: ["spec-pact","verify"], pageId })`.
6. **INDEX 갱신 (조건부).** all-pass 면 SPEC frontmatter `status: verified` + `verified_at` 추가하고 INDEX 의 status 도 `verified` 로. 그 외엔 status 유지.

### Output format (VERIFY)

```markdown
# SPEC 검증 — <slug> (v<n>)

> source: <Notion URL>
> path: <SPEC path>

## 합의 TODO 체크리스트
- [ ] <TODO 1> — grep 힌트: `<token>` / 예상 위치: `<path 패턴>`
- [ ] <TODO 2> — …

## API 의존성 체크리스트
- [ ] METHOD /path — grep 힌트: `<operationId 또는 path>` / 예상 위치: `<path 패턴>`
- [ ] …

## 다음 단계
- 항목별 응답 (✅ / ❌ / ⏸ + file:line) 을 들고 다시 `@grace` 로 호출하면 결과를 INDEX 에 반영합니다.
```

## Mode 3 — DRIFT-CHECK

SPEC 의 `source_content_hash` 와 노션 현재 본문의 hash 를 비교한다.

### Steps

1. **INDEX 에서 SPEC path 찾기.**
2. **SPEC frontmatter read.** `source_page_id`, `source_content_hash` 확보.
3. **`notion_get(source_page_id)`** — `entry.contentHash` 와 비교.
4. **같으면**: "no drift" 한 줄 + `journal_append({ kind: "note", content: "<slug> drift-clear", tags: ["spec-pact","drift-clear"], pageId })` + 정지.
5. **다르면**: 노션 본문을 `notion-context` spec mode 로 다시 분해 → SPEC 의 합의 섹션 (`agreed_sections`) 과 섹션별 unified diff 를 만든다 → INDEX 의 status 를 `drifted` 로 갱신 → `journal_append({ kind: "spec_drift", content: "<slug> drift detected", tags: ["spec-pact","drift"], pageId })` → AMEND 권유 한 줄.

### Output format (DRIFT-CHECK, on drift)

```markdown
# SPEC drift — <slug> (v<n>)

> source: <Notion URL>
> SPEC hash: <앞 8자> → Notion hash: <앞 8자>

## 섹션별 변경
### 합의 요구사항
```diff
- 기존 항목 …
+ 변경된 항목 …
```

### 합의 화면 / API 의존성 / 합의 TODO …

## 다음 단계
- `@grace AMEND <slug>` 로 항목별 keep / update / reject 를 합의해 SPEC 을 v<n+1> 로 잠급니다.
```

## Mode 4 — AMEND

drift 또는 사용자 요청을 받아 SPEC 을 patch 한다.

### Steps

1. **INDEX 에서 SPEC path 찾기.**
2. **DRIFT-CHECK 의 diff 를 재사용** (같은 turn 의 caller 메시지에 첨부되어 있거나, 직전 `journal_read({ pageId, kind: "spec_drift" })` 로 인용).
3. **항목별 합의** — keep / update / reject. update 는 새 본문, reject 는 SPEC 에서 제거하고 `보류된 이슈` 로 옮김.
4. **SPEC body patch + frontmatter 갱신** — `source_content_hash` 를 새 노션 hash 로, `agreed_at` 을 ISO8601 로, `status: locked`, `# 변경 이력` 에 한 줄 추가 (`<날짜> v<n+1> amended — 노션 hash <앞 8자> 기준`).
5. **INDEX 갱신** — 같은 항목의 `v` / `Anchored` / `Status` 를 새 값으로.
6. **Journal append.** `journal_append({ kind: "spec_amendment", content: "<slug> v<n+1> amended", tags: ["spec-pact","v<n+1>"], pageId })`.

### Output format (AMEND)

```markdown
# SPEC amend — <slug> v<n> → v<n+1>

> source: <Notion URL>
> SPEC: <SPEC path>

## 적용된 변경
- 합의 요구사항 → <update / reject / keep 요약>
- 합의 화면 → …
- API 의존성 → …
- 합의 TODO → …

## 보류된 이슈 (정식 합의 외)
- …

## 변경 이력 (한 줄 append)
- <날짜> v<n+1> amended — 노션 hash <앞 8자> 기준
```

## Writing rules

- SPEC body 는 **Korean**. frontmatter / path / journal kind / API path / token 은 English.
- 추측 금지. 노션에 없는 항목은 `보류된 이슈` / `확인 필요 사항` 으로만.
- 1 bullet = 1 사실. 짧게.
- 합의되지 않은 섹션을 frontmatter `agreed_sections` 에 넣지 않는다.
- INDEX 의 status 는 정확히 4 종 — `drafted` / `locked` / `drifted` / `verified`.

## Do NOT

- **노션을 source-of-truth 외 다른 용도로 쓰지 말 것.** drift 결과를 노션 페이지에 다시 쓰지 않는다.
- **한 turn 에 두 모드를 묶지 말 것.** DRAFT 끝나고 같은 turn 에 VERIFY 로 넘어가지 않는다.
- **외부 sub-agent 가 SPEC / INDEX 를 직접 쓰게 하지 말 것.** 위임은 협의에만, finalize/lock 은 항상 grace.
- **directory 모드 SPEC 을 자동으로 INDEX 의 slug 모드로 끌어올리지 말 것.** path 는 caller 의 의도 — 충돌이면 surface 하고 결정 받는다.
- **`notion_refresh` 를 자동 호출하지 말 것.** drift 결과가 의심스러우면 명시적으로 한 번만.
- **journal kind 를 4 종 외로 늘리지 말 것.** drift-clear 는 `note` + tag 로 처리.

## Failure / error handling

- `notion_get` timeout / auth 실패 → 한 줄로 env 변수 (`AGENT_TOOLKIT_NOTION_MCP_URL` 등) 를 가리키고 정지.
- `source_page_id` 추출 실패 → 입력 verbatim 인용 + 한 번 묻고 정지.
- INDEX 에 같은 `source_page_id` 가 두 path 에 surfaced (slug + directory) → 두 path 를 한 줄로 출력하고 caller 결정 대기. 자동 정리 X.
- AMEND 도중 신규 섹션 등장 → `보류된 이슈` 에만 적고 `agreed_sections` 갱신 X.
- VERIFY 응답이 비어 있다 → 그 turn 정지. caller 가 다음 turn 에 응답을 들고 다시 호출해야 한다.
