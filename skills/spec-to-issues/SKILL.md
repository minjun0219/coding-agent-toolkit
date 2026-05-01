---
name: spec-to-issues
description: Convert a locked SPEC body (grace finalize 결과 — `.agent/specs/<slug>.md` 슬러그 모드 또는 `**/SPEC.md` 디렉터리 모드) into one epic GitHub Issue + N sub-issues. Mapping is fixed — one SPEC = one epic, `# 합의 TODO` bullet 1 개 = 한 sub-issue. Idempotent — same SPEC re-run does not duplicate (marker + label dedupe). Conducted by `rocky` after grace has locked / amended the SPEC. Auto-trigger when a SPEC slug / path appears together with phrases like "이슈 만들어" / "GitHub Issue 동기화" / "스펙 → 이슈" / "phase 2 sync" / "epic + sub 만들어줘".
allowed-tools: [issue_create_from_spec, issue_status, journal_append, journal_read, journal_search]
license: MIT
version: 0.1.0
---

# spec-to-issues

## Role

* Take a locked SPEC body (the surface `grace` owns) and reflect it as a GitHub Issue series — one epic + N sub-issues.
* The issue body's source-of-truth is the SPEC body, **not** the Notion page. drift / 양방향 sync 가 단순해지도록 노션 본문은 거치지 않는다 — 노션 변경 반영은 grace 의 DRIFT-CHECK / AMEND lifecycle 이 먼저 끝난 다음 이 skill 로 들어와야 한다.
* One SPEC = one epic, `# 합의 TODO` bullet 1 개 = 한 sub-issue. 다른 매핑 후보 (요구사항 1 항목 = epic 등) 는 out-of-scope.
* Idempotent — 같은 SPEC 을 다시 동기화해도 issue 가 중복 생성되지 않는다. 마커 (`<!-- spec-pact:slug=<slug>:kind=epic -->`, `<!-- spec-pact:slug=<slug>:kind=sub:index=<n> -->`) 와 라벨 (`spec-pact`) 두 단서로 dedupe.

## Mental model

```
caller (rocky)
  ├── 0. journal_search "spec-pact"  ← 이 slug 가 이전에 동기화된 흔적이 있는지 인용
  ├── 1. issue_status                ← (옵션) 현재 GitHub 측 상태만 한 번 GET 으로 점검
  ├── 2. issue_create_from_spec      ← dryRun 으로 plan 먼저 보여주고, 사용자 승인 후 본 호출
  └── 3. journal_append              ← 한 번 append (kind/tag table 참고)
```

`spec-to-issues` 는 SPEC 파일과 GitHub Issue 사이의 한 방향 sync 만 한다 — 노션 본문이나 SPEC frontmatter 는 절대 쓰지 않는다 (SPEC body 의 finalize/lock 권한은 여전히 grace 에게).

### Mode → journal kind / tags

| Trigger | kind | tags | content shape | pageId |
|---|---|---|---|---|
| dryRun preview (사용자 확인 전) | `note` | `["spec-pact","spec-to-issues","dry-run"]` | `<slug> dry-run: epic <new\|exists>, subs <n>/<total>` | SPEC frontmatter `source_page_id` |
| apply 완료 | `note` | `["spec-pact","spec-to-issues","applied"]` | `<slug> applied: epic #<n> + subs #<n1>..` | SPEC frontmatter `source_page_id` |

Lifecycle history 회수는 `journal_search "spec-to-issues"` 로 이 두 종류 entry 만 한꺼번에 본다 — `spec-pact` 의 4 종 reserved kind (`spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result`) 는 grace 가 쓰므로 이 skill 은 건드리지 않는다.

## Inputs

