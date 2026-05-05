# agent-toolkit 전체 기능 테스트 계획

이 문서는 agent-toolkit 의 전체 기능 리스트, 문서/툴/스킬/에이전트 라우팅 검증 계획, 그리고 Notion / GitHub / OpenAPI / MySQL 풀 테스트 시나리오를 재실행 가능하게 정리한 체크리스트다.

## 목표

- README / FEATURES / schema / skills / agents 가 서로 같은 표면을 설명하는지 확인한다.
- 모든 plugin tool 이 단위 테스트와 실제 `opencode run` smoke 테스트를 모두 통과하는지 확인한다.
- 모든 skill 이 의도한 tool 만 사용하고, agent routing 이 과잉 트리거되지 않는지 확인한다.
- Notion / GitHub / OpenAPI / MySQL 주요 통합 경로를 실제 외부/로컬 리소스로 검증한다.
- 도구 rename 또는 routing 정책 변경이 필요한 부분을 별도 migration 항목으로 남긴다.

## 기본 전제

- 런타임: Bun.
- 검증 레포: `/tmp/agent-toolkit-main`.
- 실제 설치 smoke 대상: `/tmp/agent-toolkit-test-target-repo`.
- opencode 사용자 설정: `$HOME/.config/opencode/opencode.json` (이 문서의 과거 실측 로그에서 나온 `/Users/openclaw/...` 같은 절대 경로는 작성자 로컬 예시로만 취급한다).
- 민감정보는 로그에 남기지 않는다. OAuth/PAT/password/DSN 값은 출력 금지. 문서 예시는 placeholder 를 쓰고, 실제 값은 로컬 shell/session 에서만 설정한다.
- GitHub 관련 실제 API 변경은 dry-run 또는 명시적 테스트 repo 에서만 수행한다.

## 1. 정적/단위 검증 게이트

항상 가장 먼저 실행한다.

```bash
cd /tmp/agent-toolkit-main
bun run typecheck
bun test ./lib ./.opencode
bun run check
```

기대값:

- typecheck exit 0
- 전체 테스트 pass
- Biome warning/error 없음

## 2. 문서/기능 리스트 검증

### 대상 문서

- `README.md` — 사람 친화 overview / install / quick start.
- `FEATURES.md`, `FEATURES.ko.md` — 전체 표면 카탈로그.
- `agent-toolkit.schema.json` — `agent-toolkit.json` grammar.
- `skills/*/SKILL.md` — skill 별 workflow.
- `agents/*.md` — routing / responsibility.
- `TESTING.ko.md` — 이 재검증 계획.

### 체크리스트

- [ ] README 의 tool/skill/agent 개수와 실제 등록 개수가 일치한다.
- [ ] FEATURES 의 tool name / input / output / side effect 가 실제 handler 와 일치한다.
- [ ] schema 가 README/FEATURES 의 config key 를 모두 포함한다.
- [ ] skill markdown 이 등록되지 않은 plugin tool 을 참조하지 않는다.
- [ ] agent markdown 이 실제 skill/tool name 과 라우팅 정책을 정확히 참조한다.
- [ ] GitHub / Notion / MySQL secret 값이 문서 예시에 직접 들어가지 않는다.

### 자동 검증

```bash
cd /tmp/agent-toolkit-main
bun test ./.opencode/plugins/skill-agent-contract.test.ts
bun test ./.opencode/plugins/agent-toolkit-install.test.ts
```

## 3. 전체 Tool 목록과 테스트 포인트

현재 등록 tool 은 28개다.

### Notion (`notion_*`)

- `notion_get`
  - cache miss: OAuth MCP `notion-fetch` 호출 후 `.md/.json` cache 생성.
  - cache hit: 같은 input 재호출 시 remote 호출 없이 `fromCache:true`.
  - mismatch guard: remote `url`/`id`가 요청 pageId 와 다르면 no-cache 오류.
- `notion_refresh`
  - cache 를 무시하고 remote 재호출, `fromCache:false`.
- `notion_status`
  - cache 존재/만료/age/contentHash 확인.
- `notion_extract`
  - 긴 markdown chunking + action item extraction.

### OpenAPI (현재 `swagger_*`, rename 검토 대상)

- `swagger_get`
  - URL / 16-hex key / `host:env:spec` handle 입력.
  - JSON OpenAPI/Swagger shape 검증, endpointCount 계산, cache write/read.
