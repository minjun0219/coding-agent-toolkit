# Agent Toolkit (MVP)

opencode 환경에서 사용하는 Notion 캐싱 게이트웨이 + 플러그인 + 기본 skill 묶음.
런타임은 **Bun (>=1.0)** 을 기준으로 한다. (Node 는 사용하지 않는다.)

## 구성

```
opencode
  └─ agent-toolkit-opencode-plugin   (commands: /notion get|refresh|status)
       └─ agent-toolkit-mcp-gateway  (Bun.serve, TTL 캐시 + remote MCP proxy)
            └─ remote Notion MCP     (HTTP)
                 └─ Notion
```

* `packages/agent-toolkit-core` — 캐시 키 / TTL / 파일 저장 / Notion → markdown normalize
* `packages/agent-toolkit-mcp-gateway` — `Bun.serve` HTTP gateway. 캐시 hit 면 즉시 반환, miss 면 remote MCP 호출
* `packages/agent-toolkit-opencode-plugin` — gateway 를 `Bun.spawn` 으로 띄우고 `/notion` 커맨드를 노출
* `skills/notion-spec-reader` — Notion 페이지를 한국어 스펙으로 정리하는 기본 skill

## 설치

```bash
bun install
```

## 환경변수

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `AGENT_TOOLKIT_NOTION_MCP_URL` | ✅ | remote Notion MCP base URL |
| `AGENT_TOOLKIT_NOTION_MCP_TOKEN` | ⛔️ | bearer token (있으면 Authorization 첨부) |
| `AGENT_TOOLKIT_GATEWAY_PORT` | ⛔️ | 기본 `4319` |
| `AGENT_TOOLKIT_GATEWAY_HOST` | ⛔️ | 기본 `127.0.0.1` |
| `AGENT_TOOLKIT_CACHE_DIR` | ⛔️ | 기본 `.agent-cache/notion/pages` |
| `AGENT_TOOLKIT_CACHE_TTL` | ⛔️ | 초 단위, 기본 `86400` |
| `AGENT_TOOLKIT_GATEWAY_URL` | ⛔️ | plugin 이 spawn 대신 외부 gateway 를 쓸 때 사용 |

## 실행

### 1) gateway 단독 실행

```bash
AGENT_TOOLKIT_NOTION_MCP_URL=https://notion-mcp.example.com \
  bun run gateway
```

`http://127.0.0.1:4319` 에 다음 endpoint 가 노출된다:

```
GET  /health
POST /v1/notion/get        { "input": "<pageId or url>" }
POST /v1/notion/refresh    { "input": "<pageId or url>" }
POST /v1/notion/status     { "input": "<pageId or url>" }
```

### 2) plugin CLI 로 한 번 호출

```bash
AGENT_TOOLKIT_GATEWAY_URL=http://127.0.0.1:4319 \
  bun run plugin status <pageId-or-url>
```

`AGENT_TOOLKIT_GATEWAY_URL` 을 비우면 plugin 이 직접 gateway 를 `Bun.spawn` 으로 띄운다 (이 경우 `AGENT_TOOLKIT_NOTION_MCP_URL` 같은 변수는 plugin 프로세스에 그대로 상속된다).

### 3) opencode 에서 사용

opencode plugin 호스트에 `@agent-toolkit/opencode-plugin` 의 `createOpencodePlugin()` 결과를 등록한다. 등록된 후 다음 커맨드를 사용할 수 있다:

```
/notion get <pageId-or-url>
/notion refresh <pageId-or-url>
/notion status <pageId-or-url>
```

skill 은 `skills/notion-spec-reader/SKILL.md` 를 참조한다 — Notion 접근은 반드시 위 커맨드(=gateway) 를 통해서만 일어난다.

## 캐시 구조

```
.agent-cache/notion/pages/
  <pageId>.json   # 메타데이터 (pageId, url, cachedAt, ttlSeconds, contentHash, title)
  <pageId>.md     # normalize 된 markdown 본문
```

## 개발

```bash
bun test                                                  # core 단위 테스트
bun run typecheck                                         # tsc --noEmit
bun run packages/agent-toolkit-mcp-gateway/src/cli.ts     # gateway 단독 실행
bun run scripts/smoke.ts                                  # 가짜 remote MCP + gateway 통합 smoke
```

## Out of Scope (MVP)

* Notion database query
* multi-page traversal / child page
* OAuth / 인증 추상화
* multi-MCP, codex CLI, UI
