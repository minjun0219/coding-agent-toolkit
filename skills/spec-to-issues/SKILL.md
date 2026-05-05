---
name: spec-to-issues
description: UNSTABLE tool surface (`unstable_issue_*`) for testing; sync a locked SPEC (under `<spec.dir>/<slug>.md` or `**/SPEC.md`) into a GitHub epic + sub-issue series via the user's `gh` CLI. Idempotent — re-runs are no-ops, additive bullets create only the new sub. Two-step flow — `unstable_issue_status` (or `dryRun: true`) first to inspect the plan, then `dryRun: false` to apply. `unstable_issue_status` 는 journal 을 남기지 않는 read-only 관측용. Conducted by `rocky` (NOT `grace` — grace's finalize/lock authority stops at the SPEC; GitHub-side state is rocky's surface). Auto-trigger when a SPEC slug or path appears together with phrases like "이슈로 만들어줘" / "GitHub 이슈 동기화" / "issue 시리즈로 쪼개줘" / "이슈 상태 보여줘".
allowed-tools: [unstable_issue_create_from_spec, unstable_issue_status, journal_append, journal_read, journal_search, read]
license: MIT
version: 0.1.0
---

# spec-to-issues

## Role

* Bridge between the local SPEC layer (`<spec.dir>/<slug>.md` or `**/SPEC.md`, finalize/lock owner = `grace`) and a GitHub repo's issue tracker. **One-way only** — SPEC is the source of truth; we never write back from issue → SPEC in this PR.
* One SPEC = one **epic** issue. Each top-level bullet under `# 합의 TODO` = one **sub-issue**. Both epic and subs carry an invisible HTML-comment marker so re-runs match by content, not by title.
* Two-step contract — `dryRun: true` first to surface the plan, then `dryRun: false` (with the user's explicit "apply") to actually call `gh`.
* Conducted by `rocky` (`agents/rocky.md`). `grace` (`agents/grace.md`) does not touch this skill — grace's finalize/lock authority covers the SPEC layer only; once a SPEC is locked, downstream sync is rocky's contract.

## Mental model

```
caller  ──► rocky  ──► spec-to-issues
                          ├── 0. read SPEC          ← <spec.dir>/<slug>.md (parseSpecFile — locked only, # 합의 TODO required)
                          ├── 1. unstable_issue_status       ← dryRun=true, plan only (1 gh call: issue list --label spec-pact)
                          ├── 2. surface plan       ← user reviews; explicit "apply" required
                          ├── 3. unstable_issue_create_from_spec ← dryRun=false; creates missing subs first, then patches/creates epic with sub numbers
                          └── 4. journal_append     ← single entry on apply only, tags ["spec-pact","spec-to-issues","applied"]
```

## Precondition

`gh` CLI must be installed AND authenticated for the target repo. The plugin tool runs `gh auth status` on every invocation — failure throws a one-line guide.

```
$ gh --version           # required: gh ≥ 2.40 (older gh has --json label shape differences)
$ gh auth status         # required: exit 0
$ gh auth login --scopes "repo"   # if not authenticated
```

GHE / Enterprise: use `gh auth login --hostname <host>` once. The plugin does not carry a custom API URL — `gh` handles host routing.

## Inputs

- **slug** OR **path** (exactly one) — SPEC slug (`user-auth`) or absolute/relative SPEC path (`.agent/specs/user-auth.md`).
- **repo** (optional) — `owner/name`. Precedence: this param > `agent-toolkit.json`'s `github.repo` > `gh repo view --json nameWithOwner` (auto-detect from cwd).
- **dryRun** (optional, default `true`) — `true` = plan only, `false` = apply.

## Tool usage rules

1. **Always start with `unstable_issue_status`** (or `unstable_issue_create_from_spec` with `dryRun: true`) before applying. Surface the plan to the user, wait for explicit "apply" / "동기화 진행해" / "이슈 만들어줘 (확인 후)".
2. **One SPEC per turn.** Multi-SPEC batch is out of scope — each call handles one slug/path.
3. **Do not retry on `GhAuthError` or `GhNotInstalledError`.** Surface the one-line guide and stop. The user must run `gh auth login` or install `gh`.
4. **Use `read` only to peek SPEC files** when a path was given but you want to preview frontmatter. Plugin tool is the only path that calls `gh`.
5. **Never modify the SPEC file.** SPEC is `grace`'s surface — if drift / re-anchoring is needed, route to `@grace SPEC drift <slug>` instead.
6. **`journal_append` is automatic on apply only** (the plugin tool handles this — do not double-append). `unstable_issue_status` and `dryRun: true` calls do NOT produce journal entries.

## Output format

### Status / dry-run

```markdown
# spec-to-issues plan — <slug>

> repo: <owner/name>
> SPEC: <path>
> dedupe label: <label>

## Epic
- existing? #<n> <url> | (will create) [spec] <slug> v<n>

## Subs
- [<existing|will create>] index 1 — <bullet> ↳ #<n>?
- [<existing|will create>] index 2 — <bullet> ↳ #<n>?
- ...

## Orphans (subs whose bullet was removed from the SPEC)
- index <n>  (action: surfaced only — sub is NOT auto-closed in this PR)

## 다음 단계
- 그대로 적용하려면 `dryRun: false` 로 다시 호출.
- SPEC 가 의도와 어긋나면 `@grace AMEND <slug>` 로 SPEC 부터 고친 뒤 재시도.
```

### Apply

```markdown
# spec-to-issues applied — <slug>

> repo: <owner/name>

## 생성
- epic #<n> <url>
- sub #<n> <url>
- ...

## 재사용
- epic #<n>
- sub #<n> ...

## Epic body
- patched? <yes/no>

journal_append: 1 entry (tags: spec-pact, spec-to-issues, applied)
```

> **Note**: `unstable_issue_status` and `dryRun: true` calls do **not** produce journal entries — they are read-only operations.

## Failure modes

- **gh not installed** → `GhNotInstalledError`: surface install URL (`https://cli.github.com`), stop.
- **gh not authenticated** → `GhAuthError`: surface `gh auth login --scopes "repo"`, stop.
- **SPEC not found** → `ENOENT` on `<spec.dir>/<slug>.md` — surface the resolved path verbatim and ask user to confirm slug/path. **Directory-mode SPEC (`**/SPEC.md`) is not slug-resolvable in this PR** — caller must pass the full `path` instead. INDEX-based slug → directory-mode lookup is a follow-up PR.
- **SPEC status !== locked** → throw with current status + recommend running the SPEC-pact lifecycle first (DRAFT or AMEND).
- **`# 합의 TODO` empty** → throw — there is nothing to sync. SPEC may still be in DRAFT negotiation; re-anchor with grace.
- **Same dedupe label used by other tooling** → epic / subs may misfire. Recommend a unique label (config `github.defaultLabels[0]`).
- **Human removed the dedupe label from an existing epic / sub** → marker is still in the body, but `gh issue list --label` filter excludes it. This PR's `--search "<marker-prefix>"` narrows the result set to one SPEC, but the list is still gated by the dedupe label, so a label-removed issue is missed → re-sync would create duplicates. Mitigation: keep the dedupe label stable. Marker-only fallback (search without label) is a follow-up PR.
- **`# 합의 TODO` bullet 재정렬 또는 내용 변경** → marker 가 같은 index 를 가리키고 있으면 sub 는 reuse 되며 body 는 patch 되지 않는다 (즉 GitHub 측 sub body 와 SPEC bullet 이 어긋난 상태로 남는다). bullet 이동 / 내용 mutation 감지는 surface 만 — orphan 처럼 plan 의 `mismatched: number[]` 로 후속 PR 에서 surface 예정. 이번 PR 의 contract 는 **marker = ground truth** 이고, bullet 변경은 별도 AMEND 흐름.
- **`gh issue edit` overwrite race** → patches the epic body fully each time. If a human added prose to the epic body between our list and edit, that prose is lost. Mitigation in this PR: epic body always rerendered from current bullets — DO NOT add prose to epic body manually; use sub issues for discussion. Pre-patch conflict guard (re-fetch + diff non-marker / non-task-list lines → abort) is a follow-up PR.

## Do NOT

- **Do not write back to the SPEC file.** SPEC is grace's surface.
- **Do not auto-close orphan subs** (subs whose bullet was removed from the SPEC). The plan surfaces them only.
- **Do not auto-reopen closed subs.** If user closed an issue manually, leave it closed.
- **Do not bundle `dryRun=true` and `dryRun=false` in one turn.** User reviews the plan in turn N, then approves apply in turn N+1.
- **Do not invent labels.** Use `agent-toolkit.json`'s `github.defaultLabels` (or the default `["spec-pact"]`) verbatim.
- **Do not call `gh` directly via Bash.** Use the plugin tools — they handle auth check, repo detection, and journal append in lockstep.

## Memory (journal)

The plugin tool appends one entry per call. Tag scheme:

| Stage | tags | content shape |
|---|---|---|
| applied | `["spec-pact","spec-to-issues","applied"]` | `<slug> applied: epic+E subs+S patched=B` |

> `unstable_issue_status` 와 `dryRun: true` 경로는 journal entry 를 남기지 않습니다. apply (`dryRun: false`) 완료 후에만 위 entry 가 append 됩니다.

Recovery — to see the full sync history of any SPEC, use the tag-shaped query:
`journal_search "spec-to-issues"`.