- `swagger_refresh`
  - cache 무시하고 spec refetch.
- `swagger_status`
  - cache metadata, exists/expired/endpointCount.
- `swagger_search`
  - cached specs 전체 또는 scope 제한 검색.
- `swagger_envs`
  - `agent-toolkit.json.openapi.registry` flatten.

### Journal (`journal_*`)

- `journal_append`
  - kind / tags / summary / content append-only write.
- `journal_read`
  - recent first, kind/tag filter.
- `journal_search`
  - content/tag 검색.
- `journal_status`
  - entry count / path / latest timestamp.

### MySQL (`mysql_*`)

- `mysql_envs`
  - handles flatten, auth env name 만 노출.
- `mysql_status`
  - `SELECT 1` ping, missing env 오류 surface.
- `mysql_tables`
  - `SHOW FULL TABLES`.
- `mysql_schema`
  - summary mode / detail mode(`SHOW CREATE TABLE`, indexes).
- `mysql_query`
  - read-only SQL만 실행, write/DDL/multi-statement 는 connection/secret 해석 전 reject.
  - SELECT/WITH 에 LIMIT 부착/cap.
  - `truncated:true` 는 rowCount 가 effectiveLimit 에 도달한 경우만.

### PR review watch (`pr_*`, routing 변경 검토 대상)

- `pr_watch_start`
- `pr_watch_stop`
- `pr_watch_status`
- `pr_event_record`
- `pr_event_pending`
- `pr_event_resolve`

테스트 포인트:

- start → record → pending → resolve → stop lifecycle.
- duplicate inbound `alreadySeen:true`.
- orphan resolve reject.
- mergeMode / reason / decision enum trim/validation.
- GitHub API 직접 호출 없음. PR raw fetch/reply/merge 는 외부 GitHub MCP 책임.

### spec-pact

- `spec_pact_fragment`
  - `draft` / `verify` / `drift-check` / `amend` fragment read.
  - package root / server export 설치에서도 절대경로 read 성공.

### spec-to-issues (`issue_*`)

- `issue_create_from_spec`
  - locked SPEC parse.
  - dryRun plan.
  - apply 시 GitHub issue create/edit + journal append.
  - idempotent re-apply.
- `issue_status`
  - dryRun alias, no mutation.

### gh-passthrough

- `gh_run`
  - read command immediate.
  - write command dryRun plan only.
  - write command apply with `dryRun:false`.
  - deny command reject.
  - gh failure 시 applied journal 미기록.

## 4. 전체 Skill 목록과 테스트 포인트

현재 skill 은 7개다.

- `notion-context`
  - Notion URL/page id 입력 → `notion_get` / `notion_extract` 사용.
  - cache hit 여부 설명.
- `openapi-client`
  - spec URL/key/handle 입력 → endpoint 검색, TS `fetch`/`axios` snippet 생성.
- `mysql-query`
  - handle / status / schema / SELECT 질의.
  - write SQL 거부 메시지를 그대로 surface.
- `spec-pact`
  - DRAFT / VERIFY / DRIFT-CHECK / AMEND lifecycle.
  - Notion contentHash 기반 drift 확인.
- `pr-review-watch`
  - 사용자가 명시적으로 리뷰 확인/코멘트 확인/watch 를 요청할 때만 실행.
  - 외부 GitHub MCP 없으면 fallback 하지 않고 필요 tool 을 설명.
- `spec-to-issues`
  - dryRun-first, apply 후 journal append.
- `gh-passthrough`
  - ad-hoc `gh` read/write/deny 분류.

검증 명령:

```bash
cd /tmp/agent-toolkit-main
bun test ./.opencode/plugins/skill-agent-contract.test.ts
```

## 5. Agent routing 테스트 계획

현재 agents:

- `rocky` — primary conductor. Notion/OpenAPI/MySQL/spec-to-issues/gh-passthrough surface routing.
- `grace` — spec-pact lifecycle conductor.
- `mindy` — PR review watch lifecycle conductor.

### 라우팅 기대값

- Notion URL / page id → `rocky` + `notion-context`.
- OpenAPI URL / 16-hex key / `host:env:spec` → `rocky` + `openapi-client`.
- MySQL `host:env:db` / SELECT/schema/table query → `rocky` + `mysql-query`.
- SPEC 합의 / drift / amend → `rocky`가 `grace`로 위임.
- PR review / 리뷰 봐줘 / 코멘트 확인 / 머지까지 watch → `rocky`가 `mindy`로 위임.
- 일반 PR 링크 언급만으로는 `mindy`를 자동 트리거하지 않는다. 사용자가 리뷰 확인을 명시해야 한다.

