---
name: spec-pact
description: Negotiate, anchor, verify, and amend a project-local SPEC against a Notion 기획문서. Four-mode lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) on top of an LLM-wiki-inspired INDEX (`<spec.dir>/<spec.indexFile>`, default `.agent/specs/INDEX.md`) and per-page SPEC files (`<spec.dir>/<slug>.md` slug mode, default `.agent/specs/<slug>.md`, or `**/SPEC.md` directory mode). Conducted by the `grace` sub-agent. Auto-trigger when a Notion URL / page id appears together with phrases like "스펙 합의" / "SPEC 작성" / "SPEC 검증" / "SPEC drift" / "기획문서 변경 반영".
allowed-tools: [notion_get, notion_extract, notion_status, notion_refresh, journal_append, journal_read, journal_search, spec_pact_fragment, read, write, edit, glob]
license: MIT
version: 0.1.0
---

# spec-pact

## Role

* Own the agreement lifecycle between a Notion 기획문서 and a project-local SPEC.
* The SPEC is the anchor for code authoring and verification — once locked, it stays in effect across Notion edits until grace explicitly compares and patches it.
* Four modes only — DRAFT / VERIFY / DRIFT-CHECK / AMEND. One turn = one mode.
* Finalize/lock authority always belongs to grace. Even when an external sub-agent / skill participates in negotiation, only grace writes the SPEC frontmatter and INDEX.

> **Mode bodies live under `./fragments/`.** This SKILL.md is the router — it carries the shared rules (Role / Mental model / journal kinds / Tool / Writing / Do-NOT / Failure). The per-mode steps + output formats sit in `skills/spec-pact/fragments/{draft,verify,drift-check,amend}.md`. After grace picks the mode, it calls the **`spec_pact_fragment(mode)` plugin tool** (NOT a workspace-relative `read`) so the plugin resolves the fragment path against its own install location — works even when the toolkit is installed externally as `agent-toolkit@git+...`. Phase 6.A foundation — see ROADMAP.

## Mental model

```
agent (grace)
  ├── 0. read INDEX        ← <spec.dir>/<spec.indexFile> (default .agent/specs/INDEX.md, entry point)
  ├── 0'. glob '**/SPEC.md'← directory-mode discovery (only when spec.scanDirectorySpec=true)
  ├── 1. journal_read      ← cite spec_anchor / spec_drift / spec_amendment / spec_verify_result for the same pageId
  ├── 2. notion_get/extract← cache-first; extract for long docs / action candidates
  ├── 3. read / write/edit ← SPEC body + INDEX update (slug or directory mode)
  └── 4. journal_append    ← exactly one append per mode (mode → kind / tags table below)
```

INDEX is the wiki TOC, SPEC bodies are the wiki pages. With the INDEX alone, the user can see at a glance which Notion page is anchored where.

### Mode → journal kind / tags

| Mode | kind | tags | content shape | pageId |
|---|---|---|---|---|
| DRAFT | `spec_anchor` | `["spec-pact","v1"]` (add `"delegated:<agent>"` when negotiation was delegated) | `<slug> v1 anchored` | Notion page id |
| VERIFY | `spec_verify_result` | `["spec-pact","verify"]` | `<slug> verify: <pass>/<fail>/<defer>` | Notion page id |
| DRIFT-CHECK (drift found) | `spec_drift` | `["spec-pact","drift"]` | `<slug> drift detected` | Notion page id |
| DRIFT-CHECK (clean) | `note` (reuses the existing kind — see "Do NOT" below) | `["spec-pact","drift-clear"]` | `<slug> drift-clear` | Notion page id |
| AMEND | `spec_amendment` | `["spec-pact","v<n+1>"]` | `<slug> v<n+1> amended` | Notion page id |

The four `spec_*` kinds are the **new reserved kinds** introduced by this skill. drift-clear deliberately reuses the existing `note` kind plus a distinguishing tag — so kind-only filters miss it; use `journal_search "spec-pact"` (tag-shaped recall) to recover the full lifecycle history in one call.

## Inputs

- **Notion URL / page id** — pass verbatim to `notion_get` (the tool normalizes it).
- **Slug** (optional) — when DRAFT is invoked without an explicit slug, the default is `slugify(notionPageTitle)` (lowercase, non-word → `-`). On collision with the INDEX, append `-2`, `-3`, …
- **Path override** (optional) — when the user supplies a directory-mode path like `apps/web/orders/SPEC.md`, write to that path; the INDEX records the same logical entry with that path.

## Tool usage rules