- **slug** — 필수 (또는 path). `<spec.dir>/<slug>.md` 가 존재해야 한다 (default `spec.dir` = `.agent/specs`).
- **path** — slug 대신 명시적 SPEC 파일 경로 (directory 모드 — `apps/web/orders/SPEC.md` 등). project-root 상대.
- **repo** (옵션) — `owner/repo`. 누락 시 `agent-toolkit.json` 의 `github.repo` 또는 `AGENT_TOOLKIT_GITHUB_REPO` 가 채워져 있어야 한다. 둘 다 비어 있으면 stop + 한 줄 에러 메시지.
- **dryRun** (옵션) — `true` 면 plan / 매칭만 보여주고 remote write 는 하지 않는다. 첫 동기화 turn 에서는 항상 dryRun 먼저.

## Tool usage rules

1. `issue_create_from_spec` 와 `issue_status` 는 한 turn 안에서 같은 SPEC 을 두 번 fetch / write 하지 말 것 — 한 번의 dryRun 또는 한 번의 apply.
2. **반드시 dryRun 먼저.** 사용자 승인 (`apply` / `진행해` 등) 이 들어오기 전에는 `dryRun: true` 로만 호출한다.
3. `journal_append` 는 모드당 한 번 — dryRun 이 끝났을 때 한 번 (preview), apply 가 끝났을 때 한 번 (applied). 두 번 부르지 않는다.
4. SPEC 본문 / INDEX / Notion 은 이 skill 이 절대 쓰지 않는다 (`notion_*` / `read` / `write` / `edit` 도 `allowed-tools` 에 없음). drift 가 의심되면 caller 가 먼저 `@grace SPEC drift` 로 돌리고 와야 한다.

## Step-by-step

### 1. dryRun preview (첫 turn)

1. `journal_search "spec-pact"` (또는 `journal_read({ pageId: <source_page_id> })`) — 같은 slug 의 과거 anchor / drift / 동기화 흔적을 인용. 처음이면 "no prior entry" 한 줄.
2. `issue_status({ slug })` 를 부르거나 (라벨 검색만), 곧장 `issue_create_from_spec({ slug, dryRun: true })` 한 번. 둘 중 후자가 plan 까지 같이 보여주므로 일반적으로 충분 — 전자는 "이미 있는지만 빠르게 확인" 같은 좁은 케이스 전용.
3. 결과를 사용자에게 한 덩어리로 surface (아래 "Output format — dryRun" 참고).
4. `journal_append({ kind: "note", content: "<slug> dry-run: epic <new|exists>, subs <created>/<total>", tags: ["spec-pact","spec-to-issues","dry-run"], pageId: <source_page_id> })`.

### 2. apply (사용자 승인 후 — 다음 turn)

1. `issue_create_from_spec({ slug })` 한 번 (dryRun 없이) — epic 또는 sub 가 이미 있는 것은 그대로 두고 누락된 것만 생성, epic 의 task list 는 새 sub 가 생기면 자동으로 patch.
2. 결과를 사용자에게 한 덩어리로 surface (아래 "Output format — apply" 참고).
3. `journal_append({ kind: "note", content: "<slug> applied: epic #<n> + subs #<n1>..#<nk>", tags: ["spec-pact","spec-to-issues","applied"], pageId: <source_page_id> })`.

## Output format — dryRun

