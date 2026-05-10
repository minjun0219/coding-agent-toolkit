# Agent Toolkit

Claude Code (1차) + opencode (2차) 듀얼 host MCP / 플러그인 toolkit. **OpenAPI / Swagger spec (deref + swagger 2.0 자동 변환) / MySQL read-only 검사 / 저널 / SPEC 합의 lifecycle / PR 리뷰 watch / SPEC → GitHub Issue 동기화** 를 turn 단위 컨텍스트로 묶어 준다. 일하면서 자주 쓰는 "기획문서 → 합의된 SPEC → 이슈 → PR 리뷰 → 머지" 흐름을 한국어 / 한 사용자 환경에서 매끄럽게 굴리는 게 목적.

> 개인 프로젝트라 유지보수가 꾸준하지 않을 수 있다. v0.2 부터 (구) [`openapi-mcp-server`](https://github.com/minjun0219/openapi-mcp-server) 의 OpenAPI 모듈을 흡수해 한 레포에서 관리한다.

- **사람용 단일 문서**: [`FEATURES.md`](./FEATURES.md) (한국어) — 도구 / 스킬 / 에이전트 / 설정 / Quick start / 검증 한 페이지.
- **에이전트용 단일 문서**: [`AGENTS.md`](./AGENTS.md) (영문) — Layout / MVP scope / coding rules / change checklist.
- **openapi-mcp 단독 사용 가이드**: [`docs/openapi-mcp.md`](./docs/openapi-mcp.md) — agent-toolkit 의 다른 기능 없이 OpenAPI MCP 만 띄우고 싶을 때.

## 진입점

### Claude Code (1차 host)

1. 저장소 root 에서 `bun install`.
2. Claude Code 가 `.mcp.json` 의 `agent-toolkit` (스토디오 MCP, `bun run server/index.ts`) + `context7` 두 서버를 처음 로드할 때 trust prompt 가 한 번씩 뜬다 — 둘 다 승인.
3. `CLAUDE.md` 가 자동 로드되어 `AGENTS.md` 로 위임된다.
4. 첫 호출 — `openapi_envs`, `mysql_envs`, `journal_status`, `spec_pact_fragment` 중 아무거나.

Claude Code 진입점은 17 tool 만 노출 — `openapi_*` ×7 (`get` / `refresh` / `status` / `search` / `envs` / `endpoint` / `tags`) + `journal_*` ×4 + `mysql_*` ×5 + `spec_pact_fragment` ×1. 빠진 10 tool (`notion_*` ×4, `pr_*` ×6) 은 [`AGENTS.md`](./AGENTS.md) 의 *MVP scope → Removal candidates* 절에 추적된다.

### opencode (2차 host)

```json
{ "plugin": ["agent-toolkit@git+https://github.com/minjun0219/agent-toolkit.git"] }
```

opencode 진입점은 27 tool 모두 노출. 자세한 절차는 [`.opencode/INSTALL.md`](./.opencode/INSTALL.md).

### openapi-mcp 단독 (3차 host, 선택)

agent-toolkit 의 다른 기능 없이 OpenAPI MCP 만 쓰고 싶다면:

```bash
bun link
openapi-mcp --config ~/.config/openapi-mcp/openapi-mcp.json
```

config 형태와 Claude Desktop / Claude Code 등록 예시는 [`docs/openapi-mcp.md`](./docs/openapi-mcp.md).

## 자세한 내용

도구 한 개씩의 입출력, 스킬 / 에이전트 권한, 환경변수, `agent-toolkit.json` 스펙은 모두 [`FEATURES.md`](./FEATURES.md) 에 있다. 장기 비전은 [`ROADMAP.md`](./ROADMAP.md).

## 개발

```bash
bun install
bun run check     # Biome 검증
bun run typecheck # tsc --noEmit
bun test          # lib/ + .opencode/plugins/ + server/ 단위 테스트
```
