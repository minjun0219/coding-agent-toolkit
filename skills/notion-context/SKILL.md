---
name: notion-context
description: Read a Notion page under a cache-first policy and either feed the markdown straight to the LLM as grounding, extract long-page chunks/action candidates, or rewrite it into a Korean-language spec ("문서 요약 / 요구사항 / 화면 단위 / API 의존성 / TODO / 확인 필요 사항"). Auto-trigger when the user supplies a Notion URL or page id together with phrases like "스펙 정리해줘" / "요구사항 뽑아줘" / "Notion 페이지 X 가 Y 에 대해 뭐라고 하는지" / "긴 문서에서 작업만 뽑아줘".
allowed-tools: [notion_get, notion_status, notion_refresh, notion_extract]
license: MIT
version: 0.2.0
---

# notion-context

## Role

* Read a single Notion page under a **cache-first** policy and either pass the markdown through as LLM context, or rewrite it into a structured Korean-language spec.
* Single page only — child pages and databases are out of scope.

## Mental model

```
agent (you)
  ├── 1. notion_status         ← cache metadata only (no remote call)
  ├── 2. notion_get            ← cache hit → markdown / miss → remote MCP fetch + cache write (one shot)
  ├── 3. notion_extract        ← long page → chunks + action candidates (same cache policy)
  └── 4. notion_refresh        ← only when the user explicitly asks for "최신화" / refresh
```

Notion is the source of truth. The cache exists so the same page does not hit the remote twice in one turn. `notion_get` already handles cache miss by fetching from the remote MCP, normalizing, and storing — no separate `put` step is needed.

## Tool usage rules

1. Reach Notion only through `notion_get` / `notion_extract` / `notion_refresh` / `notion_status`. No direct fetch, Read, Bash, or raw MCP calls.
2. Unless the user explicitly asks to refresh ("최신화" / "refresh"):
   * Check cache state first with `notion_status`.
   * When `exists=true && expired=false`, only call `notion_get` (do not refresh, do not re-fetch).
   * Otherwise call `notion_get` — it hits the remote on cache miss automatically.
3. Do not fetch the same page more than once per turn. Reuse the markdown or `notion_extract` result you already have.
4. Use `notion_refresh` only when the user explicitly asks to refresh / force-refresh. When it returns `diff`, inspect `diff.sections` first and cite changed `path` values before re-reading/summarizing the full document.
5. Pass the user-supplied page id or Notion URL into `input` verbatim — the tool normalizes it.
6. For long documents or requests phrased as "필요한 작업만" / "기능 단위" / "이슈로 쪼개기", prefer `notion_extract` over dumping the whole markdown. Use `extracted.todos` as implementation candidates and cite `chunkId` when explaining provenance.

## Freshness policy

* **Default**: trust the cache for the duration of the turn.
* **Mutating workflow** (the user just edited the page or explicitly asks "is this up-to-date?"): call `notion_refresh`.
* `notion_status` reporting `expired=true` is *not* a signal to auto-refresh — the next `notion_get` naturally hits the remote one more time.
* Seeing `fromCache: false` once does not justify calling again immediately — you'd get the same result.

## Output format — spec mode (Korean, in this exact order)

Apply only when the user asks for a "스펙 정리" / "요구사항 뽑아줘" / "스펙 만들어줘" style request. For plain grounding questions ("what does this page say?"), quote or summarize the markdown directly.

```
# 문서 요약
한 단락. 이 문서가 무엇이고 어떤 맥락에서 쓰이는지 설명.

# 요구사항
- 필요/불필요/모호 를 구분해 bullet 으로 정리.
- 각 항목은 1줄.

# 화면 단위
- 화면명 — 설명
  - 주요 컴포넌트 / 동작 / 상태 전이

# API 의존성
- METHOD /path — 호출 시점, 요청/응답 핵심 필드

# TODO
- 구현 관점에서 즉시 착수 가능한 작업 단위 bullet.

# 확인 필요 사항
- 문서만 읽고는 단정할 수 없는 항목을 질문 형태로 정리.
```

## Writing rules (for spec-mode output)

* The body content is **Korean**. Leave English identifiers, API paths, and library names as-is.
* No guessing. Anything not stated in the document goes under "확인 필요 사항".
* Keep sentences short. One bullet, one fact.
* Wrap code / identifiers in `inline code`.
* Avoid hedges like "일단 ~로 가정" or "아마도".

## Do NOT

* **Do not call the remote on every turn** — that is the entire reason this skill exists.
* Do not call `notion_refresh` while `notion_status` reports `exists=true && expired=false` — you'd get the same body back.
* Do not guess page ids / URLs. When you cannot extract one from the user input, quote the input verbatim and ask again.
* Do not write content not present in the document into the body / requirements / API sections — surface unknowns under "확인 필요 사항" only.
* Do not feed an arbitrary slice of the markdown to the LLM. For long pages, summarize key sections rather than dumping the whole document.
* Do not ask the user to run local scripts for extraction — this plugin exposes `notion_extract` as the opencode tool surface.

## Failure / error handling

* When `notion_get` throws on timeout / network error / malformed response, ask the user to verify the relevant environment variables (`AGENT_TOOLKIT_NOTION_MCP_URL`, `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS`, …) and remote MCP availability, then stop.
* When the page id cannot be extracted, quote the user's input verbatim and ask again.
* When the page is empty, write only "본문이 비어 있음" under "문서 요약" and leave the rest blank.