```markdown
# SPEC → GitHub Issue (dry-run) — <slug> v<n>

> SPEC: `<spec path>`
> repo: `<owner/repo>`
> Notion: <source_url> (있을 때)

## Epic
- title: `[spec] <slug> v<n>`
- existing: ✅ #<n> <state> / ❌ (will create)

## Sub-issues (`# 합의 TODO` bullet 1 개 = 한 sub)
- [<existing #n / ❌ will create>] <todo 1>
- [<existing #n / ❌ will create>] <todo 2>
- …

## 다음 단계
- 이 plan 그대로 진행하려면 `apply` / `진행해` 라고 답해 주세요. → 다음 turn 에서 `issue_create_from_spec({ slug, dryRun: false })` 로 호출합니다.
- SPEC 자체를 고치려면 `@grace AMEND <slug>` 로 먼저 SPEC 을 patch 해 주세요.
```

## Output format — apply

```markdown
# SPEC → GitHub Issue (applied) — <slug> v<n>

> SPEC: `<spec path>`
> repo: `<owner/repo>`

## Epic
- #<n> [`<title>`](<htmlUrl>) — <existed: yes|no>

## Sub-issues
- #<n1> [`<title>`](<htmlUrl>) — <existed: yes|no>
- #<n2> …

## 다음 단계
- 추가 변경이 필요하면 SPEC 을 grace 로 amend → 다시 이 skill 을 한 번 더 호출하면 새 sub 만 추가되고 epic 의 task list 가 업데이트됩니다.
- issue 닫기 / project 보드 추가는 이 skill 의 범위 밖 — GitHub UI 또는 외부 자동화에서 처리해 주세요.
```

## Writing rules

- 출력 본문은 **한국어** (다른 toolkit skill 들과 동일). title / repo / `owner/repo` / 마커 / journal kind 등 식별자는 영문 그대로.
- "1 SPEC = 1 epic" 매핑을 임의로 바꾸지 않는다. SPEC 의 다른 섹션 (요구사항 / 화면 / API 의존성) 은 epic body 의 source URL / 요약에만 인용되고 별도 issue 가 되지는 않는다.
- "epic + sub" 만 — pull request / discussion / project (v2) 카드는 만들지 않는다.

## Do NOT

- **노션 본문에 다시 쓰지 않는다.** 노션은 source-of-truth, SPEC 은 grace 의 잠금 표면, GitHub Issue 는 본 skill 이 만드는 추적 표면 — 세 단의 sync 방향이 항상 한쪽이다.
- **SPEC 또는 INDEX 를 직접 수정하지 않는다.** SPEC frontmatter 의 변경 (예: `github_issues` 같은 필드 추가) 도 금지 — 그것은 grace 의 권한.
- **dryRun 없이 곧장 apply 하지 않는다.** 사용자 승인 단계를 생략하면 잘못된 SPEC (오래된 todo / 잘못된 slug) 으로 issue 가 만들어진 뒤 닫는 비용이 더 크다.
- **자동 reopen 하지 않는다.** 닫힌 issue (`state: closed`) 가 매칭되면 그 사실만 surface — 다시 열지 않는다.
- **Project (v2) 보드에 자동 추가하지 않는다.** 이번 phase scope 밖.
- **두 개 이상의 SPEC 을 한 turn 에 batch 동기화하지 않는다.** SPEC 한 개 단위로만 — 사용자가 두 번째 SPEC 을 명시하면 두 번째 turn 으로 넘긴다.

## Failure / error handling

- `slug` 와 `path` 둘 다 누락 → "어느 SPEC 인지 (slug 또는 path) 알려주세요." 한 줄 stop.
- `slug` 와 `path` 둘 다 입력 → "둘 중 하나만 주세요" 한 줄 stop.
- SPEC 파일이 존재하지 않음 → 경로를 그대로 인용 + `@grace DRAFT` 안내 한 줄 stop.
- SPEC frontmatter 에 `slug` 없음 → "잠긴 SPEC 이 아닐 수 있어요 — `@grace DRAFT` 또는 `@grace AMEND` 로 먼저 finalize 해 주세요." 한 줄 stop.
- `AGENT_TOOLKIT_GITHUB_TOKEN` 누락 → 변수명 + 필요한 권한 (PAT 의 `repo` 또는 fine-grained `Issues: Read & Write`) 을 한 줄로 안내하고 stop.
- `agent-toolkit.json` 의 `github.repo` 도, `AGENT_TOOLKIT_GITHUB_REPO` 도, 인자의 `repo` 도 비어 있음 → 세 후보를 한 줄에 같이 나열하고 stop.
- GitHub API 가 4xx/5xx → status code + body 일부를 한 줄에 surface 하고 stop. 재시도 자동화는 안 함.
- `# 합의 TODO` 가 비어 있음 → epic 1 개만 만들고 ("sub 0 개"), 한 줄로 그 사실을 surface.
