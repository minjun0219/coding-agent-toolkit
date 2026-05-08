# Removal Candidates

이 문서는 추후 PR 에서 실제로 코드를 제거할 후보 도메인을 추적한다. **이 PR 에서는 어떤 파일도 삭제하지 않는다** — opencode 진입점에서는 28 tool 모두 그대로 동작하고, Claude Code MCP 서버 (`server/index.ts`) 만 19 tool 로 좁힌 surface 를 노출한다. 실제 제거 시점·범위는 별도 PR 로 결정한다.

원칙:

1. **이 문서에 적힌 모든 파일은 일단 보존한다.** 제거는 사용자 승인을 거친 후속 작업.
2. 의존성을 함께 적어 둔다 — A 를 지우면 자동으로 깨지는 B 가 있으면 그것도 명시.
3. 이미 Claude Code surface 에서는 9 개 tool 이 빠져 있다 (`server/index.ts` 미등록). 이 사실은 사용자 노출 면을 이미 줄여 둔 것이지, 코드 보존 결정과 무관.

## 1. 사용자가 명시한 즉시 제거 후보

### `pr-watch`

| 항목 | 경로 |
| --- | --- |
| 코어 모듈 | `lib/pr-watch.ts` |
| 단위 테스트 | `lib/pr-watch.test.ts` |
| 에이전트 | `agents/mindy.md` |
| 스킬 | `skills/pr-review-watch/SKILL.md` (+ 스킬 디렉터리 전체) |
| Plugin tool | `pr_watch_start` / `pr_watch_stop` / `pr_watch_status` / `pr_event_record` / `pr_event_pending` / `pr_event_resolve` (`.opencode/plugins/agent-toolkit.ts`) |
| `agent-toolkit.json` 키 | `github.repositories` (PR review watch 용) |
| 영향 받는 호출자 | 없음 — 자급 도메인. `rocky.md` 의 `@mindy` 라우팅 규칙은 함께 제거. |
| Claude Code surface | 이미 6 개 tool 모두 미등록. |

### `gh-cli`

| 항목 | 경로 |
| --- | --- |
| 코어 모듈 | `lib/gh-cli.ts` |
| 단위 테스트 | `lib/gh-cli.test.ts` |
| 영향 받는 호출자 | `lib/github-issue-sync.ts` (spec-to-issues 의존), `.opencode/plugins/agent-toolkit.ts` 안의 `handleGhRun` / `handleIssueCreateFromSpec` / `handleIssueStatus`. → spec-to-issues, gh-passthrough 도 함께 깨진다 (아래 §2 참고). |
| Claude Code surface | gh-cli 자체는 tool 이 아니므로 직접 노출 없음. 의존하는 `gh_run` / `issue_*` 가 미등록. |

### `gap-coverage`

| 항목 | 경로 |
| --- | --- |
| 테스트 | `lib/gap-coverage.test.ts` |
| 코어 모듈 | (없음 — 테스트만 존재) |
| 영향 받는 호출자 | 없음. |

## 2. 추가 후보 (gh-cli 제거 시 동반 영향)

`gh-cli` 를 지우면 다음 도메인이 컴파일·런타임 양쪽에서 깨진다 — 동시에 정리하거나, gh-cli 제거를 보류하거나 둘 중 하나.

### `spec-to-issues`

| 항목 | 경로 |
| --- | --- |
| 코어 모듈 | `lib/github-issue-sync.ts` |
| 단위 테스트 | `lib/github-issue-sync.test.ts` |
| 스킬 | `skills/spec-to-issues/SKILL.md` (+ 디렉터리 전체) |
| Plugin tool | `issue_create_from_spec` / `issue_status` |
| `agent-toolkit.json` 키 | `github.repo` / `github.defaultLabels` |
| 영향 받는 호출자 | `rocky.md` 의 spec-to-issues 라우팅 규칙. |
| Claude Code surface | 이미 2 개 tool 미등록. |

### `gh-passthrough`

| 항목 | 경로 |
| --- | --- |
| 코어 모듈 | (별도 lib 없음 — `.opencode/plugins/agent-toolkit.ts` 의 `handleGhRun` 인라인) |
| 스킬 | `skills/gh-passthrough/SKILL.md` (+ 디렉터리 전체) |
| Plugin tool | `gh_run` |
| 영향 받는 호출자 | `rocky.md` 의 gh-passthrough 라우팅 규칙. |
| Claude Code surface | 이미 1 개 tool 미등록. |

## 3. 추가 후보 (사용자 첫 답변에서 거론, 추후 결정)

다음 도메인은 한때 "공격적 제거" 옵션 후보로 거론되었으나 이번 작업에서는 *유지* 한다. Claude Code surface 에서는 모두 그대로 노출된다.

### `spec-pact`

| 항목 | 경로 | 결정 |
| --- | --- | --- |
| 코어 모듈 | `lib/spec-pact-fragments.ts` | 유지 |
| 에이전트 | `agents/grace.md` | 유지 |
| 스킬 | `skills/spec-pact/` | 유지 |
| Plugin tool | `spec_pact_fragment` | 유지 (Claude Code surface 에 등록) |
| `agent-toolkit.json` 키 | `spec.dir` / `spec.scanDirectorySpec` / `spec.indexFile` | 유지 |

### `journal`

| 항목 | 경로 | 결정 |
| --- | --- | --- |
| 코어 모듈 | `lib/agent-journal.ts` | 유지 |
| Plugin tool | `journal_append` / `journal_read` / `journal_search` / `journal_status` | 유지 (Claude Code surface 에 모두 등록) |
| 비고 | Claude Code 자체의 기억 / `CLAUDE.md` 와 표면이 일부 겹쳐 보일 수 있어 추후 재검토 가능. 단, 토킷의 turn-spanning 결정·블로커 로그는 외부 호스트에 의존하지 않는 가치가 있다 — 지금 결정은 *유지*. |

## 4. 본 PR 적용 후 동작 상태

| 진입점 | tool 수 | 비고 |
| --- | --- | --- |
| opencode (`.opencode/plugins/agent-toolkit-server.ts`) | 28 | 변경 없음 — 기존 사용자 그대로 동작. |
| Claude Code (`server/index.ts` via `.mcp.json`) | 19 | `pr_*` ×6 + `gh_run` ×1 + `issue_*` ×2 = 9 미등록. 코드 파일은 모두 살아 있음. |

## 5. 후속 PR 으로 옮길 작업 (제안)

순서:

1. **gap-coverage** 제거 — 의존자 없음. 가장 안전한 첫 단계.
2. **pr-watch** 제거 — 자급 도메인. mindy 라우팅도 함께 정리.
3. **gh-cli + spec-to-issues + gh-passthrough** 동시 제거 — gh-cli 의 의존자 두 개를 같은 PR 에 묶어야 컴파일이 깨지지 않는다. rocky 라우팅도 함께 정리.
4. (선택) **journal** / **spec-pact** 재검토 — 사용자 피드백 후.

각 단계는 별도 PR 으로 가는 것을 기본값으로 한다. 테스트 + 사용자 surface (`README` / `FEATURES.{md,ko.md}` / `AGENTS.md` / `agent-toolkit.schema.json`) 동기화는 각 PR 에서 처리.
