/**
 * Claude Code MCP server entrypoint for agent-toolkit.
 *
 * stdio JSON-RPC server that exposes 17 of the 27 tools the opencode plugin
 * provides:
 *
 *   - openapi_get / openapi_refresh / openapi_status / openapi_search / openapi_envs
 *     / openapi_endpoint / openapi_tags  (7)
 *   - journal_append / journal_read / journal_search / journal_status  (4)
 *   - mysql_envs / mysql_status / mysql_tables / mysql_schema / mysql_query  (5)
 *   - spec_pact_fragment  (1)
 *
 * Excluded — tracked in AGENTS.md "MVP scope → Removal candidates" (코드는 보존, surface 만 좁힘):
 *   - notion_* (4) — opencode OAuth cache 의존, Claude Code 전용 인증 경로 부재
 *   - pr_watch_* / pr_event_* (6) — pr-watch 도메인 제거 후보
 *
 * Handlers are imported from the opencode plugin implementation
 * (`.opencode/plugins/agent-toolkit.ts`) so business logic stays in one place.
 * The opencode plugin keeps its full 27-tool surface; this server is the
 * narrower Claude Code surface.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { createJournalFromEnv } from "../lib/agent-journal";
import { createAgentToolkitRegistry } from "../lib/openapi/adapter";
import { HTTP_METHODS } from "../lib/openapi/indexer";
import { MysqlExecutorRegistry } from "../lib/mysql-context";
import {
  loadSpecPactFragment,
  SPEC_PACT_MODES,
  assertSpecPactMode,
} from "../lib/spec-pact-fragments";
import { loadConfig } from "../lib/toolkit-config";
import {
  handleJournalAppend,
  handleJournalRead,
  handleJournalSearch,
  handleJournalStatus,
  handleMysqlEnvs,
  handleMysqlQuery,
  handleMysqlSchema,
  handleMysqlStatus,
  handleMysqlTables,
  handleSwaggerEndpoint,
  handleSwaggerEnvs,
  handleSwaggerGet,
  handleSwaggerRefresh,
  handleSwaggerSearch,
  handleSwaggerStatus,
  handleSwaggerTags,
} from "../.opencode/plugins/agent-toolkit";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..");
const SKILLS_DIR = resolve(REPO_ROOT, "skills");

/**
 * MCP `tools/call` results must be a `CallToolResult`. We always serialize the
 * handler return value as a single JSON text content block — Claude Code reads
 * it back the same way it consumed the opencode plugin's stringified result.
 */
function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export interface BuildServerOptions {
  /** override skills/ root for `spec_pact_fragment` (tests can point at a fixture). */
  skillsDir?: string;
}

/**
 * Build the MCP server with all 17 tools wired up. Exported for tests so they
 * can register tools against an in-process server without spawning a child.
 */
