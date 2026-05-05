---
name: pr-review-watch
description: Watch an existing GitHub PR for new review comments / reviews / check-runs / merge signals through polling, validate each comment against the codebase, draft a Korean reply or counter-argument, post the reply through the external GitHub MCP server, and unsubscribe on merge / close. PR creation and the actual merge stay outside the toolkit (Claude Code / `gh` CLI / external GitHub MCP own those). Conducted by the `mindy` sub-agent. The toolkit never calls the GitHub API itself — credentials live with the external MCP. Auto-trigger only when a PR URL / `owner/repo#123` handle appears together with explicit review-watch phrases like "PR review" / "리뷰 봐줘" / "리뷰 확인" / "코멘트 확인" / "머지까지 watch" / "리뷰 답글" / "PR drift"; a bare PR link must not start watch.
allowed-tools: [pr_watch_start, pr_watch_stop, pr_watch_status, pr_event_record, pr_event_pending, pr_event_resolve, journal_append, journal_read, journal_search, read, glob, grep]
license: MIT
version: 0.1.0
---

# pr-review-watch

## Role

* Conduct the PR review watch lifecycle on top of an *existing* GitHub PR — never create the PR, never merge it.
* Four modes only — WATCH-START / PULL / VALIDATE / WATCH-STOP. One turn = one mode.
* The toolkit's source-of-truth is `journal.jsonl`; GitHub remains the canonical place for the PR / comments / merge.
* Finalize authority for `pr_event_resolved` always belongs to the conducting agent (`mindy`). Even when validation reasoning is delegated to another sub-agent / skill, only mindy writes the resolved entry.

## Mental model

```
external GitHub MCP                           toolkit (this skill / mindy)
  ├── pull_request_read           ─────►       PULL: pr_event_record (×N)
  ├── add_reply_to_pull_request_comment        VALIDATE: pr_event_resolve
  ├── add_issue_comment                        VALIDATE: pr_event_resolve
  ├── add_comment_to_pending_review            VALIDATE: pr_event_resolve
  ├── pull_request_review_write                VALIDATE: pr_event_resolve
  ├── resolve_review_thread                    (optional after VALIDATE)
  └── merge_pull_request          ◄─────       (NOT called by mindy)
```

The skill never embeds GitHub URLs or tokens — caller's external MCP holds those. mindy reads MCP responses, summarizes, and stores the toolkit-side decision.

### Mode → journal kind / tags

| Mode | kind | tags | content shape |
|---|---|---|---|
| WATCH-START | `pr_watch_start` | `["pr-watch","start","pr:<canonical>"]` (+ `"label:..."`, `"mergeMode:..."`) | `<canonical> watch started` (+ optional ` — <note>`) |
| WATCH-STOP | `pr_watch_stop` | `["pr-watch","stop","pr:<canonical>","reason:<merged|closed|manual>"]` | `<canonical> watch stopped — <reason>` |
| PULL — per inbound event | `pr_event_inbound` | `["pr-watch","inbound","pr:<canonical>","evt:<toolkitKey>","type:<eventType>"]` | `<canonical> <type> received — <summary>` |
| VALIDATE — per resolved event | `pr_event_resolved` | `["pr-watch","resolved","pr:<canonical>","evt:<toolkitKey>","type:<type>","decision:<accepted|rejected|deferred>"]` (+ `"reply:<id>"`) | `<canonical> <type> <decision> — <reasoning>` |

Recover full lifecycle history with `journal_search "pr-watch"` (= the same tag-shaped recall pattern that `spec-pact` uses).

## Inputs

- **PR handle** — `owner/repo#123` or `https://github.com/owner/repo/pull/123`. The `pr_*` tools normalize it.
- **External MCP results** — caller (mindy) collects raw payloads from `mcp__github__pull_request_read` etc. and feeds each event into `pr_event_record` one at a time.
- **Validation context** — for VALIDATE, mindy reads the local code with `read` / `glob` / `grep` only. mindy does **not** run `bun test` / `tsc` / lint commands itself (`bash: deny`); when the user wants type / test backing, they run those externally and tell mindy the result in one line.

## Tool usage rules

