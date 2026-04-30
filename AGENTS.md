# AGENTS.md

이 저장소에서 작업하는 AI 코딩 에이전트(Claude Code, opencode, codex 등) 공통 가이드.

## 프로젝트 한 줄

opencode 환경에서 사용하는 Notion 캐싱 게이트웨이 + 플러그인 + 기본 skill 묶음. **런타임은 Bun(>=1.0) 만 사용한다. Node 미사용, 빌드 단계 없음.**

## 패키지

- `packages/agent-toolkit-core` — TTL 파일시스템 캐시, key/url 정규화, blocks → markdown
- `packages/agent-toolkit-mcp-gateway` — `Bun.serve` HTTP 게이트웨이
- `packages/agent-toolkit-opencode-plugin` — `Bun.spawn` 으로 gateway 띄우고 `/notion get|refresh|status` 노출
- `skills/notion-spec-reader/SKILL.md` — Notion 페이지 → 한국어 스펙 정리 skill

## 자주 쓰는 커맨드

```bash
bun install                                  # workspace 설치
bun test                                     # bun:test 단위 테스트
bun run typecheck                            # tsc --noEmit
bun run gateway                              # gateway 단독 실행
bun run plugin <get|refresh|status> <input>  # plugin 디버그 CLI
bun run scripts/smoke.ts                     # 가짜 MCP + gateway 통합 smoke
```

`AGENT_TOOLKIT_NOTION_MCP_URL` 만 필수. 그 외 `*_TOKEN`, `*_PORT`, `*_HOST`, `*_CACHE_DIR`, `*_CACHE_TTL`, `*_GATEWAY_URL` 은 옵션. 자세한 건 README.

## 코딩 규칙

- **언어**: TypeScript (`type: module`). Bun 이 `.ts` 를 직접 실행하므로 빌드/`dist` 없음.
- **import**: `.js` 접미사 붙이지 말 것. tsconfig 가 `moduleResolution: Bundler` + `allowImportingTsExtensions` 사용.
- **JSDoc**: 모든 export 함수/클래스에 작성. 복잡한 로직에는 한글 주석 필수.
- **에러**: 메시지에 컨텍스트(입력값, timeout, status code) 포함. 무음 실패 금지.
- **의존성**: 가능한 한 추가하지 않는다. 표준 라이브러리 + Bun 내장으로 해결 우선.
- **테스트**: `packages/*/test/*.test.ts` 에 두고 `bun test` 로 실행. fs 가 필요한 테스트는 `mkdtempSync` 로 격리.

## MVP 범위 (지키기)

**포함**: Notion 단일 page read + cache, TTL, markdown+json 저장, skill 1개.

**제외**: database query, OAuth, UI, child page, multi-MCP, codex 통합. 이 범위를 넘는 변경은 별도 PR 로 제안할 것.

## 변경 시 체크리스트

1. `bun run typecheck` 통과
2. `bun test` 통과
3. 흐름이 바뀌면 `scripts/smoke.ts` 도 갱신
4. 사용자 노출이 바뀌면 README 동기화

## MCP 서버

`.mcp.json` 에 프로젝트 스코프로 [`context7`](https://github.com/upstash/context7) 가 등록되어 있다. 외부 라이브러리(Bun, TypeScript 등) 문서를 최신 상태로 가져올 때 활용.