export async function buildServer(options: BuildServerOptions = {}) {
  const skillsDir = options.skillsDir ?? SKILLS_DIR;

  const journal = createJournalFromEnv();

  const { config: toolkitConfig, errors: configErrors } = await loadConfig();
  for (const e of configErrors) {
    console.error(
      `agent-toolkit: skipped config file ${e.source} — ${e.message}. Other config sources still apply.`,
    );
  }
  const registry = toolkitConfig.openapi?.registry;
  const openapiRegistry = createAgentToolkitRegistry({
    ...(registry !== undefined ? { registry } : {}),
  });

  const mysqlRegistry = new MysqlExecutorRegistry(process.env);
  process.once("beforeExit", () => {
    mysqlRegistry.closeAll().catch((err) => {
      console.error(
        `agent-toolkit: failed to close MySQL pools cleanly — ${(err as Error).message}`,
      );
    });
  });

  const server = new McpServer({
    name: "agent-toolkit",
    version: pkg.version,
  });

  // ──────────────────────────── OpenAPI (7) ────────────────────────────

  server.registerTool(
    "openapi_get",
    {
      description:
        "OpenAPI / Swagger spec 을 캐시 우선 정책으로 가져온다. swagger 2.0 은 자동으로 OpenAPI 3.0 으로 변환되고 $ref 는 모두 deref 된다. fresh hit 은 remote 호출 없음. stale hit (TTL 경과) 은 즉시 stale 데이터로 응답하고 백그라운드 conditional GET (If-None-Match / If-Modified-Since) 으로 재검증. miss 면 fetch + parse + index. (input: spec URL 또는 agent-toolkit.json 의 host:env:spec handle)",
      inputSchema: { input: z.string() },
    },
    async ({ input }) =>
      jsonResult(await handleSwaggerGet(openapiRegistry, input, registry)),
  );

  server.registerTool(
    "openapi_refresh",
    {
      description:
        "캐시 (메모리 + 디스크) 를 무시하고 OpenAPI spec 을 강제 재다운로드한다.",
      inputSchema: { input: z.string() },
    },
    async ({ input }) =>
      jsonResult(await handleSwaggerRefresh(openapiRegistry, input, registry)),
  );

  server.registerTool(
    "openapi_status",
    {
      description:
        "캐시된 OpenAPI spec 의 메타 (cached / fetchedAt / ttlSeconds / environments) 만 조회. remote 호출 없음.",
      inputSchema: { input: z.string() },
    },
    async ({ input }) =>
      jsonResult(await handleSwaggerStatus(openapiRegistry, input, registry)),
  );

  server.registerTool(
    "openapi_search",
    {
      description:
        "캐시 (메모리 또는 디스크) 에 있는 OpenAPI spec 들을 가로질러 endpoint 를 점수화 검색한다 (operationId>path>summary>description). remote 호출 없음 — 미캐시 spec 은 결과에 포함되지 않으니 먼저 `openapi_get` 으로 받아둬야 한다.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().optional(),
        scope: z.string().optional(),
      },
    },
    async ({ query, limit, scope }) =>
      jsonResult(
        await handleSwaggerSearch(
          openapiRegistry,
          query,
          { limit, scope },
          registry,
        ),
      ),
  );

  server.registerTool(
    "openapi_envs",
    {
      description:
        "agent-toolkit.json 의 openapi.registry 를 host:env:spec 평면 리스트로 반환한다. baseUrl / format 이 있으면 함께 반환. remote 호출 없음.",
      inputSchema: {},
    },
    async () => jsonResult(handleSwaggerEnvs(toolkitConfig)),
  );

  server.registerTool(
    "openapi_endpoint",
    {
      description:
        "단일 endpoint 의 풍부한 정보 (parameters / requestBody / responses / examples / fullUrl) 를 반환한다. baseUrl 합성된 fullUrl 은 leaf 의 baseUrl 이 비어 있으면 path 자체.",
      inputSchema: {
        input: z.string(),
        operationId: z.string().optional(),
        method: z.enum(HTTP_METHODS).optional(),
        path: z.string().optional(),
      },
    },
    async ({ input, operationId, method, path }) =>
      jsonResult(
        await handleSwaggerEndpoint(
          openapiRegistry,
          input,
          { operationId, method, path },
          registry,
        ),
      ),
  );

  server.registerTool(
    "openapi_tags",
    {
      description:
        "spec 의 OpenAPI tag 목록 + 각 tag 의 endpoint 개수를 반환한다.",
      inputSchema: { input: z.string() },
    },
    async ({ input }) =>
      jsonResult(await handleSwaggerTags(openapiRegistry, input, registry)),
  );

  // ──────────────────────────── Journal (4) ────────────────────────────

  server.registerTool(
    "journal_append",
    {
      description:
        "에이전트 저널에 한 줄을 append-only 로 기록한다. 다음 turn 에 인용할 결정 / blocker / 사용자 답변 / 메모를 남길 때 사용.",
      inputSchema: {
        content: z.string(),
        kind: z.string().optional(),
        tags: z.array(z.string()).optional(),
        pageId: z.string().optional(),
      },
    },
    async ({ content, kind, tags, pageId }) =>
      jsonResult(
        await handleJournalAppend(journal, { content, kind, tags, pageId }),
      ),
  );

  server.registerTool(
    "journal_read",
    {
      description:
        "저널을 가장 최근 항목부터 필터 / limit 적용해 반환한다. 손상된 라인은 자동 skip. remote 호출 없음.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
        kind: z.string().optional(),
        tag: z.string().optional(),
        pageId: z.string().optional(),
        since: z.string().optional(),
      },
    },
    async ({ limit, kind, tag, pageId, since }) =>
      jsonResult(
        await handleJournalRead(journal, { limit, kind, tag, pageId, since }),
      ),
  );

  server.registerTool(
    "journal_search",
    {
      description:
        "저널을 substring (case-insensitive) 으로 검색한다. content / kind / tags / pageId 를 매칭한다. remote 호출 없음.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().optional(),
        kind: z.string().optional(),
      },
    },
    async ({ query, limit, kind }) =>
      jsonResult(await handleJournalSearch(journal, query, { limit, kind })),
  );

  server.registerTool(
    "journal_status",
    {
      description:
        "저널 메타(파일 경로, 존재 여부, 유효 항목 수 — 손상 라인 skip, 바이트 크기, 마지막 항목 시각) 만 조회한다. remote 호출 없음.",
      inputSchema: {},
    },
    async () => jsonResult(await handleJournalStatus(journal)),
  );

  // ──────────────────────────── MySQL (5) ────────────────────────────

  server.registerTool(
    "mysql_envs",
    {
      description:
        "agent-toolkit.json 의 mysql.connections 를 host:env:db 평면 리스트로 반환한다. 비밀번호 / DSN 의 *값* 은 노출하지 않고 env 변수 *이름* 만 보여 준다.",
      inputSchema: {},
    },
    async () => jsonResult(handleMysqlEnvs(toolkitConfig)),
  );

  server.registerTool(
    "mysql_status",
    {
      description:
        "MySQL host:env:db 핸들의 메타 (host / port / user / database 또는 dsnEnv 모드 표시) + 짧은 SELECT 1 ping.",
      inputSchema: { handle: z.string() },
    },
    async ({ handle }) =>
      jsonResult(await handleMysqlStatus(mysqlRegistry, toolkitConfig, handle)),
  );

  server.registerTool(
    "mysql_tables",
    {
      description:
        "SHOW FULL TABLES — 핸들의 디폴트 database 안 테이블 / 뷰 목록을 반환한다.",
      inputSchema: { handle: z.string() },
    },
    async ({ handle }) =>
      jsonResult(await handleMysqlTables(mysqlRegistry, toolkitConfig, handle)),
  );

  server.registerTool(
    "mysql_schema",
    {
      description:
        "table 미지정: INFORMATION_SCHEMA.COLUMNS 의 모든 테이블 컬럼 요약. table 지정: SHOW CREATE TABLE + SHOW INDEX FROM 합본.",
      inputSchema: {
        handle: z.string(),
        table: z.string().optional(),
      },
    },
    async ({ handle, table }) =>
      jsonResult(
        await handleMysqlSchema(mysqlRegistry, toolkitConfig, handle, table),
      ),
  );

  server.registerTool(
    "mysql_query",
    {
      description:
        "검증된 read-only SQL (SELECT / SHOW / DESCRIBE / DESC / EXPLAIN / WITH) 만 실행한다. INSERT / UPDATE / DELETE / DDL / SET / CALL / LOAD / multi-statement / INTO OUTFILE 은 모두 거부. SELECT / WITH 에는 LIMIT 가 강제 부착되거나 cap 으로 재작성된다.",
      inputSchema: {
        handle: z.string(),
        sql: z.string(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ handle, sql, limit }) =>
      jsonResult(
        await handleMysqlQuery(mysqlRegistry, toolkitConfig, handle, sql, {
          limit,
        }),
      ),
  );

  // ───────────────────────── spec-pact fragment (1) ─────────────────────────

  server.registerTool(
    "spec_pact_fragment",
    {
      description: `spec-pact 의 모드별 fragment 본문을 반환한다. grace 가 모드를 결정한 뒤 정확히 한 번만 호출. (mode: ${SPEC_PACT_MODES.join(" / ")})`,
      inputSchema: { mode: z.string() },
    },
    async ({ mode }) => {
      const validated = assertSpecPactMode(mode);
      return jsonResult(await loadSpecPactFragment(skillsDir, validated));
    },
  );

  return server;
}

/**
 * Entrypoint when run as `bun run server/index.ts`. Tests import `buildServer`
 * directly and never hit this branch.
 */
async function main() {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `agent-toolkit MCP server failed: ${(err as Error).stack ?? err}`,
    );
    process.exit(1);
  });
}