1. **Toolkit tools never call GitHub.** The 6 `pr_*` tools only read / write the journal. GitHub fetch is always the caller's external MCP.
2. **One mode per turn.** WATCH-START does not flow into PULL in the same turn; PULL does not flow into VALIDATE.
3. **Polling is explicit.** PULL only runs when the user / caller asks; the skill does not loop or schedule. A bare PR URL / handle is context, not a trigger.
4. **Idempotency lives in the reducer.** `pr_event_record` returns `alreadySeen: true` when the same `(handle, type, externalId)` has *ever* been inbound (resolved 여부 무관) — mindy uses this to skip already-processed comments without disk dedup. GitHub list-comments 류는 매 polling 마다 과거 항목까지 반복 반환하므로, resolve 된 코멘트가 다시 들어와도 새 이벤트로 surface 되지 않는다.
5. **`bash: deny`.** Even though the skill's `allowed-tools` does not include `bash`, mindy's frontmatter doubles down — never run `gh` CLI, `curl`, or `bun test` from this skill.
6. **`pr_event_resolved` is single-author.** Only the conducting agent (mindy) writes it. Other agents / skills can suggest a decision; only mindy commits it.

## Mode 1 — WATCH-START

Register a PR for review watch.

### Steps

1. **Read the journal.** `journal_read({ tag: "pr:<canonical>", limit: 50 })` — quote any prior `pr_watch_start` / `pr_watch_stop` so the user knows whether this is a re-start.
2. **Optionally read `agent-toolkit.json`'s `github.repositories`** — when the repo is registered, surface its `defaultBranch` / `mergeMode` / `labels` for context. When unregistered, proceed anyway — registration is advisory, not mandatory.
3. **Call `pr_watch_start`** with the handle plus optional `note` / `labels` / `mergeMode`.
4. **Return**: a one-line confirmation + the next-step hint (run PULL when new comments are expected).

### Output format (WATCH-START)

```markdown
# PR watch — <canonical>

> source: <PR URL or canonical>

- 등록 완료 (journal entry: `<id>`)
- 다음 단계: 새 코멘트가 올라왔을 때 `@mindy <canonical> 코멘트 확인` 으로 PULL 모드 호출.
```

## Mode 2 — PULL

Fetch new events through the external GitHub MCP and store each one in the toolkit's queue.

### Steps

1. **Verify the watch is active.** `pr_watch_status` — when the handle is not active, prompt the user to call WATCH-START first; do not silently start one.
2. **Read prior inbound entries** for the handle (`journal_read({ tag: "pr:<canonical>", kind: "pr_event_inbound" })`) so the next step knows what's "new".
3. **Call the external GitHub MCP** to gather:
   - PR meta (`mcp__github__pull_request_read`) — body, head sha, mergeable, merged.
   - issue-level comments — depending on the MCP server, a list-comments call.
   - inline review comments — depending on the MCP server, a list-review-comments call.
   - check-runs / status — `mcp__github__get_commit` on the head sha or a dedicated checks call.
   The exact tool names belong to the GitHub MCP server's surface; the skill cites them but does not execute them.
4. **For each new event**, call `pr_event_record` with the appropriate type:
   - `issue_comment`           → top-level PR comment.
   - `pr_review`               → review submission (approved / requested-changes / commented).
   - `pr_review_comment`       → inline review comment.
   - `check_run`               → CI / check-run conclusion (success / failure / neutral / cancelled).
   - `status`                  → legacy commit status.
   - `merge`                   → merged signal (sha as externalId).
   - `close`                   → closed without merge (timestamp as externalId).
   `summary` should be one line — author + short verbatim excerpt (max ~120 chars). Do not paste the full comment body into the journal.
5. **List pending events** — `pr_event_pending` after recording finishes — and surface them as a numbered list to the user.
6. **Auto-stop on merge / close.** When a `merge` or `close` event was just recorded *and* the latest external MCP read confirms the PR is no longer open, transition automatically to **WATCH-STOP** by calling `pr_watch_stop` (`reason: merged` or `reason: closed`). This is the *only* automatic mode transition in the skill.

### Output format (PULL)