### 라우팅 smoke 예시

```bash
opencode run --agent rocky --model openai/gpt-5.5 \
  'petstore:prod:v3 에서 order endpoint 찾아줘'

opencode run --agent rocky --model openai/gpt-5.5 \
  'demo:dev:users users 테이블 schema 보여줘'

opencode run --agent rocky --model openai/gpt-5.5 \
  'https://github.com/minjun0219/agent-toolkit/pull/56 이 PR 링크 기억해둬'
# 기대: 단순 링크 언급이면 mindy watch 시작 안 함.

opencode run --agent rocky --model openai/gpt-5.5 \
  'https://github.com/minjun0219/agent-toolkit/pull/56 리뷰 코멘트 확인해줘'
# 기대: mindy / pr-review-watch 로 라우팅.
```

## 6. Notion 풀 테스트 시나리오

### 준비

- opencode MCP 설정에 Notion remote MCP 연결 필요.
- OAuth auth cache: `~/.local/share/opencode/mcp-auth.json`.
- 테스트 문서 예시:
  - `https://www.notion.so/minjunkim/394c6890d5fa4c48a11aee03058f9014?source=copy_link`

### 실행

```bash
cd /tmp/agent-toolkit-test-target-repo
CACHE_DIR="$PWD/.agent-toolkit-cache-minjun-notion-full"
# 주의: smoke 전용 cache 디렉터리만 지운다. trash 가 있으면 복구 가능 삭제, 없으면 rm -rf fallback.
if command -v trash >/dev/null 2>&1; then trash "$CACHE_DIR" 2>/dev/null || true; else rm -rf "$CACHE_DIR"; fi
mkdir -p "$CACHE_DIR"

AGENT_TOOLKIT_CACHE_DIR="$CACHE_DIR" opencode run --model openai/gpt-5.5 --format json \
  'Use notion_get for https://www.notion.so/minjunkim/394c6890d5fa4c48a11aee03058f9014?source=copy_link. Respond JSON with title, fromCache, markdownLength.'

AGENT_TOOLKIT_CACHE_DIR="$CACHE_DIR" opencode run --model openai/gpt-5.5 --format json \
  'Use notion_get for https://www.notion.so/minjunkim/394c6890d5fa4c48a11aee03058f9014?source=copy_link again. Respond JSON with title, fromCache.'

AGENT_TOOLKIT_CACHE_DIR="$CACHE_DIR" opencode run --model openai/gpt-5.5 --format json \
  'Use notion_status and notion_extract for the same Notion URL. Respond JSON with exists, contentHash, chunkCount, actionCount.'
```

기대값:

- 1차 `fromCache:false`, cache 파일 생성.
- 2차 `fromCache:true`.
- `notion_status.exists:true`.
- contentHash 는 같은 문서/렌더링 결과에서 안정적.

변경 감지 권장 정책:

- cheap preflight: Notion metadata `last_edited_time` / remote metadata.
- final confirm: fetch 후 rendered markdown `contentHash` 비교.
- TTL 은 cache freshness 의 기본 gate 로 유지하되, 문서 변경 감지의 유일한 기준으로 쓰지 않는다.

## 7. OpenAPI 풀 테스트 시나리오

### 7.1 Petstore 중형 spec

`./.opencode/agent-toolkit.json` 예시:

```json
{
  "openapi": {
    "registry": {
      "petstore": {
        "prod": {
          "v3": "https://petstore3.swagger.io/api/v3/openapi.json"
        }
      }
    }
  }
}
```

실행:

