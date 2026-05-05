# GitHub transport/effect 정책 매트릭스

목적: agent-toolkit 의 GitHub 관련 tool 이 어떤 transport 를 통해 어떤 side effect 를 만들 수 있는지 한 곳에 고정한다. 이 문서는 stabilization 기준 정책 artifact 이며, 후속 코드/스킬 정렬 작업의 판정 기준이다.

## Transport / effect vocabulary

### Transport

- `gh-cli`: 사용자 환경의 `gh` CLI 로 위임한다. 인증, repo auto-detect, GHE/host routing, scope 관리는 `gh` 책임이며 toolkit 은 토큰/API URL env 를 추가하지 않는다.
- `external-mcp`: PR meta, 코멘트, 답글, thread resolve, merge state 조회/머지 실행 같은 GitHub source-of-truth 작업은 외부 GitHub MCP 책임이다. toolkit 은 PR 코멘트/답글용 GitHub API 를 직접 호출하지 않는다.
- `journal-only`: GitHub 네트워크 없이 toolkit journal (`journal.jsonl`) 만 읽거나 append 한다.
- `local-config`: project/user `agent-toolkit.json` 또는 local SPEC 파일 같은 로컬 파일만 읽는다.

### Effects

- `githubRead`: GitHub 상태 조회. `gh-cli` 또는 `external-mcp` 가 수행한다.
- `githubWriteDryRun`: GitHub write 의 plan 산출만 하며 실제 GitHub mutation 없음.
- `githubWriteApply`: 실제 GitHub write 적용.
- `journalWrite`: toolkit journal append.
- `localFsRead`: local config/SPEC/journal 파일 read.
- `localFsWrite`: local filesystem write. GitHub tool 정책상 artifact/evidence 외 runtime GitHub tools 에는 기본적으로 없음.

## Tool matrix