```markdown
# PR PULL — <canonical>

> source: <PR URL>
> watch active (started: <시각>)

## 새 이벤트
1. (`<toolkitKey>`) `<type>` — <summary 한 줄>
2. ...

## 미처리 (pending)
- 총 <N> 건. `@mindy <canonical> 1번 검증해줘` / `... 모두 검증해줘` 로 VALIDATE 호출.

(머지/닫힘이 감지된 경우)
- `pr_watch_stop` 자동 호출됨 (reason: merged|closed). watch 종료.
```

## Mode 3 — VALIDATE

Validate one or more pending events against the codebase, post replies through the external MCP, and mark them resolved.

### Steps

1. **Pick the targets.** Either a specific 1-based index from the latest PULL list, or "모두" (= all currently pending). Resolve to `(handle, type, externalId)` triples by calling `pr_event_pending` and matching by `toolkitKey`.
2. **For each target**:
   1. **Quote the event** — author, summary, evt key — so the user can verify what's being validated.
   2. **Validate against the code** with `read` / `glob` / `grep` only. Allowed signals: file contents, file existence, simple substring patterns. *Not* allowed: running tests / lint / type check / arbitrary shell.
   3. **Decide**:
      - `accepted` — the comment's request is correct and within scope. Author the fix as a Korean reply, indicate that *the user* must commit / push the actual code change (mindy never edits code). Or: when the comment was a simple "approve" / "lgtm", reply with thanks and resolve the thread.
      - `rejected` — the comment's request is incorrect, out of scope, or contradicts a prior agreement. Author a Korean counter-argument citing the SPEC / journal / code line numbers.
      - `deferred` — the request is reasonable but not in scope for this PR. Author a Korean reply suggesting a follow-up issue / PR.
   4. **Post the reply through the external GitHub MCP** — caller picks the right tool from the list in §"Mental model" depending on event type (inline reply vs issue comment vs review-level reply).
   5. **Resolve.** `pr_event_resolve` with `decision`, `reasoning` (한 줄), and `replyExternalId` (the comment id the MCP returned).
3. **Surface the result list** — one bullet per resolved event with decision + reply link / id.

### Output format (VALIDATE)

```markdown
# PR VALIDATE — <canonical>

> source: <PR URL>

## 적용된 결정
1. `<toolkitKey>` (`<type>`) → `<decision>`
   - 근거: <한 줄 reasoning>
   - 답글: `<reply id>` (외부 MCP 가 반환)
2. ...

## 다음 단계
- 코드 수정이 필요한 항목은 사용자가 직접 commit / push.
- 추가 코멘트가 올라오면 `@mindy <canonical> 코멘트 확인` 으로 PULL 재호출.
```

## Mode 4 — WATCH-STOP

Unsubscribe from the watch.

### Steps

1. **Verify state.** `pr_watch_status` — when the handle is not active, return "이미 stop 상태" on a single line.
2. **Determine the reason.** `merged` (PR merged externally) / `closed` (closed without merge) / `manual` (user explicitly asked to stop) — `STOP_REASONS` enum 외 값은 `pr_watch_stop` 도구가 throw 한다 (자유 문자열 금지). When PULL detected merge / close in the same turn, that turn already auto-stopped — caller would only invoke WATCH-STOP manually for `manual`.
3. **Call `pr_watch_stop`** with `reason`.
4. **Surface a one-line confirmation** + a final pending count from `pr_event_pending` (so the user knows whether anything was left unresolved).

### Output format (WATCH-STOP)

```markdown
# PR watch stop — <canonical>

> reason: <merged | closed | manual>

- watch 종료 (journal entry: `<id>`)
- stop 시점 미처리 이벤트: <N> 건 (있다면 `@mindy <canonical> 1번 검증해줘` 로 마저 처리 가능 — append-only 라 stop 후에도 살아있다)
```

## Validation criteria — what counts as "타당한 코멘트"

MVP 의 명시적 한계: mindy 는 LLM 판단 + `read` / `glob` / `grep` 만 쓴다. typecheck / test / lint 결과를 직접 굴려서 검증하지 *않는다*.