```bash
cd /tmp/agent-toolkit-test-target-repo
CACHE_DIR="$PWD/.agent-toolkit-openapi-cache-petstore"
# 주의: smoke 전용 cache 디렉터리만 지운다. trash 가 있으면 복구 가능 삭제, 없으면 rm -rf fallback.
if command -v trash >/dev/null 2>&1; then trash "$CACHE_DIR" 2>/dev/null || true; else rm -rf "$CACHE_DIR"; fi
mkdir -p "$CACHE_DIR"

AGENT_TOOLKIT_OPENAPI_CACHE_DIR="$CACHE_DIR" opencode run --model openai/gpt-5.5 --format json \
  'Use swagger_envs, swagger_get petstore:prod:v3, swagger_status petstore:prod:v3, swagger_search query "pet" scope petstore:prod:v3 limit 5. Respond compact JSON.'

AGENT_TOOLKIT_OPENAPI_CACHE_DIR="$CACHE_DIR" opencode run --model openai/gpt-5.5 --format json \
  'Use swagger_get petstore:prod:v3 again. Respond JSON with fromCache, endpointCount, title.'
```

최근 기대값:

- title `Swagger Petstore - OpenAPI 3.0`
- openapi `3.0.4`
- endpointCount `19`
- key `715e581e0d464caa`
- 2차 `fromCache:true`

### 7.2 GitHub REST 대형 spec

GitHub REST OpenAPI spec:

- URL: `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json`
- 크기: 약 12.3MB

`./.opencode/agent-toolkit.json` 예시:

```json
{
  "openapi": {
    "registry": {
      "github": {
        "prod": {
          "rest": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json"
        }
      }
    }
  }
}
```

실행:

```bash
cd /tmp/agent-toolkit-test-target-repo
CACHE_DIR="$PWD/.agent-toolkit-openapi-cache-github"
# 주의: smoke 전용 cache 디렉터리만 지운다. trash 가 있으면 복구 가능 삭제, 없으면 rm -rf fallback.
if command -v trash >/dev/null 2>&1; then trash "$CACHE_DIR" 2>/dev/null || true; else rm -rf "$CACHE_DIR"; fi
mkdir -p "$CACHE_DIR"

AGENT_TOOLKIT_OPENAPI_CACHE_DIR="$CACHE_DIR" \
AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS=60000 \
opencode run --model openai/gpt-5.5 --format json \
  'Use swagger_get for handle github:prod:rest. Respond JSON with title, version, endpointCount, key.'

AGENT_TOOLKIT_OPENAPI_CACHE_DIR="$CACHE_DIR" \
opencode run --model openai/gpt-5.5 --format json \
  'Use swagger_status github:prod:rest, swagger_search query "pull request review" scope github:prod:rest limit 8, swagger_get eca6cb1a084da4b9. Respond compact JSON.'
```

최근 기대값:

- title `GitHub v3 REST API`
- version `1.1.4`
- openapi `3.0.3`
- endpointCount `1145`
- key `eca6cb1a084da4b9`
- query `pull request review` 대표 operationIds:
  - `repos/get-pull-request-review-protection`
  - `repos/delete-pull-request-review-protection`
  - `repos/update-pull-request-review-protection`
  - `reactions/list-for-pull-request-review-comment`
  - `reactions/create-for-pull-request-review-comment`
  - `pulls/list-comments-for-review`

OpenAPI cache hit 판단:

- 입력 URL/handle/key → normalized key.
- cache meta/spec 파일 존재 + TTL 미만 + spec JSON shape valid 이면 cache hit.
- 원격 변경 감지까지 하려면 후속 개선으로 ETag/Last-Modified 또는 refetch 후 `specHash` 비교를 추가한다.

## 8. MySQL 풀 테스트 시나리오

### 준비

Homebrew MySQL 설치 후 root local 접속 가능해야 한다.

```bash
mysql -uroot -e 'SELECT VERSION() AS version, 1 AS ok;'
```

테스트 DB / read-only user 생성:

