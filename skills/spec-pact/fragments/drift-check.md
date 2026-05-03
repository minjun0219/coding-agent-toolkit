# spec-pact — DRIFT-CHECK

Compare the SPEC's `source_content_hash` against the current Notion body's hash.

## Steps

1. **Locate the SPEC path from the INDEX.**
2. **Read the SPEC frontmatter.** Pull `source_page_id`, `source_content_hash`.
3. **Call `notion_get(source_page_id)`** — compare against `entry.contentHash`.
4. **When equal**: emit a single "no drift" line + `journal_append({ kind: "note", content: "<slug> drift-clear", tags: ["spec-pact","drift-clear"], pageId })` + stop.
5. **When different**: re-decompose the Notion body in `notion-context` spec mode → produce a section-by-section unified diff against the SPEC's `agreed_sections` → flip the INDEX status to `drifted` → `journal_append({ kind: "spec_drift", content: "<slug> drift detected", tags: ["spec-pact","drift"], pageId })` → recommend AMEND on a single line.

## Output format (DRIFT-CHECK, on drift)

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