- **accepted 판정 가이드**: 코멘트가 가리키는 파일 / 라인이 실제 존재하고, 지적이 코드와 일치하고 (예: "여기 await 가 빠짐" → `grep` 결과 await 가 빠진 줄이 보임), SPEC / journal 의 합의를 거스르지 않을 때.
- **rejected 판정 가이드**: 지적이 사실과 다르거나 (`grep` 으로 코드를 확인했더니 이미 그렇게 돼 있음 / 그 줄에 그런 코드가 없음), SPEC 의 명시 합의를 뒤엎으려 할 때 (e.g. spec-pact 의 `spec_anchor` 가 다르게 정해져 있음), PR 의 scope 를 넘어선 요구일 때.
- **deferred 판정 가이드**: 지적이 합리적이지만 이 PR 의 scope 가 아닐 때.

타입 / 테스트 결과로 명백히 갈리는 코멘트는 mindy 가 직접 굴리지 않고 — 사용자가 먼저 `bun test` / `tsc` 를 굴려 결과 한 줄을 mindy 에게 알려주는 흐름이 권장. (`spec-pact` 의 VERIFY 모드가 grep 을 caller 에 맡기는 분리 패턴과 동일.)

## Writing rules

- 모든 답글은 **한국어** (코드 identifiers / paths / commands / API paths / library names 는 영어 그대로). agent-toolkit 의 `Output / communication` 룰과 동일.
- inline reply 는 짧게 — 한두 문장 + 필요 시 `file:line` 인용.
- 반박 답글에서 SPEC / journal entry 를 인용할 때는 entry id 를 함께 박아 추적 가능하게.
- mindy 가 직접 코드를 짜지 않는다. accepted 결정은 "이 위치를 이렇게 수정하면 된다" 의 *권고* 까지만 — 실제 commit 은 사용자.

## Do NOT

- **Do not call the GitHub API directly.** No `fetch`, no `gh` CLI, no `curl`. External GitHub MCP only.
- **Do not bundle two modes in one turn.** WATCH-START → PULL → VALIDATE 는 각각 별도 turn (단, PULL 의 머지/닫힘 자동 stop 만 예외).
- **Do not run tests / typecheck / lint.** `bash: deny` 이며, 그 결과가 필요하면 사용자가 굴려서 한 줄로 알려준다.
- **Do not edit code.** mindy 의 frontmatter 도 `edit: deny`. accepted 결정도 *권고* 까지만.
- **Do not auto-merge.** 머지는 외부 MCP / 사용자 / Claude Code 의 책임. PULL 에서 머지 *결과* 만 관찰.
- **Do not invent journal kinds beyond the four (`pr_watch_start` / `pr_watch_stop` / `pr_event_inbound` / `pr_event_resolved`).** 다른 lifecycle 신호가 필요해지면 별도 PR.
- **Do not auto-extend the watch.** stop 후 새 코멘트가 들어와도 자동 재시작하지 않는다 — caller 가 명시적으로 WATCH-START 다시.

## Failure / error handling

- **PR handle 추출 실패** → 입력을 그대로 인용하고 한 번 묻고 멈춘다.
- **외부 GitHub MCP 미등록 / 호출 실패** → 어떤 MCP 도구가 필요한지 한 줄로 명시 (`mcp__github__pull_request_read` 등) 하고, 사용자에게 GitHub MCP 의 등록 상태를 확인하라고 한 번 묻고 멈춘다.
- **`pr_event_record` 가 `alreadySeen: true` 만 반환** → "새 이벤트 없음" 으로 응답하고 멈춘다 (PULL 결과 0 건).
- **`pr_event_resolve` 가 가리키는 inbound 가 없는 경우** → 도구 자체가 throw 한다 (`no prior pr_event_inbound for handle "..." + toolkitKey "..."`). orphan resolve 가 박히면 reducer 의 `resolvedKeys` 에 그 toolkitKey 가 포함되어 이후 진짜 inbound 가 들어와도 영구 제외 (큐 유실) 되므로 handler 단에서 끊는다. caller 는 `pr_event_pending` 으로 정확한 toolkitKey 를 다시 확인 후 재호출.
- **`agent-toolkit.json` 의 `github.repositories` 미등록 repo** → 진행은 가능 (등록은 advisory) 하지만 한 줄 안내 ("이 repo 는 등록 안 됨 — labels / mergeMode 권고를 받지 못합니다").
- **stop 후 동일 turn 의 추가 호출** → "이미 stop 상태" 한 줄로 멈춘다.
