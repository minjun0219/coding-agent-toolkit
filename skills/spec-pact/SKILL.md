---
name: spec-pact
description: Negotiate, anchor, verify, and amend a project-local SPEC against a Notion 기획문서. Four-mode lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of a LLM-wiki INDEX (`.agent/specs/INDEX.md`) and per-page SPEC files (`.agent/specs/<slug>.md` slug mode or `**/SPEC.md` directory mode). Conducted by the `grace` sub-agent. Auto-trigger when a Notion URL / page id appears together with phrases like "스펙 합의" / "SPEC 작성" / "SPEC 검증" / "SPEC drift" / "기획문서 변경 반영".
allowed-tools: [notion_get, notion_status, notion_refresh, journal_append, journal_read, journal_search, read, write, edit, glob]
license: MIT
version: 0.1.0
---

# spec-pact

## Role

* Own the agreement lifecycle between a Notion 기획문서 and a project-local SPEC.
* The SPEC is the anchor for code authoring and verification — once locked, it stays in effect across Notion edits until grace explicitly compares and patches it.
* Four modes only — DRAFT / VERIFY / DRIFT-CHECK / AMEND. One turn = one mode.
* Finalize/lock authority always belongs to grace. Even when an external sub-agent / skill participates in negotiation, only grace writes the SPEC frontmatter and INDEX.

## Mental model

```
agent (grace)
  ├── 0. read INDEX        ← .agent/specs/INDEX.md (entry point)
  ├── 0'. glob '**/SPEC.md'← directory-mode discovery (only when spec.scanDirectorySpec=true)
  ├── 1. journal_read      ← cite spec_anchor / spec_drift / spec_amendment / spec_verify_result for the same pageId
  ├── 2. notion_get        ← cache-first; remote MCP once on cache miss
  ├── 3. read / write/edit ← SPEC body + INDEX update (slug or directory mode)
  └── 4. journal_append    ← exactly one append per mode (kind table below)
```

INDEX is the wiki TOC, SPEC bodies are the wiki pages. With the INDEX alone, the user can see at a glance which Notion page is anchored where.

## Inputs

- **Notion URL / page id** — pass verbatim to `notion_get` (the tool normalizes it).
- **Slug** (optional) — when DRAFT is invoked without an explicit slug, the default is `slugify(notionPageTitle)` (lowercase, non-word → `-`). On collision with the INDEX, append `-2`, `-3`, …
- **Path override** (optional) — when the user supplies a directory-mode path like `apps/web/orders/SPEC.md`, write to that path; the INDEX records the same logical entry with that path.

## Tool usage rules

1. `notion_*` follows the `notion-context` skill's cache-first policy — never fetch the same page twice in one turn. Call `notion_refresh` only when the user explicitly says "최신화".
2. Use `journal_read` / `journal_append` / `journal_search` only — `journal_status` is not needed in this skill's flow.
3. Touch SPEC / INDEX files through `read` / `write` / `edit` only. Never write back to Notion — Notion is the source of truth, the SPEC is the surface grace owns.
4. Use `glob` only for directory-mode discovery — only the `**/SPEC.md` pattern.
5. One mode per turn. After DRAFT, do not advance into VERIFY in the same turn (the user must request it explicitly in a follow-up turn).

## Mode 1 — DRAFT

Write a new SPEC.

### Steps

1. **Read the INDEX.** Read `.agent/specs/INDEX.md` and check whether the same `source_page_id` already exists. If yes, jump straight to AMEND ("A SPEC already exists — switching to AMEND." on a single line and switch the mode).
2. **Read the journal.** `journal_read({ pageId, kind: "spec_anchor" })` — quote any prior agreement when present.
3. **Read Notion.** `notion_get(input)` — cache-first.
4. **Decompose the Notion body using the `notion-context` spec-mode format** — `# 문서 요약 / # 요구사항 / # 화면 단위 / # API 의존성 / # TODO / # 확인 필요 사항`.
5. **Negotiate section by section with the caller.** For each section, ask in a single turn whether to keep / drop / edit / defer (multiple questions are fine in one turn). When `합의 TODO > 5` or the request mentions "리팩터 / 재설계 / 마이그레이션", attach a single suggestion line ("Recommend delegating negotiation to Sisyphus / Superpowers — delegate?").
6. **Write the SPEC.** Default to slug mode at `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`). When the user supplied a path, write there (directory mode).
7. **Update the INDEX.** Add a new row, update `generated_at`.
8. **Append to the journal.** `journal_append({ kind: "spec_anchor", content: "<slug> v1 anchored", tags: ["spec-pact","v1"], pageId })`. When negotiation was delegated, add `"delegated:<agent>"` to `tags`.

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

Convert the SPEC's `합의 TODO` and `API 의존성` into a checklist that the caller verifies against the code. grace does not run code or grep itself — the caller answers.

### Steps

