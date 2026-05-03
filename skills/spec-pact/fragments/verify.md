# spec-pact — VERIFY

Convert the SPEC's `합의 TODO` and `API 의존성` into a checklist that the caller verifies against the code. grace does not run code or grep itself — the caller answers.

## Steps

1. **Locate the SPEC path from the INDEX.** Look up by `source_page_id`, or by the slug / path the user provided.
2. **Read the SPEC.** Pull frontmatter + `합의 TODO` + `API 의존성`.
3. **Build the checklist.** For each item: `- [ ] <item> — grep hint: \`<token>\` / expected location: <path glob>`. Pull grep hints / location patterns directly from the agreed tokens (operationId, path segments, component names) — never guess.
4. **Collect the caller's response.** The caller answers each item with ✅ / ❌ / ⏸ and optionally a `file:line`. When no answer comes back, stop the turn — the caller must come back with answers in a follow-up turn.
5. **Append to the journal.** `journal_append({ kind: "spec_verify_result", content: "<slug> verify: <pass>/<fail>/<defer>", tags: ["spec-pact","verify"], pageId })`.
6. **Update the INDEX (conditional).** When all items pass, add `status: verified` + `verified_at` to the SPEC frontmatter and flip the INDEX status to `verified`. Otherwise leave the status as is.

## Output format (VERIFY)

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