1. `notion_*` follows the `notion-context` skill's cache-first policy — never fetch the same page twice in one turn. Use `notion_extract` for long documents / 기능 단위 TODO 후보. Call `notion_refresh` only when the user explicitly says "최신화".
2. Use `journal_read` / `journal_append` / `journal_search` only — `journal_status` is not needed in this skill's flow.
3. Touch SPEC / INDEX files through `read` / `write` / `edit` only. Never write back to Notion — Notion is the source of truth, the SPEC is the surface grace owns.
4. Use `glob` only for directory-mode discovery — only the `**/SPEC.md` pattern.
5. One mode per turn. After DRAFT, do not advance into VERIFY in the same turn (the user must request it explicitly in a follow-up turn).

## Mode dispatch

Each mode lives in its own fragment, fetched via the `spec_pact_fragment(mode)` plugin tool. After picking the mode, call the tool exactly once and follow the returned `content` (its `Steps` + `Output format`) verbatim. **Never call the tool more than once per turn** — that defeats the whole point of the split.

| Mode | Tool call | Trigger phrases (caller intent) |
|---|---|---|
| DRAFT | `spec_pact_fragment({ mode: "draft" })` | "스펙 합의" / "SPEC 작성" — first time the page is seen |
| VERIFY | `spec_pact_fragment({ mode: "verify" })` | "SPEC 검증" / "체크리스트" / "코드와 대조" |
| DRIFT-CHECK | `spec_pact_fragment({ mode: "drift-check" })` | "drift" / "노션 변경" / "기획 바뀜" / "동기화" / **"기획문서 변경 반영"** — first half of the lifecycle hand-off (drift 확인 → AMEND) |
| AMEND | `spec_pact_fragment({ mode: "amend" })` | "AMEND" / "drift 반영" / "patch" / "기획문서 변경 반영" 의 **두 번째 turn** — DRIFT-CHECK 결과를 본 후 항목별 합의를 적용할 때 |

"기획문서 변경 반영" 같은 양 모드를 걸치는 trigger 는 항상 **DRIFT-CHECK 부터** 시작 — 같은 turn 에 AMEND 까지 진입하지 말고, drift 결과를 caller 에게 surface 한 뒤 follow-up turn 에서 명시적으로 AMEND 로 진입한다 (`Tool usage rules` 5 와 같은 정신).

The fragments contain the per-mode `Steps` and `Output format`. The journal kind / tag table above stays in this SKILL.md core — it is shared across modes.

## Writing rules

- The SPEC body is **Korean** (mirroring the Notion source). Frontmatter / paths / journal kinds / API paths / tokens stay English.
- SPEC text may request code comments or JSDoc only as implementation guidance.
- Request comments / JSDoc for important public / shared methods, complex domain rules, caller-visible contracts, or explicit reviewer / user requests.
- Do not imply that every exported symbol needs JSDoc or that runtime projects should get a JSDoc / Korean-comment hard-lint rule by default.
- No guessing. Anything not in the Notion source goes to `보류된 이슈` / `확인 필요 사항` only.
- 1 bullet = 1 fact. Keep it short.
- Do not put unagreed sections into `agreed_sections`.
- The INDEX status is exactly one of three — `locked` / `drifted` / `verified`. (DRAFT writes `locked` directly; there is no "drafted" intermediate.)

## Do NOT

- **Do not use Notion as anything other than a source of truth.** Never write drift results back to a Notion page.
- **Do not bundle two modes into one turn.** After DRAFT, do not advance into VERIFY in the same turn.
- **Do not let an external sub-agent write the SPEC / INDEX directly.** Delegation applies to negotiation only — finalize/lock is always grace.
- **Do not auto-promote a directory-mode SPEC into the INDEX as a slug-mode entry.** The path reflects caller intent — surface conflicts and wait for a decision.
- **Do not call `notion_refresh` automatically.** Only call it once when the drift result is suspect, on user request.
- **Do not invent new reserved journal kinds beyond the four (`spec_anchor` / `spec_drift` / `spec_amendment` / `spec_verify_result`).** drift-clear reuses the existing `note` kind plus a distinguishing tag — that is intentional, not a fifth reserved kind.

## Failure / error handling

- `notion_get` timeout / auth failure → name the relevant env vars (`AGENT_TOOLKIT_NOTION_MCP_URL` etc.) on a single line and stop.
- `source_page_id` extraction fails → quote the input verbatim, ask once, stop.
- The INDEX surfaces the same `source_page_id` at two paths (slug + directory) → emit both paths on a single line and wait for the caller to decide. No automatic cleanup.
- AMEND introduces sections outside the prior agreement → record under `보류된 이슈` only and do not extend `agreed_sections`.
- VERIFY responses come back empty → stop the turn. The caller must come back with the responses in a follow-up turn.
