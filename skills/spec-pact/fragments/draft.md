# spec-pact — DRAFT

Write a new SPEC.

## Steps

1. **Read the INDEX.** Resolve the INDEX path from `agent-toolkit.json` — `<spec.dir>/<spec.indexFile>`, default `.agent/specs/INDEX.md` — then read it and check whether the same `source_page_id` already exists. If yes, stop with "A SPEC already exists — request AMEND to update it." on a single line; do not switch modes in the same turn.
2. **Read the journal.** `journal_read({ pageId, kind: "spec_anchor" })` — quote any prior agreement when present.
3. **Read Notion.** For short/normal pages, `notion_get(input)` — cache-first. For long pages or requests about "필요한 작업만" / "기능 단위" / "이슈로 쪼개기", use `notion_extract(input)` and keep `chunkId` provenance for TODO candidates.
4. **Decompose the Notion body using the `notion-context` spec-mode format** — `# 문서 요약 / # 요구사항 / # 화면 단위 / # API 의존성 / # TODO / # 확인 필요 사항`. When `notion_extract` was used, seed `# 합의 TODO` negotiation from `extracted.todos` and API negotiation from `extracted.apis`, but do not auto-lock them without caller agreement.
5. **Negotiate section by section with the caller.** For each section, ask in a single turn whether to keep / drop / edit / defer (multiple questions are fine in one turn). When `합의 TODO > 5` or the request mentions "리팩터 / 재설계 / 마이그레이션", attach a single suggestion line ("Recommend delegating negotiation to Sisyphus / Superpowers — delegate?").
6. **Write the SPEC.** Default to slug mode at `<spec.dir>/<slug>.md` (default `.agent/specs/<slug>.md`). When the user supplied a path, write there (directory mode).
7. **Update the INDEX.** Add a new row, update `generated_at`.
8. **Append to the journal.** `journal_append({ kind: "spec_anchor", content: "<slug> v1 anchored", tags: ["spec-pact","v1"], pageId })`. When negotiation was delegated, add `"delegated:<agent>"` to `tags`.

## SPEC frontmatter (DRAFT)

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

## SPEC body (DRAFT, in this exact order)

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
