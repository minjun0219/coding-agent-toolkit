# Agent Toolkit

opencode 전용 plugin. **Notion / OpenAPI / MySQL** 컨텍스트 캐시, **저널**, **SPEC 합의 lifecycle**, **PR 리뷰 watch**, **GitHub Issue 동기화** 를 한 묶음으로 제공한다.
일하면서 자주 쓰는 "기획문서 → 합의된 SPEC → 이슈 → PR 리뷰 → 머지" 흐름을 한국어 / 한 사용자 환경에서 매끄럽게 굴리는 게 목적.

> 개인 프로젝트라 유지보수가 꾸준하지 않을 수 있다.

세부 기능 카탈로그는 [`FEATURES.md`](./FEATURES.md) (영어, source of truth) / [`FEATURES.ko.md`](./FEATURES.ko.md) (한국어 미러) — 사람과 에이전트가 똑같은 anchor 로 인용 가능. 전체 재검증 계획과 Notion / GitHub / OpenAPI / MySQL 풀 smoke 시나리오는 [`TESTING.ko.md`](./TESTING.ko.md)에 둔다.

## 요구사항

- [Bun](https://bun.sh) `>=1.0` (Node 미지원 — Bun 이 TS 를 직접 실행하므로 별도 빌드 단계 없음)
- [opencode](https://opencode.ai) (다른 host — Claude Code / Cursor / Codex CLI — 는 MVP 범위 밖)
- (선택) Notion 페이지를 다룰 경우 opencode 에 [Notion remote MCP](https://developers.notion.com/docs/mcp) 가 OAuth 로 연결되어 있어야 한다
- (선택) GitHub PR / Issue 를 쓸 경우 사용자 머신에 [`gh` CLI](https://cli.github.com) 인증 + (PR review watch 용) 외부 GitHub MCP 서버

## Quick start

처음 써 보는 흐름 — Notion 한 페이지를 캐시하고 한국어 스펙으로 정리하는 데까지 5 분.

1. **Plugin 등록**. 프로젝트의 `opencode.json` 또는 사용자 단위 opencode 설정에 추가하고 opencode 를 재시작.

   ```json
   { "plugin": ["agent-toolkit@git+https://github.com/minjun0219/agent-toolkit.git"] }
   ```

2. **Notion remote MCP 연결** (Notion 을 쓸 때만). opencode 의 MCP 설정에서 OAuth 로 한 번 로그인해 두면 끝 — toolkit 은 토큰을 저장하지 않는다.

3. **첫 호출**. opencode 안에서 `@rocky` 에게 Notion URL 을 던져 본다.

   ```
   @rocky <Notion 페이지 URL> 한국어로 정리해 줘
   ```

   rocky 가 `notion-context` 스킬로 라우팅 → `notion_get` 캐시 우선 read → 한국어 스펙 markdown 반환. 같은 URL 을 다시 호출하면 캐시에서 바로 돌아온다 (TTL 1 일, 변경 가능).

4. **다음 단계**. 자주 쓰는 흐름:
   - **OpenAPI 호출 코드 뽑기** — `@rocky` 에게 "spec URL 의 `POST /orders` 로 호출 코드 만들어 줘"
   - **MySQL read-only 검사** — `agent-toolkit.json` 에 `mysql.connections` 등록 후 `@rocky mysql_envs / mysql_tables / mysql_query`
   - **SPEC 합의** — `@grace <Notion URL> 스펙 합의`
   - **PR 리뷰 watch** — `@mindy <PR URL> 리뷰 확인해줘` 처럼 명시적으로 요청할 때만 시작
   - **SPEC → GitHub Issue** — `@rocky <slug> issue_status` (dryRun 먼저)

5. **더 자세히**. 환경변수는 [환경변수](#환경변수), 설치 검증 / smoke test 는 [`.opencode/INSTALL.md`](./.opencode/INSTALL.md), 도구 한 개씩의 정확한 입출력은 [`FEATURES.md`](./FEATURES.md), 전체 재검증 매트릭스는 [`TESTING.ko.md`](./TESTING.ko.md).

## What's inside

| 표면 | 한 줄 설명 | 자세히 |
| --- | --- | --- |
| Notion 캐시 (`notion_*`, 4 개) | Notion 단일 페이지 캐시 우선 read + 한국어 스펙 추출 | [FEATURES.md#notion-cache-notion_](./FEATURES.md#notion-cache-notion_) |
| OpenAPI 캐시 (`openapi_*`, 5 개) | OpenAPI / Swagger JSON spec 캐시 + endpoint 검색 + `host:env:spec` 핸들 | [FEATURES.md#openapi-cache-openapi_](./FEATURES.md#openapi-cache-openapi_) |
| 저널 (`journal_*`, 4 개) | turn 단위 결정 / blocker / 사용자 답변 append-only 저널 | [FEATURES.md#journal-journal_](./FEATURES.md#journal-journal_) |
| MySQL read-only (`mysql_*`, 5 개) | `host:env:db` 핸들 기반 read-only 검사 (write / DDL 거부) | [FEATURES.md#mysql-read-only-mysql_](./FEATURES.md#mysql-read-only-mysql_) |
| PR review watch (`pr_*`, 6 개) | polling-only PR 리뷰 lifecycle (GitHub API 직접 호출 없음) | [FEATURES.md#pr-review-watch-pr_](./FEATURES.md#pr-review-watch-pr_) |
| spec-pact 보조 (`spec_pact_fragment`, 1 개) | 4 개 모드 본문을 plugin 절대경로에서 인입 | [FEATURES.md#spec-pact-spec_pact_fragment](./FEATURES.md#spec-pact-spec_pact_fragment) |
| spec-to-issues (`issue_*`, 2 개) | 잠긴 SPEC → GitHub epic + sub-issue 시리즈 (gh CLI 위임) | [FEATURES.md#spec-to-issues-issue_](./FEATURES.md#spec-to-issues-issue_) |
| gh-passthrough (`gh_run`, 1 개) | ad-hoc gh CLI 위임 (read / write / deny 분류 + dryRun) | [FEATURES.md#gh-passthrough-gh_run](./FEATURES.md#gh-passthrough-gh_run) |
| 스킬 × 7 / 에이전트 × 3 | `notion-context` / `openapi-client` / `mysql-query` / `spec-pact` / `pr-review-watch` / `spec-to-issues` / `gh-passthrough` 스킬 + `rocky` / `grace` / `mindy` | [FEATURES.md#skills](./FEATURES.md#skills) / [FEATURES.md#agents](./FEATURES.md#agents) |

총 **도구 28 개 + 스킬 7 개 + 에이전트 3 명**. 도구당 정확한 입출력 / Owner / Side effects / 관련 config 는 FEATURES 문서 참고.

## GitHub Transport 정책

이 toolkit 은 GitHub 데이터 접근에 대해 명확한 **transport 분리** 를 따른다.

1. **gh-cli** — write 작업 (`issue_*`, `gh_run`) 은 사용자 `gh` CLI 에 위임. 인증 / 저장소 감지 / GHE / scope 모두 `gh` 가 관리하며, toolkit 은 GitHub 토큰을 저장하지 않고 env 변수로도 요구하지 않는다.
2. **external-mcp** — PR 코멘트 / 답글 / 리뷰 / 체크 상태 같은 GitHub 라이브 상태 조회와 코멘트 작성은 외부 GitHub MCP 서버가 담당. toolkit 은 PR 코멘트용 GitHub API 를 직접 호출하지 않는다.
3. **journal-only** — `pr_*` 도구들은 GitHub 네트워크 요청 없이 로컬 저널 (`journal.jsonl`) 에 이벤트 큐와 상태만 기록.

주요 가드레일:
- **No Token Storage** — toolkit 설정과 환경변수에 GitHub 토큰을 두지 않는다.
- **dryRun-first** — `issue_create_from_spec` / `gh_run` 의 write 명령은 기본 `dryRun: true` 로 plan 만 보여 준다. `issue_status` 는 read-only (저널 기록 없음). `gh_run` 은 read / dry-run / applied 모든 호출에 저널 entry 를 남긴다.
- **Restricted Commands** — `gh_run pr merge`, `repo edit|delete`, `release delete`, `workflow run|enable|disable`, `run rerun|cancel`, 환경 변경 위험 명령 (`auth` / `extension` / `config` / `alias` 등) 은 도구 수준에서 deny. PR 머지 실행은 toolkit 책임 밖.
- **Live QA 비권장** — 프로덕션 PR 에서의 실시간 테스트는 권장하지 않는다. 테스트 저장소에서.

## 설치 / 검증

설치는 위 Quick start 1 단계로 끝나지만, plugin 이 실제로 떴는지·agent 가 노출됐는지 의심스러우면 [`.opencode/INSTALL.md`](./.opencode/INSTALL.md) 의 설치 검증 / agent fallback / smoke test 를 따라가면 된다.

## 환경변수

전부 옵션. 기본값을 바꿔야 할 때만 설정한다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | `https://mcp.notion.com/mcp` | remote Notion MCP base URL. 인증은 OAuth 가 처리하므로 토큰 변수는 없다. |
| `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` | `15000` | remote Notion 호출 timeout (ms) |
| `AGENT_TOOLKIT_CACHE_DIR` | `~/.config/opencode/agent-toolkit/notion-pages` | Notion 페이지 캐시 디렉터리 |
| `AGENT_TOOLKIT_CACHE_TTL` | `86400` | Notion 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` | `~/.config/opencode/agent-toolkit/openapi-specs` | OpenAPI / Swagger spec 캐시 디렉터리 |
| `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` | `86400` | OpenAPI 캐시 TTL (초) |
| `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS` | `30000` | OpenAPI spec 다운로드 timeout (ms) |
| `AGENT_TOOLKIT_JOURNAL_DIR` | `~/.config/opencode/agent-toolkit/journal` | 에이전트 저널 디렉터리 (안에 단일 `journal.jsonl` 파일) |
| `AGENT_TOOLKIT_CONFIG` | `~/.config/opencode/agent-toolkit/agent-toolkit.json` | 사용자 단위 `agent-toolkit.json` 경로. 프로젝트 로컬 `./.opencode/agent-toolkit.json` 이 leaf 단위로 덮어쓴다. |

MySQL 자격증명용 env 변수는 사용자가 직접 이름을 정한다 — `agent-toolkit.json` 의 각 `host:env:db` profile 이 `passwordEnv` 또는 `dsnEnv` 로 *어떤 env 변수* 를 쓰는지 가리킨다. 권장 패턴은 핸들과 1:1 로 짝지은 이름 (예: `MYSQL_ACME_PROD_USERS_PASSWORD`). config 파일에 평문 비밀번호 / DSN 을 박는 것은 loader 가 거부한다.

## Config (`agent-toolkit.json`)

**project (`./.opencode/agent-toolkit.json`) 가 user (`~/.config/opencode/agent-toolkit/agent-toolkit.json` 또는 `$AGENT_TOOLKIT_CONFIG`) 를 leaf 단위로 덮어쓴다.** 모든 키는 옵션 — 필요한 것만 선언하면 된다. 전체 grammar 는 [`agent-toolkit.schema.json`](./agent-toolkit.schema.json), 키별 의미와 leaf shape 는 [FEATURES.md#config-agent-toolkitjson](./FEATURES.md#config-agent-toolkitjson).

한 파일에서 4 개 표면을 모두 선언한 예시:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/minjun0219/agent-toolkit/main/agent-toolkit.schema.json",
  "openapi": {
    "registry": {
      "acme": {
        "dev":  { "users": "https://dev.acme.example/users/openapi.json" },
        "prod": { "users": "https://api.acme.example/users/openapi.json" }
      }
    }
  },
  "spec": {
    "dir": ".agent/specs",
    "scanDirectorySpec": true,
    "indexFile": "INDEX.md"
  },
  "mysql": {
    "connections": {
      "acme": {
        "prod": {
          "users":  { "host": "db.acme.example", "user": "readonly", "database": "app",
                      "passwordEnv": "MYSQL_ACME_PROD_USERS_PASSWORD" },
          "orders": { "dsnEnv": "MYSQL_ACME_PROD_ORDERS_DSN" }
        }
      }
    }
  },
  "github": {
    "repo": "minjun0219/agent-toolkit",
    "defaultLabels": ["spec-pact"],
    "repositories": {
      "minjun0219/agent-toolkit": {
        "alias": "toolkit",
        "labels": ["bug", "review", "ci"],
        "defaultBranch": "main",
        "mergeMode": "squash"
      }
    }
  }
}
```

핵심 가드레일:
- `openapi.registry` / `mysql.connections` 의 host / env / spec / db 식별자는 `^[a-zA-Z0-9_-]+$` (콜론은 핸들 separator 로 예약).
- `github.repositories` 의 키는 `owner/repo` 형식 — 정확히 1 개의 슬래시 + 양쪽 모두 `[a-zA-Z0-9_.-]+` (예: `minjun0219/agent-toolkit`).
- `mysql.connections` leaf 에 평문 비밀번호 / DSN 을 두면 loader 가 reject — 항상 `passwordEnv` 또는 `dsnEnv` 로 env 변수 *이름* 만 가리키게 한다.
- `github.repositories` leaf 에 `token` / `passwordEnv` / `apiKey` 같은 시크릿 의도 키는 reject — GitHub 인증은 외부 GitHub MCP / `gh` CLI 책임.

## Agents

| 이름 | mode | 한 줄 역할 |
| --- | --- | --- |
| `rocky` | `all` | 프론트엔드 전문성을 가진 풀스택 업무 파트너. agent-toolkit 의 1 차 지휘자. cache-first 스킬 (Notion / OpenAPI / MySQL) + 저널 + spec-to-issues + gh-passthrough 를 직접 conduct. SPEC 합의 키워드 → `@grace`, PR 리뷰 확인/코멘트 확인/watch 같은 명시 요청 → `@mindy` 로 라우팅. 코드는 직접 쓰지 않는다. |
| `grace` | `subagent` | SPEC 합의 lifecycle (DRAFT / VERIFY / DRIFT-CHECK / AMEND) 의 단일 finalize / lock 권한자. `spec-pact` 스킬을 conduct. `<spec.dir>/<spec.indexFile>` 와 SPEC 파일 들의 단독 writer. |
| `mindy` | `subagent` | PR 리뷰 watch lifecycle (WATCH-START / PULL / VALIDATE / WATCH-STOP) 의 단일 finalize 권한자. `pr-review-watch` 스킬을 conduct. 코드 / `gh` / `bun test` / `tsc` / `curl` 모두 직접 실행하지 않는다 (`edit: deny`, `bash: deny`). PR 생성·머지·commit 은 caller 책임. |

세 에이전트의 정확한 권한 / 위임 룰 / 거부 룰은 [FEATURES.md#agents](./FEATURES.md#agents) 참고. opencode 에 OmO Sisyphus 나 Superpowers 같은 외부 primary 가 있으면 자연스럽게 셋의 위임 대상이 잡히지만, **외부 primary 는 필수가 아니라 같이 있을 때 시너지가 나는 옵션**이다.

## 개발

```bash
bun install
bun run check     # Biome formatter / linter / import organizer 검증 (수정 X)
bun run fix       # Biome safe fix + 포맷팅 적용
bun run lint      # Biome lint 규칙 검증 (수정 X)
bun run lint:fix  # Biome lint safe fix 적용
bun run format    # Biome 포맷팅 적용
bun test          # lib/ + .opencode/plugins/ 단위 테스트
bun run typecheck # tsc --noEmit
```

## Roadmap

MVP 너머의 능력 목표 (자동 기억, GitHub Issue 동기화, OpenAPI client 작성 등) 는 [`ROADMAP.md`](./ROADMAP.md) — 한 번에 한 phase 씩 별도 PR 로.
