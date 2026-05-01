# AGENTS.md

이 저장소에서 작업하는 AI 코딩 에이전트(Claude Code, opencode, codex 등)를 위한 공통 가이드입니다.

## 프로젝트 한 줄 요약

opencode 전용 플러그인입니다. Notion 캐시 도구 3개 + 캐시 우선 컨텍스트/스펙 추출 스킬 1개 + 얇은 게이트웨이 에이전트(`rocky`, [OmO](https://github.com/code-yeongyu/oh-my-openagent)의 named-specialist 네이밍 컨벤션 차용)로 구성됩니다. **런타임은 Bun(>=1.0)만 사용**하며 **Node는 사용하지 않습니다. 빌드 단계도 없습니다(Bun이 TS를 직접 실행).** 레이아웃은 [obra/superpowers](https://github.com/obra/superpowers) 형태를 따릅니다.

## 레이아웃

- `.opencode/plugins/agent-toolkit.ts` — 플러그인 엔트리포인트. `config` 훅에서 `skills/`, `agents/`를 등록하고 도구 3개(`notion_get` / `notion_refresh` / `notion_status`)를 노출합니다.
- `lib/notion-context.ts` — 단일 파일 TTL 파일시스템 캐시 + `resolveCacheKey` + `notionToMarkdown`.
- `skills/notion-context/SKILL.md` — Notion 캐시 우선 읽기 + 한국어 스펙 추출 스킬.
- `agents/rocky.md` — 얇은 게이트웨이 에이전트(`mode: all`). 사용자 및 다른 primary 에이전트(e.g. OmO Sisyphus)에 Notion 플로우를 제공합니다.
- `.opencode/INSTALL.md` — opencode 사용자 설치 가이드.

## 공통 명령어

```bash
bun install
bun test           # lib/ + .opencode/plugins/ 단위 테스트
bun run typecheck  # tsc --noEmit
```

필수 환경변수는 `AGENT_TOOLKIT_NOTION_MCP_URL` 하나뿐입니다. 선택 환경변수는 README의 env-var 표를 참고하세요.

## 코딩 규칙

- **언어**: TypeScript(`type: module`). Bun이 `.ts`를 직접 실행하므로 빌드/`dist/`가 없습니다.
- **Import**: `.js` / `.ts` 확장자를 붙이지 않습니다(`moduleResolution: Bundler` + `allowImportingTsExtensions`).
- **ESM 안전성**: `__dirname`을 사용하지 않습니다. `import.meta.url` + `fileURLToPath` 또는 Bun의 `import.meta.dir`를 사용하세요.
- **JSDoc**: export된 함수/클래스에는 JSDoc을 작성합니다. 복잡한 로직에는 한국어 주석도 허용됩니다.
- **에러 메시지**: 입력값, timeout, status code, pageId mismatch 같은 맥락 정보를 포함하세요.
- **의존성**: 가능하면 새 의존성을 추가하지 않습니다. 표준 라이브러리와 Bun 내장 기능을 우선합니다.
- **테스트**: `*.test.ts`는 소스 파일 옆에 두고 `bun test`로 실행합니다. 파일시스템 의존 테스트는 `mkdtempSync`로 격리하세요.

## MVP 범위 (엄수)

**포함**: 단일 Notion 페이지 읽기 + 캐시 + 만료 처리, 스킬 1개, 게이트웨이 에이전트(`rocky`) 1개, opencode 전용.

**제외**: 데이터베이스 쿼리, OAuth, 하위 페이지, 멀티 호스트 플러그인 레이아웃(`.claude-plugin/` 등), UI, codex 통합, 에이전트 측 워크플로 오케스트레이션(해당 책임은 `rocky`가 아니라 호출자에게 있음). MVP 범위를 넘는 내용은 별도 PR 제안으로 분리하세요.

장기 기능 목표(자동 메모리, GitHub 이슈 트래킹, OpenAPI 클라이언트 생성 등)는 [`ROADMAP.md`](./ROADMAP.md)에 phase별로 정리되어 있습니다. 사용자가 명시적으로 요청하지 않는 한 MVP에 포함하지 마세요.

## 변경 체크리스트

1. `bun run typecheck` 통과
2. `bun test` 통과
3. 사용자 표면(도구 / 환경변수)이 바뀌면 `README.md`와 `.opencode/INSTALL.md` 동기화
4. 새 환경변수를 추가하면 플러그인의 `readEnv()`도 함께 업데이트
5. 플러그인 도구 계약이 바뀌면 `skills/notion-context/SKILL.md`의 도구 사용 규칙과 `agents/rocky.md`의 도구 설명/규칙도 함께 업데이트

## MCP 서버

프로젝트 범위의 `.mcp.json`에는 [`context7`](https://github.com/upstash/context7)가 등록되어 있습니다. Bun, TypeScript, opencode plugin API 등 외부 라이브러리의 최신 문서 확인에 사용하세요.

## Output / communication

- Default conversation language with the user is Korean. Keep code identifiers / paths / commands in English.
- Keep change summaries short (one-line summary, bullets only when needed). Do not produce long-form reports.
- Write code review outputs (summary/inline/suggestions) in Korean by default.
- When requesting a PR review, explicitly ask for Korean review comments (e.g. `모든 리뷰 코멘트는 한국어로 작성해 주세요.`).
- PR title/body and user-facing change descriptions should also be written in Korean.