```bash
mysql --default-character-set=utf8mb4 -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS agent_toolkit_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS agent_toolkit_test.users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_toolkit_test.orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  amount INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_user_id (user_id)
);
INSERT INTO agent_toolkit_test.users (id, name, status) VALUES
  (1, '민준', 'active'),
  (2, '똥글이', 'active'),
  (3, '테스트유저', 'inactive')
ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status);
INSERT INTO agent_toolkit_test.orders (id, user_id, amount) VALUES
  (1, 1, 12000),
  (2, 1, 34000),
  (3, 2, 5600)
ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), amount = VALUES(amount);
-- <YOUR_PASSWORD> 는 로컬 테스트용 값으로 치환한다. 문서/로그/PR 에 실제 값을 남기지 않는다.
CREATE USER IF NOT EXISTS 'agent_toolkit_ro'@'localhost' IDENTIFIED BY '<YOUR_PASSWORD>';
CREATE USER IF NOT EXISTS 'agent_toolkit_ro'@'127.0.0.1' IDENTIFIED BY '<YOUR_PASSWORD>';
ALTER USER 'agent_toolkit_ro'@'localhost' IDENTIFIED BY '<YOUR_PASSWORD>';
ALTER USER 'agent_toolkit_ro'@'127.0.0.1' IDENTIFIED BY '<YOUR_PASSWORD>';
GRANT SELECT ON agent_toolkit_test.* TO 'agent_toolkit_ro'@'localhost';
GRANT SELECT ON agent_toolkit_test.* TO 'agent_toolkit_ro'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

`./.opencode/agent-toolkit.json` 예시:

```json
{
  "mysql": {
    "connections": {
      "demo": {
        "dev": {
          "users": {
            "host": "127.0.0.1",
            "port": 3306,
            "user": "agent_toolkit_ro",
            "database": "agent_toolkit_test",
            "passwordEnv": "AGENT_TOOLKIT_TEST_MYSQL_PASSWORD"
          },
          "orders": {
            "dsnEnv": "AGENT_TOOLKIT_TEST_MYSQL_DSN"
          }
        }
      }
    }
  }
}
```

실행:

```bash
cd /tmp/agent-toolkit-test-target-repo
# 실제 password/DSN 값은 문서/로그/PR 에 남기지 않는다. 아래 placeholder 를 로컬 값으로만 치환한다.
export AGENT_TOOLKIT_TEST_MYSQL_PASSWORD='<YOUR_PASSWORD>'
export AGENT_TOOLKIT_TEST_MYSQL_DSN='<YOUR_DSN>'

opencode run --model openai/gpt-5.5 --format json \
  'Run mysql_status demo:dev:users, mysql_tables demo:dev:users, mysql_schema demo:dev:users table users, mysql_query demo:dev:users SQL "SELECT id, name, status FROM users ORDER BY id" limit 10. Respond compact JSON.'

opencode run --model openai/gpt-5.5 --format json \
  'Run mysql_query demo:dev:users SQL "SELECT u.id, u.name, u.status, COALESCE(SUM(o.amount), 0) AS total_amount FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.name, u.status ORDER BY u.id" limit 10. Respond compact JSON.'

opencode run --model openai/gpt-5.5 --format json \
  'Run mysql_query demo:dev:users SQL "INSERT INTO users (name, status) VALUES ('"'"'should_fail'"'"', '"'"'active'"'"')". Respond JSON with rejected and error.'
```

최근 기대값:

- `mysql_status.ok:true`.
- `mysql_tables`: `orders`, `users`.
- `mysql_schema users`: `CREATE TABLE users`, PRIMARY index.
- SELECT rows: `민준`, `똥글이`, `테스트유저`, `truncated:false` when rowCount < effectiveLimit.
- join totals: `민준=46000`, `똥글이=5600`, `테스트유저=0`.
- INSERT guard: `MySQL read-only guard: leading keyword "INSERT" is not allowed ...`.
- 직접 MySQL INSERT with read-only user 도 `ERROR 1142`로 실패해야 한다.

## 9. GitHub 풀 테스트 시나리오

GitHub 표면은 두 종류다.

1. `gh_run` / `issue_*`: 사용자의 `gh` CLI 로 직접 실행.
2. `pr-review-watch`: 외부 GitHub MCP 가 PR 메타/댓글을 가져오고, toolkit 은 로컬 lifecycle queue 만 관리.

### gh_run

```bash
cd /tmp/agent-toolkit-test-target-repo

opencode run --model openai/gpt-5.5 --format json \
  'Use gh_run for read command: gh repo view minjun0219/agent-toolkit --json nameWithOwner,defaultBranchRef. Respond JSON.'

opencode run --model openai/gpt-5.5 --format json \
  'Use gh_run for write command: gh issue create --repo minjun0219/agent-toolkit --title test --body test with dryRun true. Respond JSON.'

opencode run --model openai/gpt-5.5 --format json \
  'Use gh_run for denied command: gh auth token. Respond JSON with rejected/error.'
```

기대값:

- read 즉시 실행.
- write + dryRun true 는 계획만 반환, 외부 변경 없음.
- token/secret 류 deny.

### issue_*

테스트용 locked SPEC 을 만든 뒤:

```bash
opencode run --model openai/gpt-5.5 --format json \
  'Use issue_status for the locked SPEC path ... Respond JSON with plan.'

