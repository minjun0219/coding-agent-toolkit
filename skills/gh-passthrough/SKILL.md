---
name: gh-passthrough
description: Run ad-hoc `gh` CLI commands through the `gh_run` plugin tool. Read commands (auth status / repo view / issue list / pr view / api default GET / search / gist list|view / ...) execute immediately. Write commands (issue create / label create / api --method POST / api with body flags `-f`/`-F`/`--field`/`--input`/`--body-file` — default POST → write / ...) are guarded by `dryRun: true` (default) — caller must explicitly pass `dryRun: false` to apply. Denied commands (`pr merge`, `repo edit|delete`, `release delete`, `workflow run|enable|disable`, `run rerun|cancel`, `auth login|logout|refresh|setup-git|token`, `extension *`, `alias *`, `config *`, `gist create|edit|delete|clone`) throw `GhDeniedCommandError` immediately — `gist list|view` itself is allowed as read. All calls (read / dry-run / applied) produce a journal entry. Conducted by `rocky`. Auto-trigger when the user wants to inspect or mutate GitHub state outside the spec-to-issues flow — e.g. "이슈 검색해줘", "label 만들어줘", "GitHub API 로 release 한번 봐줘".
allowed-tools: [gh_run, journal_append, journal_read, journal_search]
license: MIT
version: 0.1.0
---

# gh-passthrough

## Role

* Single-tool passthrough to the user's `gh` CLI for ad-hoc GitHub work that doesn't fit a high-level skill (`spec-to-issues` 같은 specific flow 가 없을 때).
* **dryRun-first contract for write** — write 명령은 한 번에 두 단계로: dryRun=true 로 plan 보여주고, 사용자 확인 후 dryRun=false 로 apply.
* **Environment-affecting commands are denied**, not gated. `auth login|logout|refresh|setup-git|token` / `extension *` / `alias *` / `config *` / `gist create|edit|delete|clone` 같은 호출은 plugin 단에서 `GhDeniedCommandError` 로 throw — Rocky 가 우회하지 말 것. `gist list|view` 자체는 read 로 허용 (read-only 정보 조회).

## Mental model

```
caller  ──► rocky  ──► gh-passthrough
                         ├── 0. assertGhAuthed   ← gh auth status (auth status 호출일 때는 skip)
                         ├── 1. classifyGhCommand
                         │       ├── read  → 즉시 실행
                         │       ├── write → dryRun=true (기본) plan 만 / dryRun=false 실행
                         │       └── deny  → throw
                         ├── 2. surface result   ← stdout / stderr / exitCode + kind 표기
                         └── 3. journal_append   ← tags ["gh-passthrough", "read"|"dry-run"|"applied"]
```

## Precondition

`gh` CLI 가 설치 + 인증되어 있어야 한다. plugin 이 매 호출마다 `gh auth status` 를 verify (단 `gh_run` 의 첫 인자가 `auth` 면 skip — verify 가 곧 본 호출).

```
$ gh --version           # gh ≥ 2.40 권장
$ gh auth status         # exit 0 필요
$ gh auth login --scopes "repo"   # 미인증 시
```

## Inputs

- **args** (필수, string[]) — `gh` 의 subcommand 부터 시작하는 인자 배열. 예: `["issue", "list", "--repo", "x/y", "--label", "bug"]`. shell escape 자동 처리 (`spawn` 사용) — `;` 같은 메타문자는 literal.
- **dryRun** (선택, boolean, 기본 `true`) — write 호출에서만 의미. read 는 무시 (항상 실행).

## 분류 정책

| Kind | 동작 | 예시 |
|---|---|---|
| **read** | 즉시 실행, dryRun 무시 | `auth status` / `repo view` / `issue list|view|status` / `pr list|view|status|diff|checks` / `label list` / `release list|view` / `search ...` / `api ...` (default GET — body flag 없음) / `workflow list|view` / `run list|view|watch` |
| **write** | dryRun=true 면 plan, false 면 실행 | `issue create|edit|close|reopen|delete|comment|...` / `pr create|edit|close|reopen|ready|review|comment|checkout` / `repo create|clone|fork|sync|archive|rename` / `label create|edit|delete` / `release create|edit|upload` / `run delete` / `api --method POST|PUT|PATCH|DELETE` / `api ...` **body-bearing flag** (`-f` / `-F` / `--field` / `--raw-field` / `--input` / `-b` / `--body-file`) 가 하나라도 있으면 default POST → write |
| **deny** | 즉시 throw | `pr merge` / `repo edit|delete` / `release delete` / `workflow run|enable|disable` / `run rerun|cancel` / `auth login|logout|refresh|setup-git|token` / `extension *` / `alias *` / `config *` / `gist create|edit|delete|clone` / 알 수 없는 subcommand |

