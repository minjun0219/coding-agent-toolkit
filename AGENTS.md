# AGENTS.md

이 저장소에서 작업하는 AI 코딩 에이전트(Claude Code, opencode, codex 등) 공통 가이드.

## 프로젝트 한 줄

opencode 전용 plugin. Notion 캐시 도구 3 개 + 스펙 정리 skill 1 개. **런타임은 Bun(>=1.0). Node 미사용. 빌드 단계 없음 (Bun 이 TS 직접 실행).** 구조는 [obra/superpowers](https://github.com/obra/superpowers) 형식을 따른다.

## 레이아웃

- `.opencode/plugins/agent-toolkit.ts` — plugin entrypoint. `config` 훅으로 `skills/` 등록 + `notion_get` / `notion_refresh` / `notion_status` 도구 3 개 등록.
- `lib/notion-cache.ts` — TTL 파일 캐시 + `resolveCacheKey` + `notionToMarkdown` (단일 파일).
- `skills/notion-spec-reader/SKILL.md` — Notion → 한국어 스펙 skill.
- `.opencode/INSTALL.md` — opencode 사용자용 설치 안내.

## 자주 쓰는 커맨드

```bash
bun install
bun test           # lib/ + .opencode/plugins/ 단위 테스트
bun run typecheck  # tsc --noEmit
```

`AGENT_TOOLKIT_NOTION_MCP_URL` 만 필수. 그 외 옵션 변수는 README 환경변수 표 참고.

## 코딩 규칙

- **언어**: TypeScript (`type: module`). Bun 이 `.ts` 직접 실행 → 빌드/`dist` 없음.
- **import**: `.js` / `.ts` 접미사 붙이지 말 것 (`moduleResolution: Bundler` + `allowImportingTsExtensions`).
- **ESM 안전성**: `__dirname` 대신 `import.meta.url` + `fileURLToPath` 사용.
- **JSDoc**: export 함수/클래스에 작성. 복잡한 로직에는 한글 주석.
- **에러**: 메시지에 컨텍스트(입력값, timeout, status code, pageId mismatch 등) 포함.
- **의존성**: 가능한 한 추가하지 않는다. 표준 라이브러리 + Bun 내장 우선.
- **테스트**: `*.test.ts` 를 같은 디렉터리에 두고 `bun test` 로 실행. fs 가 필요한 테스트는 `mkdtempSync` 로 격리.

## MVP 범위 (지키기)

**포함**: Notion 단일 page read + 캐시 + 만료, skill 1 개, opencode 전용.

**제외**: database query, OAuth, child page, multi-host plugin (`.claude-plugin/` 등), UI, codex 통합. 이 범위를 넘는 변경은 별도 PR 로 제안.

## 변경 시 체크리스트

1. `bun run typecheck` 통과
2. `bun test` 통과
3. 사용자 노출(도구 / 환경변수)이 바뀌면 `README.md`, `.opencode/INSTALL.md` 동기화
4. plugin 의 도구 contract 가 바뀌면 `skills/notion-spec-reader/SKILL.md` 의 도구 사용 규칙도 같이 갱신

## MCP 서버

`.mcp.json` 에 프로젝트 스코프로 [`context7`](https://github.com/upstash/context7) 가 등록되어 있다. 외부 라이브러리(Bun, TypeScript, opencode plugin API 등) 문서를 최신 상태로 가져올 때 활용.
