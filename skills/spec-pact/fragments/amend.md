# spec-pact — AMEND

Patch the SPEC in response to drift or an explicit user request.

## Steps

1. **Locate the SPEC path from the INDEX.**
2. **Obtain the per-section diff.** The journal's `spec_drift` entry stores only a one-line marker (`<slug> drift detected`) — it is a trigger record, NOT a diff cache. So pick exactly one of:
   - **(a) Same-turn attachment** — when the caller paste the prior DRIFT-CHECK output (sections + unified diffs) inline in this turn's message, reuse it verbatim.
   - **(b) Recompute** — when the caller did not attach the diff (or attached only "drift" as a keyword), recompute it now with the same procedure as `fragments/drift-check.md` step 5: read SPEC frontmatter → `notion_get(source_page_id)` → re-decompose the Notion body in `notion-context` spec mode → produce the section-by-section unified diff against the SPEC's `agreed_sections`. Do not skip this step — without the diff, per-item negotiation has no ground truth.
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
