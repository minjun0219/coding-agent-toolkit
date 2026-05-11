# Agent Toolkit

OpenAPI / Swagger 명세를 캐시-우선으로 둘러보는 MCP toolkit. v0.3 부터 **Bun workspaces monorepo** 로 정리되어 세 가지 배포 타깃을 한 저장소에서 관리한다:

| Package | 역할 | 설치 |
| --- | --- | --- |
| [`openapi-mcp`](./packages/openapi-mcp) | subset MCP. 어떤 stdio MCP host (Claude Code / Cursor / Continue / …) 든 등록해 쓰는 단독 CLI. | `npm i -g openapi-mcp` 또는 `bun link` |
| [`@minjun0219/agent-toolkit-claude-code`](./packages/agent-toolkit-claude-code) | Claude Code plugin. `.claude-plugin/plugin.json` + `.mcp.json` 으로 marketplace 등록. | Claude Code plugin marketplace |
| [`@minjun0219/agent-toolkit-opencode`](./packages/agent-toolkit-opencode) | opencode plugin. opencode 의 plugin 키에 git URL 또는 npm 식별자로 등록. | git URL / npm |

세 패키지 모두 **동일한 7 tool surface** (`openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs` / `openapi_endpoint` / `openapi_tags`) 를 노출한다. 공유 core 는 [`@minjun0219/openapi-core`](./packages/openapi-core) — spec 다운로드 / 디스크 캐시 / `$ref` deref / swagger 2.0 → OpenAPI 3 변환 / endpoint 점수화 검색 / handler 함수.

> v0.2 까지의 journal / mysql / notion / spec-pact / pr-watch 도메인은 [`archive/pre-openapi-only-slim`](https://github.com/minjun0219/agent-toolkit/tree/archive/pre-openapi-only-slim) 브랜치에 박제되어 있다. 활용 패턴이 잡히면 ROADMAP 의 phase 별로 (a) 두 plugin 에 다시 합류 (b) `packages/<domain>-mcp/` subset MCP 로 분리 (c) `packages/agent-toolkit-mcp/` umbrella MCP 로 합본 — 셋 중 하나로 재추가된다.

- **사람용 단일 문서**: [`FEATURES.md`](./FEATURES.md) (한국어) — 도구 / 설정 / Quick start / 검증 한 페이지.
- **에이전트용 단일 문서**: [`AGENTS.md`](./AGENTS.md) (영문) — Layout / MVP scope / coding rules / change checklist.

## 진입점

### `openapi-mcp` 단독 CLI

```bash
bun install            # workspace 의존성
cd packages/openapi-mcp && bun link
openapi-mcp --config ~/.config/openapi-mcp/openapi-mcp.json
```

config 형태와 host 별 등록 예시는 [`packages/openapi-mcp/README.md`](./packages/openapi-mcp/README.md).

### Claude Code plugin

저장소 root 에서 직접 trust 해 개발할 때:

1. `bun install`
2. Claude Code 가 `.mcp.json` 의 `agent-toolkit` stdio 서버 (`bun run packages/agent-toolkit-claude-code/src/index.ts`) + `context7` 두 서버를 처음 로드할 때 trust prompt 가 뜬다 — 둘 다 승인.
3. `openapi_envs` / `openapi_get` 등 호출.

marketplace 설치는 [`packages/agent-toolkit-claude-code/README.md`](./packages/agent-toolkit-claude-code/README.md).

### opencode plugin

```json
{ "plugin": ["@minjun0219/agent-toolkit-opencode@git+https://github.com/minjun0219/agent-toolkit.git"] }
```

자세한 절차는 [`packages/agent-toolkit-opencode/INSTALL.md`](./packages/agent-toolkit-opencode/INSTALL.md).

## 개발

```bash
bun install        # workspace 의존성 + symlink
bun run check      # Biome 검증
bun run typecheck  # tsc --noEmit (4 패키지)
bun test           # 모든 패키지 단위 + smoke 테스트
```