`gh api` 의 method 결정: 명시적 `--method <verb>` / `-X <verb>` / `--method=<verb>` 가 우선. 그 외엔 `gh api` 매뉴얼대로 — body-bearing flag (`-f` / `-F` / `--field` / `--raw-field` / `--input` / `-b` / `--body-file` 또는 attached form `--field=...`) 가 있으면 **default POST** (write), 없으면 default GET (read). 즉 `gh api repos/x/y/issues -f title=...` 는 method 미지정이라도 write 로 분류되어 dryRun guard 를 통과한다.

## Tool usage rules

1. **Always `dryRun: true` first** for write 명령. plan 을 사용자에게 보여주고 명시적 "apply" / "동기화 진행해" / "그대로 실행해" 를 받은 다음에만 dryRun=false 로 재호출.
2. **One call per turn.** 여러 명령을 한 turn 에 chain 하지 말 것 — 사용자가 각 단계의 결과를 보고 결정하도록.
3. **Do not retry on `GhAuthError` / `GhNotInstalledError` / `GhDeniedCommandError`.** 한 줄 가이드 surface 후 stop.
4. **Do not bypass deny via shell tricks.** plugin 의 분류는 args[0..1] 기반이지만, agent 가 `["sh", "-c", "gh auth login"]` 같은 우회를 시도하지 말 것 — 정책 위반.
5. **Do not parse stdout silently.** raw passthrough 가 원칙. JSON parsing 이 필요하면 `--json` flag 로 gh 가 정규화한 JSON 을 받고, agent 가 명시적으로 파싱.
6. **Use `spec-to-issues` instead** when the task is "잠긴 SPEC 을 epic + sub 시리즈로". `gh_run` 은 SPEC 과 무관한 ad-hoc 호출용.

## Output format

### Read

```markdown
# gh read — `gh <args...>`

> kind: read | exitCode: <n>

## stdout
<stdout 내용 — 길면 cap 표시>

## stderr (있을 때만)
<stderr>
```

### Write dryRun

```markdown
# gh write plan — `gh <args...>`

> kind: write | dryRun: true | executed: false

## 실행될 명령
gh <args...>

## 다음 단계
- 그대로 실행: `gh_run({ args: [...], dryRun: false })`
- 명령을 수정하려면 args 를 바꿔서 다시 dryRun.
```

### Write apply

```markdown
# gh write applied — `gh <args...>`

> kind: write | dryRun: false | exitCode: <n>

## stdout
<gh 의 출력 — 보통 새로 만들어진 issue/pr/release URL>

## stderr (있을 때만)
<stderr>
```

## Failure modes

- **gh not installed** → `GhNotInstalledError`: `https://cli.github.com` 안내, stop.
- **gh not authenticated** → `GhAuthError`: `gh auth login --scopes "repo"` 안내, stop.
- **deny 분류** → `GhDeniedCommandError`: 어떤 args 가 왜 거부됐는지 surface, stop. 우회 시도 X.
- **알 수 없는 subcommand** → 보수적으로 deny 처리 (allow-list 정신). gh 새 버전의 subcommand 가 추가되면 follow-up PR 에서 분류 표 업데이트.
- **`gh` 명령 자체 실패 (exitCode !== 0)** → stderr 그대로 surface, stop. retry X.

## Do NOT

- **dryRun=true / dryRun=false 를 한 turn 에 묶지 말 것.** 사용자 승인이 두 turn 사이에 들어가야 함.
- **deny 명령을 우회하지 말 것** (`sh -c`, `gh extension exec`, alias 등).
- **stdout 을 silently 가공하지 말 것** — raw passthrough.
- **여러 호출을 chain 하지 말 것** — 한 turn 한 호출.

## Memory (journal)

| Stage | tags | content |
|---|---|---|
| read | `["gh-passthrough","read"]` | `gh <head> <verb> read` |
| write dryRun | `["gh-passthrough","dry-run"]` | `gh <head> <verb> dry-run` |
| write apply | `["gh-passthrough","applied"]` | `gh <head> <verb> applied` |

회수: `journal_search "gh-passthrough"`.