opencode run --model openai/gpt-5.5 --format json \
  'Use issue_create_from_spec dryRun true for ... Respond JSON with plan.'
```

실제 issue 생성은 테스트 repo / 명시 승인 후만 `dryRun:false`.

### pr-review-watch

단위 lifecycle:

```bash
cd /tmp/agent-toolkit-main
bun test ./.opencode/plugins/agent-toolkit.test.ts --test-name-pattern 'pr_watch|pr_event'
```

실제 PR review watch smoke:

- 외부 GitHub MCP 가 등록되어 있어야 한다.
- 사용자가 “리뷰 확인”, “코멘트 확인”, “머지까지 watch” 처럼 명시한 경우에만 `mindy`/`pr-review-watch` 진입.
- 단순 PR URL 언급은 watch 시작 금지.

## 10. Rename / routing 개선 검토

### 10.1 `pr_watch` trigger 축소

현재 문제:

- `rocky` agent description 이 PR URL / `owner/repo#NUMBER` handle 자체를 라우팅 trigger 에 포함하고 있어 단순 PR 언급에도 `mindy`가 과잉 트리거될 위험이 있다.

권장 변경:

- `mindy` / `pr-review-watch` trigger 를 “리뷰 확인”, “코멘트 확인”, “리뷰 답글”, “머지까지 watch”, “PR drift” 같은 명시적 작업 요청으로 제한.
- 단순 PR URL / handle 은 GitHub surface 후보로만 인식하고, 사용자가 원하는 작업을 묻거나 `gh-passthrough` read 로 처리.
- agent tests 에 negative routing case 추가:
  - “이 PR 링크 참고: …” → no `pr_watch_start`.
  - “이 PR 리뷰 코멘트 확인해줘: …” → `mindy`.

### 10.2 `pr_*` tool rename 검토

현재 이름은 lifecycle 내부 구현 느낌이 강하다.

후보:

- `pr_watch_start` → `review_watch_start`
- `pr_watch_stop` → `review_watch_stop`
- `pr_watch_status` → `review_watch_status`
- `pr_event_record` → `review_event_record`
- `pr_event_pending` → `review_event_pending`
- `pr_event_resolve` → `review_event_resolve`

권장 migration:

1. 새 이름 추가 + 기존 이름 alias 유지.
2. docs/skills/agents 를 새 이름 기준으로 업데이트.
3. 한 릴리스 뒤 기존 `pr_*` deprecate 문구 추가.
4. 최종 제거는 실제 사용자 workflow 안정화 후.

### 10.3 `swagger_*` → `openapi_*` rename 검토

현재 문제:

- 도구가 OpenAPI 3.x 와 Swagger 2.x 를 모두 다루지만, “swagger” 이름이 OpenAPI 중심 문서와 어긋난다.

후보:

- `swagger_get` → `openapi_get`
- `swagger_refresh` → `openapi_refresh`
- `swagger_status` → `openapi_status`
- `swagger_search` → `openapi_search`
- `swagger_envs` → `openapi_envs`

권장 migration:

1. 새 `openapi_*` tool 등록.
2. 기존 `swagger_*` 는 alias 로 유지.
3. `openapi-client` skill / README / FEATURES 는 `openapi_*` 를 primary 로 문서화하고, `swagger_*` 는 compatibility alias 로 표기.
4. tests 는 양쪽 이름 모두 같은 handler 를 호출하는지 검증.

## 11. 재실행 요약 체크리스트

- [ ] `bun run typecheck`
- [ ] `bun test ./lib ./.opencode`
- [ ] `bun run check`
- [ ] `opencode debug config`에서 plugin/agents/tools 등록 확인
- [ ] Notion: get miss → hit → status/extract
- [ ] OpenAPI Petstore: envs/get/status/search/hit/key
- [ ] OpenAPI GitHub REST: 대형 spec get/status/search/key
- [ ] MySQL: envs/status/tables/schema/query/join/write guard/read-only DB user
- [ ] GitHub: `gh_run` read/write dryRun/deny, `issue_*` dryRun
- [ ] PR watch: lifecycle 단위 테스트 + routing negative/positive case
- [ ] Agent routing: rocky/grace/mindy trigger 확인
- [ ] 문서/FEATURES/schema/skills/agents consistency 확인