1. **Locate the SPEC path from the INDEX.** Look up by `source_page_id`, or by the slug / path the user provided.
2. **Read the SPEC.** Pull frontmatter + `합의 TODO` + `API 의존성`.
3. **Build the checklist.** For each item: `- [ ] <item> — grep hint: \`<token>\` / expected location: <path glob>`. Pull grep hints / location patterns directly from the agreed tokens (operationId, path segments, component names) — never guess.
4. **Collect the caller's response.** The caller answers each item with ✅ / ❌ / ⏸ and optionally a `file:line`. When no answer comes back, stop the turn — the caller must come back with answers in a follow-up turn.
5. **Append to the journal.** `journal_append({ kind: "spec_verify_result", content: "<slug> verify: <pass>/<fail>/<defer>", tags: ["spec-pact","verify"], pageId })`.
6. **Update the INDEX (conditional).** When all items pass, add `status: verified` + `verified_at` to the SPEC frontmatter and flip the INDEX status to `verified`. Otherwise leave the status as is.

### Output format (VERIFY)

```markdown
# SPEC 검증 — <slug> (v<n>)

> source: <Notion URL>
> path: <SPEC path>

## 합의 TODO 체크리스트
- [ ] <TODO 1> — grep hint: `<token>` / expected location: `<path glob>`
- [ ] <TODO 2> — …

## API 의존성 체크리스트
- [ ] METHOD /path — grep hint: `<operationId or path>` / expected location: `<path glob>`
- [ ] …

## 다음 단계
- 항목별 응답 (✅ / ❌ / ⏸ + file:line) 을 들고 다시 `@grace` 로 호출하면 결과를 INDEX 에 반영합니다.
```

## Mode 3 — DRIFT-CHECK

Compare the SPEC's `source_content_hash` against the current Notion body's hash.

### Steps

1. **Locate the SPEC path from the INDEX.**
2. **Read the SPEC frontmatter.** Pull `source_page_id`, `source_content_hash`.
3. **Call `notion_get(source_page_id)`** — compare against `entry.contentHash`.
4. **When equal**: emit a single "no drift" line + `journal_append({ kind: "note", content: "<slug> drift-clear", tags: ["spec-pact","drift-clear"], pageId })` + stop.
5. **When different**: re-decompose the Notion body in `notion-context` spec mode → produce a section-by-section unified diff against the SPEC's `agreed_sections` → flip the INDEX status to `drifted` → `journal_append({ kind: "spec_drift", content: "<slug> drift detected", tags: ["spec-pact","drift"], pageId })` → recommend AMEND on a single line.

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

Patch the SPEC in response to drift or an explicit user request.

### Steps

1. **Locate the SPEC path from the INDEX.**
2. **Reuse the DRIFT-CHECK diff** — either attached to the caller's message in the same turn, or pulled from the prior `journal_read({ pageId, kind: "spec_drift" })`.
3. **Negotiate per item** — keep / update / reject. `update` writes new content; `reject` removes the item from the SPEC and moves it to `보류된 이슈`.
4. **Patch the SPEC body and frontmatter** — set `source_content_hash` to the new Notion hash, `agreed_at` to the current ISO8601, `status: locked`, and append a single line to `# 변경 이력` (`<date> v<n+1> amended — based on Notion hash <첫 8자>`).
5. **Update the INDEX** — set the row's `v` / `Anchored` / `Status` to the new values.
6. **Append to the journal.** `journal_append({ kind: "spec_amendment", content: "<slug> v<n+1> amended", tags: ["spec-pact","v<n+1>"], pageId })`.

### Output format (AMEND)

```markdown
# SPEC amend — <slug> v<n> → v<n+1>

> source: <Notion URL>
> SPEC: <SPEC path>

## 적용된 변경
- 합의 요구사항 → <update / reject / keep summary>
- 합의 화면 → …
- API 의존성 → …
- 합의 TODO → …

## 보류된 이슈 (정식 합의 외)
- …

## 변경 이력 (한 줄 append)
- <date> v<n+1> amended — based on Notion hash <첫 8자>
```

## Writing rules

- The SPEC body is **Korean** (mirroring the Notion source). Frontmatter / paths / journal kinds / API paths / tokens stay English.
- No guessing. Anything not in the Notion source goes to `보류된 이슈` / `확인 필요 사항` only.
- 1 bullet = 1 fact. Keep it short.
- Do not put unagreed sections into `agreed_sections`.
- The INDEX status is exactly one of four — `drafted` / `locked` / `drifted` / `verified`.

## Do NOT

- **Do not use Notion as anything other than a source of truth.** Never write drift results back to a Notion page.
- **Do not bundle two modes into one turn.** After DRAFT, do not advance into VERIFY in the same turn.
- **Do not let an external sub-agent write the SPEC / INDEX directly.** Delegation applies to negotiation only — finalize/lock is always grace.
- **Do not auto-promote a directory-mode SPEC into the INDEX as a slug-mode entry.** The path reflects caller intent — surface conflicts and wait for a decision.
- **Do not call `notion_refresh` automatically.** Only call it once when the drift result is suspect, on user request.
- **Do not invent journal kinds beyond the four.** drift-clear is `note` + a tag.

## Failure / error handling

- `notion_get` timeout / auth failure → name the relevant env vars (`AGENT_TOOLKIT_NOTION_MCP_URL` etc.) on a single line and stop.
- `source_page_id` extraction fails → quote the input verbatim, ask once, stop.
- The INDEX surfaces the same `source_page_id` at two paths (slug + directory) → emit both paths on a single line and wait for the caller to decide. No automatic cleanup.
- AMEND introduces sections outside the prior agreement → record under `보류된 이슈` only and do not extend `agreed_sections`.
- VERIFY responses come back empty → stop the turn. The caller must come back with the responses in a follow-up turn.
