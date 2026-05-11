# ROADMAP

본 toolkit 의 장기 비전 메모. 현재 출하된 MVP 는 [`AGENTS.md`](./AGENTS.md) 의 *MVP scope* 에 한정한다 — 이 문서는 그 너머의 목표를 정리한다. 새 기능은 항상 별도 PR 로, 한 번에 한 항목씩.

## 현재 (v0.3, openapi-only)

- 4-package monorepo (Bun workspaces) — 세 host 가 동일 7-tool surface 공유:
  - `openapi-mcp` (standalone CLI, npm publish 가능 형태)
  - `@minjun0219/agent-toolkit-claude-code` (Claude Code plugin, marketplace)
  - `@minjun0219/agent-toolkit-opencode` (opencode plugin, git URL / npm)
  - `@minjun0219/openapi-core` (shared core — handlers / registry / cache / fetcher / parser / indexer / filter / adapter / config / schema)
- archive 브랜치: [`archive/pre-openapi-only-slim`](https://github.com/minjun0219/agent-toolkit/tree/archive/pre-openapi-only-slim) — v0.2 의 journal / mysql / notion / spec-pact / pr-watch + rocky / grace / mindy + 5 skills 박제. 도메인 재추가 작업의 포팅 기준.

## 도메인 재추가 후보

각 도메인은 별도 PR. 재추가 시점에 다음 셋 중 하나의 shape 를 정한다:

- **(a) plugin 직접 합류** — 도메인 코드를 `packages/<domain>-core/` 로 옮기고, 두 plugin (Claude Code + opencode) 의 surface 에 도구를 추가한다. 단독 host (`<domain>-mcp` 같은 standalone CLI) 는 만들지 않음.
- **(b) subset MCP 분리** — `packages/<domain>-mcp/` 단독 CLI 추가. 도메인이 plugin 외 host (Cursor / Continue / Claude Desktop) 에서도 자주 쓰일 때.
- **(c) umbrella MCP 합본** — `packages/agent-toolkit-mcp/` 한 패키지가 여러 도메인을 묶어 하나의 stdio MCP 로 노출. plugin 합류 여부는 별도 결정.

결정 기준은 활용 패턴 — host 독립성이 높으면 (b), plugin 안에서만 쓰이면 (a), 여러 도메인이 한 묶음으로 자주 호출되면 (c).

| 도메인 | archive 위치 (v0.2 경로) | 후보 shape | 비고 |
| --- | --- | --- | --- |
| `journal` (agent journal — append-only JSONL) | `lib/agent-journal.ts` + 4 tool (`journal_*`) | (a) plugin 합류 우선. 다른 host 에 노출 필요 없음. | turn-spanning memory; 재추가 우선순위 높음. |
| `mysql` (read-only inspection) | `lib/mysql-*.ts` + 5 tool (`mysql_*`) + `skills/mysql-query/` | (b) subset MCP 강력 후보 — DB inspector 는 host 독립적. | `mysql2` prod-dep 부활. `agent-toolkit.json` 의 `mysql.connections` 키 + `passwordEnv` / `dsnEnv` 정책. |
| `notion-context` (single-page cache) | `lib/notion-context.ts` + `lib/notion-chunking.ts` + 4 tool (`notion_*`) + `skills/notion-context/` | (a) plugin 합류. opencode MCP OAuth 의존성 때문에 Claude Code 합류는 인증 경로 정리 후. | `AGENT_TOOLKIT_NOTION_MCP_URL` 등 env 5 종 부활. |
| `spec-pact` (DRAFT / VERIFY / DRIFT-CHECK / AMEND lifecycle) | `lib/spec-pact-fragments.ts` + 1 tool (`spec_pact_fragment`) + `skills/spec-pact/` + `agents/grace.md` | (a) plugin 합류. fragment loader 자체는 가벼움. | INDEX / SPEC 파일 lifecycle 은 `grace` sub-agent 책임. |
| `pr-review-watch` (polling-only, journal-backed) | `lib/pr-watch.ts` + 6 tool (`pr_*`) + `skills/pr-review-watch/` + `agents/mindy.md` | (a) plugin 합류. 외부 GitHub MCP 의존. | journal 도메인 재추가 후에. |

재추가 절차의 자세한 단계는 `AGENTS.md` 의 *Reintroduction strategy* 절.

## 능력 목표 (원본 메모, 분리 단위 유지)

1. 에이전트가 작업하거나 기억해야 하는 사항을 **자동으로 기억 / 기록** 해야 한다 — journal 도메인 재추가가 1차.
2. 작성한 코드와 관련하여 **주석을 상세하게** 작성 — runtime project comment guidance 로 이미 출하 (in this repo as `AGENTS.md` 의 동일 절).
3. 주석 / 설명을 **한글** 로 작성 — 동일.
4. **Notion MCP** 를 활용해 노션 문서를 캐싱하고, 일정 시간 내 같은 문서를 참고할 때 캐싱 사용 — notion-context 도메인 재추가 후.
5. 개발 기획 문서를 바탕으로 **명확한 개발 스펙으로 분해** — spec-pact 도메인 재추가 후.
6. 분해된 스펙을 **GitHub Issue / Project** 로 관리 / 추적 — agent-toolkit 안에서 GitHub 쓰기 surface 를 두지 않는다는 v0.2 결정 유지. 사용자 / Claude Code / 외부 GitHub MCP 책임.
7. 공유된 **Swagger / OpenAPI JSON** 을 로컬 캐시 → 빠르게 탐색 → `fetch` / `axios` 같은 API client 로 작성 — **이미 출하 (v0.3 main surface)**.

## 비전 (도메인 재추가 이후)

작업 컨텍스트를 들고 코드까지 굴리는 에이전트 오케스트레이션 toolkit. 세 갈래 방향이 있었다:

1. **업무 / 코딩 파트너로 단독 충분한 토대** — agent / skill / command / MCP / tool 다섯 종 primitive 을 적재적소에 섞어 쓰는 composition foundation.
2. **외부 primary 와의 시너지** — OmO Sisyphus / Superpowers 같은 외부 primary agent 가 동일 host 에 있을 때 description-driven routing 이 깨지지 않고 자연스럽게 위임이 흐른다.
3. **회사 맞춤 토킷의 base** — plugin (현재 형태) + library (`@minjun0219/<domain>-core` exports) 두 형태로 패키징해 의존성으로 가져다 쓰는 토대.

세 방향 모두 도메인이 다시 모인 뒤 다시 본격적으로 추진. 그 전까지 이 문서의 우선순위는 **archive → main 재추가** 와 **3 host 의 openapi surface 유지**.

## 인프라 후보 (별도 PR)

- **npm publish 자동화** — 도메인 추가로 패키지가 늘어나면 changeset (`@changesets/cli`) 도입 + GitHub Actions release workflow. 첫 publish 필요 시점에 시작.
- **Project references 도입** — `tsconfig.base.json` 위에 `tsc -b` project references 를 얹어 인크리멘털 빌드 / 명시적 의존 그래프. 현재 패키지 4 개라 도입 비용이 효익보다 크면 보류.
- **Repo rename** (`agent-toolkit` → `openapi-mcp-server` 등) — 보류. `agent-toolkit` umbrella 정체성이 살아있는 한 유지.

## Out of scope

- OpenAPI YAML 스트림 파싱 (현재 전체 in-memory deref).
- Full SDK code generation.
- Multi-spec merge.
- Mock server.
- UI / dashboard.
- 자동 polling / 백그라운드 fetch (모든 캐시 갱신은 사용자 요청 시점 또는 stale-revalidate 백그라운드 1-shot).