| tool | transport | effects | notes |
|---|---|---|---|
| `issue_create_from_spec` (`dryRun:true`, 기본) | `local-config` + `gh-cli` | `localFsRead`, `githubRead`, `githubWriteDryRun` | locked SPEC 과 GitHub config 를 읽고 `gh issue list` 로 dedupe plan 을 산출한다. 정책상 dry-run 은 plan only 이며 **기본적으로 `journalWrite` 없음**. 실제 issue 생성/patch 없음. |
| `issue_create_from_spec` (`dryRun:false`) | `local-config` + `gh-cli` | `localFsRead`, `githubRead`, `githubWriteApply`, `journalWrite` | locked SPEC 을 기준으로 missing sub-issue 를 먼저 만들고 epic 을 create/patch 한다. `gh` 가 auth/repo/GHE/scope 책임을 가진다. apply 완료 후에는 sync 이력 1건을 journal 에 남길 수 있다. |
| `issue_status` | `local-config` + `gh-cli` | `localFsRead`, `githubRead`, `githubWriteDryRun` | read-only alias / status surface. `gh issue list` 기반으로 기존 epic/sub 와 생성 예정 plan/orphan 을 보여준다. **정책상 `issue_status` 는 기본적으로 `journalWrite` 없음**. |
| `gh_run` (read 분류) | `gh-cli` | `githubRead`, `journalWrite` | `auth status`, `repo view`, `issue list/view/status`, `pr view/list/status/diff/checks`, `label list`, `release list/view`, `search`, `api` GET/HEAD 등은 즉시 실행된다. passthrough 호출 이력은 `gh-passthrough/read` journal entry 로 남길 수 있다. |
| `gh_run` (write + `dryRun:true`, 기본) | `gh-cli` | `githubWriteDryRun`, `journalWrite` | write 로 분류되는 `issue create/edit`, `pr create/edit/close`, `label create/edit/delete`, `api` POST/PUT/PATCH/DELETE 등은 기본 dry-run 에서 실행하지 않는다. **단, `gh_run` 은 read/dry-run/applied 모든 호출 후 journal entry 를 남긴다** (`tags: ["gh-passthrough","dry-run"]`). 이는 `issue_create_from_spec(dryRun:true)`/`issue_status` 의 journal-free 정책과 구별된다. |
| `gh_run` (write + `dryRun:false`) | `gh-cli` | `githubWriteApply`, `journalWrite` | 사용자의 명시 apply 뒤에만 실제 `gh` write 를 실행한다. 성공한 apply 이력만 `gh-passthrough/applied` 로 journal 에 남길 수 있다. |
| `gh_run pr merge` | `gh-cli` | 없음 (`denied`) | **denied**. PR 머지는 mindy/toolkit 이 수행하지 않는다. merge 여부 관찰/상태 조회는 external MCP 또는 `gh_run` read surface, 실제 merge execution 은 toolkit passthrough 정책 밖으로 둔다. |
| `gh_run` (deny 분류) | `gh-cli` | 없음 (`denied`) | `auth login/logout/refresh/setup-git/token`, `extension *`, `alias *`, `config *`, `gist create/edit/delete/clone`, 알 수 없는 subcommand 는 즉시 거부한다. 환경 변경/비밀/확장 설치는 toolkit 책임 밖이다. |
| `pr_watch_start` | `journal-only` (+ optional `local-config`) | `localFsRead`, `journalWrite` | PR handle 을 normalize 하고 active watch start 를 journal 에 append 한다. repo 등록 정보(labels/defaultBranch/mergeMode)는 advisory local config 이며 GitHub 호출 없음. |
| `pr_watch_stop` | `journal-only` | `journalWrite` | watch stop reason (`merged`/`closed`/`manual`) 을 journal 에 append 한다. GitHub close/merge 를 실행하지 않는다. |
| `pr_watch_status` | `journal-only` | `localFsRead` | journal 을 reduce 해 active watches 와 pending count 를 보여준다. GitHub 호출/ journal append 없음. |
| `pr_event_record` | `journal-only` | `journalWrite` | 외부 GitHub MCP 가 가져온 이벤트(ref/comment/review/check/merge/close)를 one-line summary 로 journal 에 append 한다. raw GitHub payload 저장이나 GitHub 호출 없음. |
| `pr_event_pending` | `journal-only` | `localFsRead` | journal inbound/resolved entry 를 reduce 해 pending event 를 반환한다. GitHub 호출/ journal append 없음. |
| `pr_event_resolve` | `journal-only` + `external-mcp` boundary | `journalWrite` | 답글 post 자체는 **external MCP 책임**이고 toolkit 은 `replyExternalId` 와 decision (`accepted`/`rejected`/`deferred`) 만 journal 에 append 한다. inbound 없는 orphan resolve 는 거부되어야 한다. |

## Guardrails

1. PR 코멘트/답글/thread resolve/머지 상태 조회는 external GitHub MCP 책임이다. toolkit 의 `pr_*` 도구는 journal-only 이며 직접 GitHub API 를 호출하지 않는다. `fetch`, `curl`, `gh` 로 PR 코멘트/답글을 우회 호출하는 것도 금지한다.
2. `gh` CLI transport 는 사용자의 `gh auth login`, repo detection, GHE host routing, 권한 scope 를 그대로 사용한다. toolkit config 에 GitHub token, API key, password, custom API URL 을 추가하지 않는다.
3. `issue_status` 와 `issue_create_from_spec(dryRun:true)` 는 journal write 가 없어야 한다. `gh_run` 은 read/dry-run 포함 모든 호출이 journal entry 를 남기므로 구별된다. write apply 가 아닌 계획/조회 결과를 memory 로 고정하지 않는 것은 `issue_*` 도구에만 적용된다.
4. `gh_run pr merge` 는 denied 이다. Mindy/PR-watch 는 merge 를 실행하지 않고, merge/close 결과를 관찰해 watch 를 stop 할 뿐이다.
5. GitHub 관련 runtime tool 은 local GitHub source-of-truth 를 쓰지 않는다. local filesystem write 는 이 artifact/evidence 같은 Sisyphus 작업 산출물에 한정한다.
