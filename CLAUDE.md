# CLAUDE.md

Claude Code 가 이 저장소에서 작업할 때 우선적으로 따르는 가이드.
공통 규칙은 [`AGENTS.md`](./AGENTS.md) 에 있고, 이 파일은 Claude Code 한정 보조 사항만 담는다.

## 런타임

- Bun(>=1.0) 만 사용한다. `node`, `npm`, `pnpm`, `yarn`, `tsc --build` 같은 명령은 쓰지 않는다.
- 코드 실행 시 항상 `bun run <path>` 또는 `bun test` 를 사용.
- typecheck 만 필요할 때 `bun x tsc --noEmit -p tsconfig.json`.

## 자주 쓰는 흐름

새 기능을 만들 때:

1. `lib/` 또는 `.opencode/plugins/` 에 TS 파일 추가/수정
2. 같은 디렉터리에 `*.test.ts` 케이스 추가 (`bun:test`)
3. `bun run typecheck && bun test` 로 검증
4. 도구/환경변수 contract 가 바뀌면 `README.md`, `.opencode/INSTALL.md`, 필요 시 `skills/notion-context/SKILL.md` 도 함께 수정

## MCP 서버

`.mcp.json` 에 프로젝트 스코프로 등록된 MCP:

- **context7** (`https://mcp.context7.com/mcp`, HTTP)
  - 외부 라이브러리(Bun runtime, TypeScript, opencode plugin API, MCP spec 등) 문서를 최신 상태로 가져올 때 사용.
  - 라이브러리 사용법이 모호하거나 버전 차이가 의심될 때 먼저 context7 로 조회한 뒤 코드를 작성한다.

활성화하려면 Claude Code 가 처음 로드될 때 사용자에게 trust 확인 프롬프트가 뜨므로 승인하면 된다.

## 작업 시 주의

- import 에 `.js` / `.ts` 확장자 붙이지 말 것 (Bundler 해석).
- ESM 환경이므로 `__dirname` 사용 금지. `import.meta.url` + `fileURLToPath` 또는 Bun 의 `import.meta.dir` 사용.
- `dist/` 만들지 말 것. Bun 이 TS 를 직접 실행한다.
- 새 환경변수 추가 시 `README.md`, `.opencode/INSTALL.md`, plugin 의 `readEnv()` 세 곳을 같이 수정.
- 단일 host(opencode) 전용. 다른 host 폴더(`.claude-plugin/` 등) 는 사용자가 명시적으로 요청할 때만 추가.

## 출력 / 커뮤니케이션

- 사용자와의 대화는 기본 한국어. 코드 식별자/경로/명령은 영어 그대로.
- 변경 요약은 짧게 (한 줄 요약 + 필요 시 bullet). 장문 보고서 만들지 말 것.
