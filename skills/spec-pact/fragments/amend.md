# spec-pact — AMEND

Patch the SPEC in response to drift or an explicit user request.

## Steps

1. **Locate the SPEC path from the INDEX.**
2. **Reuse the DRIFT-CHECK diff** — either attached to the caller's message in the same turn, or pulled from the prior `journal_read({ pageId, kind: "spec_drift" })`.
3. **Negotiate per item** — keep / update / reject. `update` writes new content; `reject` removes the item from the SPEC and moves it to `보류된 이슈`.
4. **Patch the SPEC body and frontmatter** — set `source_content_hash` to the new Notion hash, `agreed_at` to the current ISO8601, `status: locked`, and append a single line to `# 변경 이력` (`<date> v<n+1> amended — based on Notion hash <첫 8자>`).
5. **Update the INDEX** — set the row's `v` / `Anchored` / `Status` to the new values.
6. **Append to the journal.** `journal_append({ kind: "spec_amendment", content: "<slug> v<n+1> amended", tags: ["spec-pact","v<n+1>"], pageId })`.

## Output format (AMEND)

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
