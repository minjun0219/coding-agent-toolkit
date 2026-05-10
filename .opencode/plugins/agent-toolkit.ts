import { existsSync, readFileSync } from "node:fs";
import { tool as defineTool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NotionCache,
  resolveCacheKey,
  createCacheFromEnv,
  type RawNotionPage,
  type NotionPageResult,
  type NotionCacheStatus,
} from "../../lib/notion-context";
import {
  chunkNotionMarkdown,
  extractActionItems,
  summarizeNotionChunks,
  type NotionActionExtraction,
  type NotionChunkSummary,
} from "../../lib/notion-chunking";
import {
  buildEphemeralSpec,
  createAgentToolkitRegistry,
  DEFAULT_ENVIRONMENT,
  ephemeralSpecName,
  flattenHandle,
} from "../../lib/openapi/adapter";
import {
  buildEndpointDetail,
  resolveEndpoint,
  type EndpointDetail,
  type IndexedSpec,
  type TagSummary,
} from "../../lib/openapi/indexer";
import { filterEndpoints } from "../../lib/openapi/filter";
import {
  type RefreshOutcome,
  type SpecRegistry,
  type SpecSummary,
  UnknownSpecError,
} from "../../lib/openapi/registry";
import type { OpenAPIV3 } from "openapi-types";
import {
  isFullHandle,
  listRegistry,
  resolveHandleToUrl,
  resolveScopeToUrls,
  type OpenapiRegistryEntry,
} from "../../lib/openapi-registry";
import {
  isMergeMode,
  loadConfig,
  MERGE_MODES,
  type OpenapiRegistry,
  type ToolkitConfig,
} from "../../lib/toolkit-config";
import {
  type AgentJournal,
  createJournalFromEnv,
  type JournalAppendInput,
  type JournalEntry,
  type JournalReadOptions,
  type JournalSearchOptions,
  type JournalStatus,
} from "../../lib/agent-journal";
import {
  loadSpecPactFragment,
  SPEC_PACT_MODES,
  type SpecPactFragment,
  type SpecPactMode,
  assertSpecPactMode,
} from "../../lib/spec-pact-fragments";
import { assertReadOnlySql } from "../../lib/mysql-readonly";
import {
  MysqlExecutorRegistry,
  describeHandle as mysqlDescribeHandle,
  describeTable as mysqlDescribeTable,
  listTables as mysqlListTables,
  pingHandle as mysqlPingHandle,
  runReadonlyQuery as mysqlRunReadonlyQuery,
  type MysqlQueryResult,
  type RunReadonlyQueryOptions,
} from "../../lib/mysql-context";
import {
  listRegistry as listMysqlRegistry,
  type MysqlRegistryEntry,
} from "../../lib/mysql-registry";
import {
  buildAppend as buildPrAppend,
  hasInboundFor,
  isStopReason,
  normalizeEventRef,
  parsePrHandle,
  PR_WATCH_TAG,
  reduceActiveWatches,
  reducePendingEvents,
  RESOLVE_DECISIONS,
  STOP_REASONS,
  type PendingPrEvent,
  type PrEventType,
  type PrWatchState,
  type ResolveDecision,
} from "../../lib/pr-watch";

type LegacyToolParam = {
  type?: string;
  required?: boolean;
  items?: LegacyToolParam;
};

type LegacyToolDefinition = {
  description: string;
  parameters?: Record<string, LegacyToolParam>;
  handler(args: any): Promise<unknown> | unknown;
};

function schemaFromParam(param: LegacyToolParam = {}): any {
  const z = defineTool.schema;
  let schema: any;
  switch (param.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(schemaFromParam(param.items ?? {}));
      break;
    default:
      schema = z.any();
      break;
  }
  return param.required ? schema : schema.optional();
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function createOpencodeTools<T extends Record<string, LegacyToolDefinition>>(
  tools: T,
) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, legacy]) => {
      const args = Object.fromEntries(
        Object.entries(legacy.parameters ?? {}).map(([key, param]) => [
          key,
          schemaFromParam(param),
        ]),
      );
      const opencodeTool = defineTool({
        description: legacy.description,
        args,
        async execute(args) {
          return serializeToolResult(await legacy.handler(args));
        },
      });

      // Kept for direct unit tests of handler-level behavior; opencode uses execute().
      return [name, { ...opencodeTool, handler: legacy.handler }];
    }),
  ) as unknown as {
    [K in keyof T]: ReturnType<typeof defineTool> & {
      handler: T[K]["handler"];
    };
  };
}

function parseAgentMarkdown(fileName: string) {
  const filePath = resolve(AGENTS_DIR, fileName);
  const markdown = readFileSync(filePath, "utf8");
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match)
    throw new Error(`agent markdown is missing frontmatter: ${filePath}`);

  const frontmatter = match[1] ?? "";
  const prompt = (match[2] ?? "").trim();
  const description =
    frontmatter
      .match(/description:\s*'((?:''|[^'])*)'/)?.[1]
      ?.replaceAll("''", "'") ??
    frontmatter.match(/description:\s*(.+)/)?.[1]?.trim();
  if (!description)
    throw new Error(`agent markdown is missing description: ${filePath}`);

  const mode = frontmatter.match(/mode:\s*(\S+)/)?.[1] ?? "subagent";
  return {
    description,
    mode,
    temperature: Number(
      frontmatter.match(/temperature:\s*([0-9.]+)/)?.[1] ?? 0.2,
    ),
    permission: {
      edit: frontmatter.match(/edit:\s*(\S+)/)?.[1] ?? "deny",
      bash: frontmatter.match(/bash:\s*(\S+)/)?.[1] ?? "deny",
    },
    prompt,
  };
}

function mergeAgentConfig(existing: any, packaged: any) {
  if (!existing) return packaged;
  return {
    ...packaged,
    ...existing,
    permission: {
      ...packaged.permission,
      ...existing.permission,
    },
  };
}

function registerAgents(config: any) {
  config.agent ??= {};
  config.agent.rocky = mergeAgentConfig(
    config.agent.rocky,
    parseAgentMarkdown("rocky.md"),
  );
  config.agent.grace = mergeAgentConfig(
    config.agent.grace,
    parseAgentMarkdown("grace.md"),
  );
  config.agent.mindy = mergeAgentConfig(
    config.agent.mindy,
    parseAgentMarkdown("mindy.md"),
  );
}

/**
 * opencode plugin entrypoint (Superpowers 형식).
 *
 * 두 가지를 노출한다:
 *   1. config 훅으로 자기 저장소의 `skills/` 디렉터리를 opencode skill 탐색 경로에 추가
 *      → opencode 의 native `skill` 도구가 SKILL.md 들을 자동 발견
 *   2. tool 등록으로 `notion_get` / `notion_refresh` / `notion_status` 3 개 노출
 *      → 캐시 우선 정책 + remote Notion MCP 호출 + id 검증을 한 곳에서 처리
 *
 * 이 plugin 은 opencode 전용. Claude Code 등 다른 host 에서 같은 skill 을 쓰려면
 * `.claude-plugin/` 같은 host 별 폴더를 후속으로 추가하면 된다.
 */

/** ESM 안전 디렉터리 해석 — `__dirname` 미정의 회피. */
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const SKILLS_DIR = resolve(REPO_ROOT, "skills");
const AGENTS_DIR = resolve(REPO_ROOT, "agents");

/**
 * remote Notion MCP base URL 기본값.
 * 실제 Notion remote MCP 는 opencode 의 OAuth auth cache 를 읽어 Streamable HTTP JSON-RPC 로 호출한다.
 * 로컬 게이트웨이를 쓰거나 다른 endpoint 로 보내려면 `AGENT_TOOLKIT_NOTION_MCP_URL` 로 덮어쓴다.
 */
export const DEFAULT_NOTION_MCP_URL = "https://mcp.notion.com/mcp";
const DEFAULT_MCP_AUTH_FILE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "mcp-auth.json",
);
const DEFAULT_NOTION_MCP_KEY = "notion";

function readEnv() {
  const url =
    process.env.AGENT_TOOLKIT_NOTION_MCP_URL ?? DEFAULT_NOTION_MCP_URL;
  const authFile =
    process.env.AGENT_TOOLKIT_MCP_AUTH_FILE ?? DEFAULT_MCP_AUTH_FILE;
  const authKey =
    process.env.AGENT_TOOLKIT_NOTION_MCP_AUTH_KEY ?? DEFAULT_NOTION_MCP_KEY;
  const timeoutMs = Number.parseInt(
    process.env.AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS ?? "15000",
    10,
  );
  return {
    url: url.replace(/\/$/, ""),
    authFile,
    authKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
  };
}

interface McpAuthEntry {
  serverUrl?: string;
  tokens?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

function readMcpAuth(): McpAuthEntry | null {
  const { authFile, authKey } = readEnv();
  if (!existsSync(authFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8")) as Record<
      string,
      McpAuthEntry
    >;
    return parsed[authKey] ?? null;
  } catch {
    return null;
  }
}

function parseMcpSse(text: string): unknown {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""));
  const payload = dataLines.length > 0 ? dataLines.join("\n") : text;
  return JSON.parse(payload);
}

async function postNotionMcpJsonRpc(
  body: unknown,
  options: {
    sessionId?: string;
    signal: AbortSignal;
    accessToken: string;
    protocolVersion?: string;
  },
): Promise<{ payload: any; sessionId?: string }> {
  const { url } = readEnv();
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
  if (options.protocolVersion) {
    headers["mcp-protocol-version"] = options.protocolVersion;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Remote Notion MCP error ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    );
  }
  if (res.status === 202 || text.trim().length === 0) {
    return {
      payload: null,
      sessionId: res.headers.get("mcp-session-id") ?? options.sessionId,
    };
  }
  return {
    payload: parseMcpSse(text),
    sessionId: res.headers.get("mcp-session-id") ?? options.sessionId,
  };
}

function normalizeMcpToolResult(payload: any): RawNotionPage {
  if (payload?.error) {
    throw new Error(
      `Remote Notion MCP error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "unknown error"}`,
    );
  }

  const text = payload?.result?.content?.find?.(
    (item: { type?: string; text?: string }) =>
      item?.type === "text" && typeof item.text === "string",
  )?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(
      "Remote Notion MCP returned malformed payload (missing text content)",
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text };
  }

  const remoteIdentifier =
    typeof parsed.url === "string"
      ? parsed.url
      : typeof parsed.id === "string"
        ? parsed.id
        : null;
  if (!remoteIdentifier) {
    throw new Error(
      "Remote Notion MCP returned malformed payload (missing remote page identifier)",
    );
  }
  const id = resolveCacheKey(remoteIdentifier).pageId;
  return {
    id,
    title: typeof parsed.title === "string" ? parsed.title : "(untitled)",
    markdown: typeof parsed.text === "string" ? parsed.text : text,
  };
}

async function callAuthenticatedNotionMcp(
  pageId: string,
  input?: string,
): Promise<RawNotionPage> {
  const auth = readMcpAuth();
  const accessToken = auth?.tokens?.accessToken;
  if (!accessToken) {
    throw new Error(
      "Remote Notion MCP OAuth token not found. Run `opencode mcp list` / reconnect the Notion MCP, or set AGENT_TOOLKIT_MCP_AUTH_FILE.",
    );
  }

  const { timeoutMs } = readEnv();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init = await postNotionMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "agent-toolkit", version: "0.1.0" },
        },
      },
      { signal: ac.signal, accessToken },
    );
    const sessionId = init.sessionId;
    const protocolVersion =
      typeof init.payload?.result?.protocolVersion === "string"
        ? init.payload.result.protocolVersion
        : "2025-06-18";
    await postNotionMcpJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { signal: ac.signal, accessToken, sessionId, protocolVersion },
    );
    const fetched = await postNotionMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "notion-fetch",
          arguments: { id: input ?? pageId },
        },
      },
      { signal: ac.signal, accessToken, sessionId, protocolVersion },
    );
    return normalizeMcpToolResult(fetched.payload);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Remote Notion MCP request timed out after ${timeoutMs}ms (pageId=${pageId})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * remote Notion MCP 단일 호출.
 * 기본 Notion remote MCP 는 opencode OAuth auth cache 가 있으면 Streamable HTTP JSON-RPC 로
 * `notion-fetch` tool 을 호출한다. 이때 `input` 은 tool argument 의 `id` 로 전달된다.
 * auth cache 가 없거나 URL 이 일치하지 않으면 테스트/로컬 게이트웨이용 legacy
 * POST `${url}/getPage` { pageId } -> RawNotionPage wire format 으로 fallback 한다.
 */
export async function callRemoteNotionMcp(
  pageId: string,
  input?: string,
): Promise<RawNotionPage> {
  const { url, timeoutMs } = readEnv();
  const auth = readMcpAuth();
  if (
    auth?.tokens?.accessToken &&
    (auth.serverUrl ?? "").replace(/\/$/, "") === url
  ) {
    return callAuthenticatedNotionMcp(pageId, input);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // 테스트/로컬 게이트웨이용 legacy endpoint. 실제 Notion remote MCP 는 위의 OAuth JSON-RPC 경로를 탄다.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    const res = await fetch(`${url}/getPage`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pageId }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Remote Notion MCP error ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as RawNotionPage;
    if (!data || typeof data !== "object" || typeof data.id !== "string") {
      throw new Error(
        "Remote Notion MCP returned malformed payload (missing id)",
      );
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Remote Notion MCP request timed out after ${timeoutMs}ms (pageId=${pageId})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 응답 페이지의 id 가 요청 id 와 같은지 검증한 뒤 캐시에 기록.
 * remote 가 잘못된 페이지를 돌려줘 다른 키 아래에 캐시되는 사고를 막는다.
 */
async function fetchAndCache(
  cache: NotionCache,
  input: string,
): Promise<NotionPageResult> {
  const { pageId } = resolveCacheKey(input);
  const raw = await callRemoteNotionMcp(pageId, input);
  const rawNormalized = resolveCacheKey(raw.id).pageId;
  if (rawNormalized !== pageId) {
    throw new Error(
      `Remote Notion MCP returned wrong page (requested ${pageId}, got ${rawNormalized}) — refusing to cache`,
    );
  }
  const written = await cache.write(input, raw);
  return { ...written, fromCache: false };
}

/** 도구 핸들러: 캐시 우선. 같은 모듈에서 단위 테스트 가능하도록 export. */
export async function handleNotionGet(
  cache: NotionCache,
  input: string,
): Promise<NotionPageResult> {
  const cached = await cache.read(input);
  if (cached) return { ...cached, fromCache: true };
  return fetchAndCache(cache, input);
}

export async function handleNotionRefresh(
  cache: NotionCache,
  input: string,
): Promise<NotionPageResult> {
  return fetchAndCache(cache, input);
}

export async function handleNotionStatus(
  cache: NotionCache,
  input: string,
): Promise<NotionCacheStatus> {
  return cache.status(input);
}

export interface NotionExtractResult {
  entry: NotionPageResult["entry"];
  fromCache: boolean;
  chunkCount: number;
  chunks: NotionChunkSummary[];
  extracted: NotionActionExtraction;
}

/** 도구 핸들러: Notion page 를 캐시 우선으로 읽고 긴 문서용 청크 + 액션 후보를 반환한다. */
export async function handleNotionExtract(
  cache: NotionCache,
  input: string,
  options: { maxCharsPerChunk?: number } = {},
): Promise<NotionExtractResult> {
  const page = await handleNotionGet(cache, input);
  const chunks = chunkNotionMarkdown(page.markdown, {
    maxCharsPerChunk: options.maxCharsPerChunk,
  });
  return {
    entry: page.entry,
    fromCache: page.fromCache,
    chunkCount: chunks.length,
    chunks: summarizeNotionChunks(chunks),
    extracted: extractActionItems(chunks),
  };
}

/**
 * agent-toolkit 의 openapi_* tool 들이 받는 input 을 SpecRegistry 의 (specName, env)
 * 페어로 정규화한다.
 *
 * input 형태:
 *   - `host:env:spec` handle → registry 에서 leaf 찾아 flatten 된 specName + DEFAULT_ENVIRONMENT
 *   - URL (`http://`/`https://`/`file://`) → ad-hoc spec 으로 SpecRegistry 에 등록
 *     (`url__<sha1-16>`) + DEFAULT_ENVIRONMENT
 *   - 그 외 → throw (16-hex disk key 같은 legacy 키 형태는 v0.2 부터 미지원)
 */
function resolveSwaggerInput(
  registry: SpecRegistry,
  input: string,
  toolkitRegistry?: OpenapiRegistry,
): { specName: string; environment: string; baseUrl?: string } {
  if (isFullHandle(input)) {
    // handle → URL 까지는 toolkit-config 가 책임. specName 은 flatten 된 이름.
    const url = resolveHandleToUrl(input, toolkitRegistry);
    const [host, env, spec] = input.split(":") as [string, string, string];
    const flat = flattenHandle(host, env, spec);
    if (!registry.hasSpec(flat)) {
      // registry 가 toolkit-config 로 만들어지지 않은 (단독 진입점) 경우 ad-hoc 등록.
      registry.registerSpec(flat, {
        source: { type: "url", url },
        environments: { [DEFAULT_ENVIRONMENT]: { baseUrl: "" } },
      });
    }
    const baseUrlMaybe = registry
      .listEnvironments(flat)
      .find((e) => e.name === DEFAULT_ENVIRONMENT)?.baseUrl;
    return {
      specName: flat,
      environment: DEFAULT_ENVIRONMENT,
      ...(baseUrlMaybe ? { baseUrl: baseUrlMaybe } : {}),
    };
  }
  if (looksLikeUrl(input)) {
    const name = ephemeralSpecName(input);
    if (!registry.hasSpec(name)) {
      const { spec } = buildEphemeralSpec(input);
      registry.registerSpec(name, spec);
    }
    return { specName: name, environment: DEFAULT_ENVIRONMENT };
  }
  throw new Error(
    `openapi tool input "${input}" is not a host:env:spec handle or http(s)/file URL — pass a registered handle or a full URL`,
  );
}

function looksLikeUrl(s: string): boolean {
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("file://")
  );
}

/** openapi_search 옵션 — `scope` 는 host / host:env / host:env:spec 중 하나. */
export interface SwaggerSearchOptions {
  limit?: number;
  scope?: string;
}

/** openapi_get 결과 — fetched / parsed / dereferenced 된 OpenAPI 3.x document. */
export interface SwaggerGetResult {
  spec: string;
  environment: string;
  fromCache: boolean;
  document: OpenAPIV3.Document;
  baseUrl?: string;
}

/**
 * 도구 핸들러: 캐시 우선으로 spec 을 가져온다. 결과는 deref 된 OpenAPI 3.x document.
 * swagger 2.0 입력은 자동 변환된다.
 *
 * 변경점 (구버전 대비): raw spec JSON 이 아니라 SwaggerParser.dereference 결과 + flat
 * specName 을 리턴한다 — operationId 가 없는 spec 도 syntheticOperationId 로 잡혀
 * 후속 `openapi_endpoint` 호출에 그대로 쓸 수 있다.
 */
export async function handleSwaggerGet(
  registry: SpecRegistry,
  input: string,
  toolkitRegistry?: OpenapiRegistry,
): Promise<SwaggerGetResult> {
  const { specName, environment, baseUrl } = resolveSwaggerInput(
    registry,
    input,
    toolkitRegistry,
  );
  const before = registry
    .listSpecs()
    .find((s) => s.name === specName)?.cacheStatus;
  const indexed = await registry.loadSpec(specName, environment);
  const fromCache = before?.cached === true;
  const result: SwaggerGetResult = {
    spec: specName,
    environment,
    fromCache,
    document: indexed.document,
  };
  if (baseUrl) result.baseUrl = baseUrl;
  return result;
}

/** 도구 핸들러: 캐시 (메모리 + 디스크) 비우고 강제 재다운로드. */
export async function handleSwaggerRefresh(
  registry: SpecRegistry,
  input: string,
  toolkitRegistry?: OpenapiRegistry,
): Promise<RefreshOutcome[]> {
  const { specName } = resolveSwaggerInput(registry, input, toolkitRegistry);
  return registry.refresh(specName);
}

/** 도구 핸들러: 캐시 메타 (cached / fetchedAt / ttlSeconds) 만 조회. remote 호출 없음. */
export async function handleSwaggerStatus(
  registry: SpecRegistry,
  input: string,
  toolkitRegistry?: OpenapiRegistry,
): Promise<SpecSummary> {
  const { specName } = resolveSwaggerInput(registry, input, toolkitRegistry);
  const summary = registry.listSpecs().find((s) => s.name === specName);
  if (!summary) {
    // resolveSwaggerInput 직후라 보통 미스 발생 안 함. 안전망.
    throw new UnknownSpecError(specName);
  }
  return summary;
}

/**
 * 캐시된 spec 들을 가로질러 endpoint 검색 (점수화: operationId>path>summary>description).
 * - `options.scope` (`host` / `host:env` / `host:env:spec`) 가 주어지면 registry 에서
 *   해당 entry 들로 좁힌다. 매칭 0 건이면 throw — 사용자가 잘못된 scope 를 넘겼음을 빨리
 *   알리려고.
 * - `options.limit` 는 결과 최대 개수 (기본 20).
 * - 빈 query 는 (scope 안의) 모든 endpoint 를 limit 까지 나열.
 *
 * 검색 대상은 *현재 등록된* spec 들의 `loadSpec` 결과 — 미캐시 spec 은 백그라운드에서
 * 로드된다.
 */
export async function handleSwaggerSearch(
  registry: SpecRegistry,
  query: string,
  options: SwaggerSearchOptions = {},
  toolkitRegistry?: OpenapiRegistry,
): Promise<SwaggerSearchMatch[]> {
  const { limit, scope } = options;
  const cap =
    Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : 20;

  const allSpecs = registry.listSpecs();
  let candidates = allSpecs.map((s) => s.name);
  if (scope) {
    const allowed = new Set(resolveScopeToUrls(scope, toolkitRegistry));
    if (allowed.size === 0) {
      throw new Error(
        `openapi_search: scope "${scope}" matched no entries in openapi.registry — check ./.opencode/agent-toolkit.json or ~/.config/opencode/agent-toolkit/agent-toolkit.json`,
      );
    }
    // toolkit-config registry 에서 scope 가 매칭된 URL 들로 specName 후보를 좁힌다.
    const flatNames = new Set<string>();
    if (toolkitRegistry) {
      for (const [host, envs] of Object.entries(toolkitRegistry)) {
        for (const [env, specs] of Object.entries(envs)) {
          for (const [spec] of Object.entries(specs)) {
            // resolveScopeToUrls 가 URL 만 알려주므로, 같은 URL 을 가진 host:env:spec 핸들들을
            // 다시 모은다.
            // 효율성보다 정확성 우선 — registry 가 작다는 가정.
            flatNames.add(flattenHandle(host, env, spec));
          }
        }
      }
    }
    candidates = candidates.filter((n) => flatNames.has(n));
  }

  // 후보 spec 들을 병렬 로드. 한 spec 이 실패해도 나머지는 계속 진행하도록
  // allSettled 사용. 등록된 spec 이 많을수록 효과 큼.
  const settled = await Promise.allSettled(
    candidates.map((name) => registry.loadSpec(name)),
  );
  const indexedSpecs: IndexedSpec[] = settled
    .filter(
      (r): r is PromiseFulfilledResult<IndexedSpec> => r.status === "fulfilled",
    )
    .map((r) => r.value);

  const merged = indexedSpecs.flatMap((ix) => ix.endpoints);
  const filter = query?.trim() ? { keyword: query.trim() } : {};
  const filtered = filterEndpoints(merged, filter);
  const truncated = filtered.slice(0, cap);

  return truncated.map((e) => ({
    spec: e.specName,
    operationId: e.operationId ?? e.syntheticOperationId,
    method: e.method,
    path: e.path,
    summary: e.summary,
    tags: e.tags,
    deprecated: e.deprecated,
  }));
}

export interface SwaggerSearchMatch {
  spec: string;
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
  deprecated: boolean;
}

/** registry 트리를 평면 (host, env, spec, url, baseUrl?, format?) 리스트로 반환. */
export function handleSwaggerEnvs(
  config: ToolkitConfig,
): OpenapiRegistryEntry[] {
  return listRegistry(config);
}

/** openapi_endpoint 입력 — operationId 단독 또는 method+path 페어. */
export interface SwaggerEndpointLocator {
  operationId?: string;
  method?: string;
  path?: string;
}

/** openapi_endpoint 결과 — full detail + baseUrl 합성된 fullUrl. */
export interface SwaggerEndpointResult {
  spec: string;
  environment: string;
  endpoint: EndpointDetail;
}

/**
 * 도구 핸들러: 단일 endpoint 의 풍부한 정보 (parameters / requestBody / responses /
 * examples / fullUrl) 를 반환한다. baseUrl 이 비어 있으면 fullUrl 은 path 자체.
 */
export async function handleSwaggerEndpoint(
  registry: SpecRegistry,
  input: string,
  locator: SwaggerEndpointLocator,
  toolkitRegistry?: OpenapiRegistry,
): Promise<SwaggerEndpointResult> {
  if (!locator.operationId && !(locator.method && locator.path)) {
    throw new Error(
      "openapi_endpoint requires either operationId or both method and path",
    );
  }
  const { specName, environment } = resolveSwaggerInput(
    registry,
    input,
    toolkitRegistry,
  );
  const env = registry.getEnvironment(specName, environment);
  const indexed = await registry.loadSpec(specName, environment);
  const ep = resolveEndpoint(indexed, locator);
  if (!ep) {
    const where = locator.operationId
      ? `operationId='${locator.operationId}'`
      : `${locator.method?.toUpperCase()} ${locator.path}`;
    throw new Error(`endpoint not found in spec '${specName}' for ${where}`);
  }
  const detail = buildEndpointDetail(indexed, ep, env.baseUrl);
  return { spec: specName, environment, endpoint: detail };
}

/** openapi_tags 결과 — IndexedSpec.tags 그대로 + 부가 메타. */
export interface SwaggerTagsResult {
  spec: string;
  environment: string;
  tags: TagSummary[];
}

/** 도구 핸들러: spec 의 tag 목록 + 각 tag 의 endpoint count. */
export async function handleSwaggerTags(
  registry: SpecRegistry,
  input: string,
  toolkitRegistry?: OpenapiRegistry,
): Promise<SwaggerTagsResult> {
  const { specName, environment } = resolveSwaggerInput(
    registry,
    input,
    toolkitRegistry,
  );
  const indexed = await registry.loadSpec(specName, environment);
  return { spec: specName, environment, tags: indexed.tags };
}

/**
 * 도구 핸들러: 저널에 한 줄 append. remote 호출 없음.
 * 입력 검증과 정규화는 `AgentJournal.append` 가 담당한다.
 */
export async function handleJournalAppend(
  journal: AgentJournal,
  input: JournalAppendInput,
): Promise<JournalEntry> {
  return journal.append(input);
}

/** 도구 핸들러: 가장 최근 항목부터 필터 / limit 적용해 반환. remote 호출 없음. */
export async function handleJournalRead(
  journal: AgentJournal,
  options: JournalReadOptions = {},
): Promise<JournalEntry[]> {
  return journal.read(options);
}

/** 도구 핸들러: substring 검색 (case-insensitive). remote 호출 없음. */
export async function handleJournalSearch(
  journal: AgentJournal,
  query: string,
  options: JournalSearchOptions = {},
): Promise<JournalEntry[]> {
  return journal.search(query, options);
}

/** 도구 핸들러: 저널 메타 (라인 수, 바이트 수, 마지막 항목 시각). remote 호출 없음. */
export async function handleJournalStatus(
  journal: AgentJournal,
): Promise<JournalStatus> {
  return journal.status();
}

// ── PR review watch 도구 핸들러 ──────────────────────────────────────────────
//
// 6개 모두 export 한다 — 단위테스트가 fake `AgentJournal` 을 직접 주입할 수 있도록.
// 어떤 핸들러도 GitHub API 를 직접 호출하지 않는다 (외부 GitHub MCP 책임). 모든 상태는
// agent-journal 위에 reducer 로 표현된다 — 핸들러는 reducer 와 buildAppend 결과를
// `journal.append` 로 흘려보내는 얇은 layer 일 뿐.
//
// 사용 패턴 요약:
//   - `pr_watch_start` / `_stop` / `_status`        watch lifecycle
//   - `pr_event_record`                             외부 MCP 가 가져온 코멘트/리뷰/체크/머지 신호 1 건 흡수
//   - `pr_event_pending`                            한 핸들의 미처리 이벤트 list
//   - `pr_event_resolve`                            mindy 의 검증 결과 (accepted / rejected / deferred)

export interface PrWatchStartInput {
  handle: string;
  note?: string;
  labels?: string[];
  mergeMode?: string;
}

export interface PrWatchStartResult {
  entry: JournalEntry;
  state: PrWatchState;
}

/** 도구 핸들러: PR watch 시작. `pr_watch_start` 한 줄 append + 갱신된 state 반환. */
export async function handlePrWatchStart(
  journal: AgentJournal,
  input: PrWatchStartInput,
): Promise<PrWatchStartResult> {
  const handle = parsePrHandle(input.handle);
  // mergeMode 는 도구 description 과 agent-toolkit.json 의 schema / runtime 검증이 모두
  // `merge` / `squash` / `rebase` enum 으로 박아두므로, handler 진입 시점에서 동일 enum 으로
  // 거른다. 입력은 LLM / 사용자 손을 거치며 공백이 섞일 수 있어 *먼저 trim* 한 뒤 enum 검증
  // — 그래야 buildAppend 가 .trim() 하는 동작과 일관되고 "squash " 같은 정상 값이 반려되지
  // 않는다. 빈 문자열은 undefined 로 정규화 (mergeMode 권고 미지정 = 미설정 의도).
  const mergeMode = normalizeOptionalEnum(input.mergeMode);
  if (mergeMode !== undefined && !isMergeMode(mergeMode)) {
    throw new Error(
      `pr_watch_start: mergeMode must be one of ${MERGE_MODES.join(" / ")} — got "${input.mergeMode}"`,
    );
  }
  const entry = await journal.append(
    buildPrAppend({
      kind: "pr_watch_start",
      data: {
        handle,
        note: input.note,
        labels: input.labels,
        mergeMode,
      },
    }),
  );
  const state =
    findStateForHandle(
      await readPrWatchJournalEntries(journal),
      handle.canonical,
    ) ??
    ({
      handle,
      active: true,
      startedAt: entry.timestamp,
    } satisfies PrWatchState);
  return { entry, state };
}

export interface PrWatchStopInput {
  handle: string;
  /** `STOP_REASONS` enum 만 허용 — handler 가 검증한다 (자유 문자열 거부). */
  reason?: string;
}

export interface PrWatchStopResult {
  entry: JournalEntry;
  /** stop 직후 active 가 빠진 final state — caller 가 watch 가 끊긴 시점을 한 번에 본다. */
  state: PrWatchState;
}

export async function handlePrWatchStop(
  journal: AgentJournal,
  input: PrWatchStopInput,
): Promise<PrWatchStopResult> {
  const handle = parsePrHandle(input.handle);
  // reason 은 enum 으로만 받는다 — 자유 문자열을 막아 journal tag (`reason:<value>`) 가
  // 항상 같은 모양으로 박히게 (= 회수 / 집계 안정성). 입력은 trim 후 빈 문자열을
  // undefined 로 정규화하고 그 결과로 enum 검증 / buildAppend 호출 — 그래야 "merged "
  // 같은 정상 값이 공백 때문에 stop 실패로 이어지지 않는다.
  const reason = normalizeOptionalEnum(input.reason);
  if (reason !== undefined && !isStopReason(reason)) {
    throw new Error(
      `pr_watch_stop: reason must be one of ${STOP_REASONS.join(" / ")} — got "${input.reason}"`,
    );
  }
  const entry = await journal.append(
    buildPrAppend({
      kind: "pr_watch_stop",
      data: { handle, reason },
    }),
  );
  return {
    entry,
    state: {
      handle,
      active: false,
      stoppedAt: entry.timestamp,
    },
  };
}

export interface PrWatchStatusResult {
  active: PrWatchState[];
  totals: { active: number; pending: number };
}

/**
 * 등록된 모든 active watch + 그 PR 들의 미처리 이벤트 합계.
 * 인자가 없는 도구 — `*_envs` / `journal_status` 와 같은 패턴.
 */
export async function handlePrWatchStatus(
  journal: AgentJournal,
): Promise<PrWatchStatusResult> {
  const all = await readPrWatchJournalEntries(journal);
  const active = reduceActiveWatches(all);
  let pending = 0;
  for (const s of active) {
    pending += reducePendingEvents(s.handle, all).length;
  }
  return {
    active,
    totals: { active: active.length, pending },
  };
}

export interface PrEventRecordInput {
  handle: string;
  type: string;
  externalId: string;
  summary: string;
}

export interface PrEventRecordResult {
  entry: JournalEntry;
  ref: { type: PrEventType; externalId: string; toolkitKey: string };
  /**
   * 같은 (handle, toolkitKey) 의 `pr_event_inbound` 가 과거에 한 번이라도 박혀 있었으면 true —
   * pending 여부와 무관하다 (= 이미 resolve 된 코멘트가 polling 으로 재유입 돼도 true).
   * caller (mindy) 가 이 플래그를 보고 처리 분기 — *디스크 dedup 은 하지 않는다*.
   */
  alreadySeen: boolean;
}

/**
 * 외부 GitHub MCP 가 가져온 이벤트 1 건을 큐에 등록한다.
 *
 * polling 정의상 같은 코멘트가 두 번 (혹은 그 이상) 들어올 수 있다 — GitHub 의 list-comments
 * 류 API 는 과거 항목을 매 호출마다 반복 반환한다. `alreadySeen` 정의가 "현재 pending" 만 보면
 * 이미 resolve 처리된 이벤트가 새 이벤트처럼 surface 되어 mindy 가 같은 답글을 두 번 달
 * 위험이 있다. 따라서 *과거 inbound 의 존재 여부* 로 정의한다 (resolved 여부 무관).
 *
 * append 자체는 두 번째도 그대로 박는다 (append-only 원칙) — caller 가 `alreadySeen: true`
 * 를 보고 후속 처리를 skip 하면 lifecycle 은 그대로 유지된다.
 */
export async function handlePrEventRecord(
  journal: AgentJournal,
  input: PrEventRecordInput,
): Promise<PrEventRecordResult> {
  const handle = parsePrHandle(input.handle);
  const ref = normalizeEventRef(input.type, input.externalId);
  const before = await readPrWatchJournalEntries(journal);
  const alreadySeen = hasInboundFor(handle, ref.toolkitKey, before);
  const entry = await journal.append(
    buildPrAppend({
      kind: "pr_event_inbound",
      data: { handle, ref, summary: input.summary },
    }),
  );
  return { entry, ref, alreadySeen };
}

/**
 * 한 핸들의 미처리 이벤트 (inbound 가 있고 같은 toolkitKey 의 resolved 가 없는 것).
 * 시간 오름차순 — caller (mindy) 가 PULL → VALIDATE 흐름으로 위에서부터 본다.
 */
export async function handlePrEventPending(
  journal: AgentJournal,
  handleInput: string,
): Promise<PendingPrEvent[]> {
  const handle = parsePrHandle(handleInput);
  return reducePendingEvents(handle, await readPrWatchJournalEntries(journal));
}

export interface PrEventResolveInput {
  handle: string;
  type: string;
  externalId: string;
  decision: ResolveDecision;
  reasoning: string;
  replyExternalId?: string;
}

export interface PrEventResolveResult {
  entry: JournalEntry;
  resolved: { type: PrEventType; externalId: string; toolkitKey: string };
}

/**
 * mindy 의 검증 결과를 박는다.
 *
 * orphan resolve 가드: 같은 (handle, toolkitKey) 의 `pr_event_inbound` 가 한 번도 박혀 있지
 * 않으면 throw 한다. orphan 이 그대로 박히면 `reducePendingEvents` 의 `resolvedKeys` 에 그
 * toolkitKey 가 포함되어, 이후 진짜 inbound 가 들어와도 영구 제외 (검토 큐 유실) — 그래서
 * caller (mindy) 의 pending 목록을 다시 보고 정확한 toolkitKey 로 다시 호출하라고 강제한다.
 *
 * decision 검증은 `buildPrAppend` 가 한 번 더 깔지만, handler 단에서 먼저 throw 해 동일
 * 메시지 톤 / context 를 유지한다.
 */
export async function handlePrEventResolve(
  journal: AgentJournal,
  input: PrEventResolveInput,
): Promise<PrEventResolveResult> {
  const handle = parsePrHandle(input.handle);
  const ref = normalizeEventRef(input.type, input.externalId);
  // 입력은 trim 후 enum 검증 — "accepted " 같은 공백 포함 정상 값이 VALIDATE 단계에서
  // resolve 실패로 이어지지 않게. 정규화된 값을 buildAppend 와 journal 양쪽에 동일하게
  // 흘려보낸다 (저장 일관성).
  const decisionRaw =
    typeof input.decision === "string" ? input.decision.trim() : input.decision;
  const decision = decisionRaw as ResolveDecision;
  if (!RESOLVE_DECISIONS.includes(decision)) {
    throw new Error(
      `pr_event_resolve: decision must be one of ${RESOLVE_DECISIONS.join(", ")} — got "${input.decision}"`,
    );
  }
  const before = await readPrWatchJournalEntries(journal);
  if (!hasInboundFor(handle, ref.toolkitKey, before)) {
    throw new Error(
      `pr_event_resolve: no prior pr_event_inbound for handle "${handle.canonical}" + toolkitKey "${ref.toolkitKey}" (type=${ref.type}, externalId=${ref.externalId}) — call pr_event_pending to confirm the right key, then resolve.`,
    );
  }
  const entry = await journal.append(
    buildPrAppend({
      kind: "pr_event_resolved",
      data: {
        handle,
        ref,
        decision,
        reasoning: input.reasoning,
        replyExternalId: input.replyExternalId,
      },
    }),
  );
  return { entry, resolved: ref };
}

/**
 * PR review watch 라이프사이클 entry 만 시간 오름차순으로 읽어 reducer 들에 넘긴다.
 *
 * 이전엔 모든 종류의 entry 를 (decisions / blockers / SPEC anchor / journal 메모 등 포함)
 * 한 번에 5000 까지 끌어와 *그 부분집합에서* PR 항목을 reduce 했다 — 다른 도메인 entry 가
 * 5000 을 채우면 오래된 `pr_watch_start` / `pr_event_inbound` 가 잘려 (1) active watch
 * 누락 / (2) `alreadySeen: false` 오판 / (3) 정상 inbound 를 orphan 으로 오인해
 * `pr_event_resolve` 가 실패하는 정확성 저하가 일어났다.
 *
 * 메인 태그 `pr-watch` 로 좁혀 PR 항목만 limit 안에 채우게 하면 cap 동일성 (`100_000`) 이
 * 동일한 PR 라이프사이클 라이브 환경에서는 사실상 무한대로 동작 — 그럼에도 폭주 방지를
 * 위해 *명시적 cap* 은 유지한다 (limit 도달 시 동작이 silent 변경되지 않도록 cap 자체를
 * 수치로 박아 추후 모니터링이 가능하게).
 */
const PR_WATCH_READ_LIMIT = 100_000;

async function readPrWatchJournalEntries(
  journal: AgentJournal,
): Promise<JournalEntry[]> {
  const recent = await journal.read({
    tag: PR_WATCH_TAG,
    limit: PR_WATCH_READ_LIMIT,
  });
  return [...recent].reverse();
}

/**
 * 도구 입력에서 enum 후보 값을 정규화한다 — string 이 아니거나 trim 후 비어 있으면
 * undefined, 아니면 trim 결과를 그대로 돌려준다. enum 검증은 caller 가 한다.
 *
 * 같은 패턴이 `pr_watch_start.mergeMode` / `pr_watch_stop.reason` 두 곳에서 쓰이고,
 * 의도는 동일: LLM / 사용자 입력에서 끼는 공백을 enum 검증 *전에* 흡수해 정상 값이
 * 무의미한 형식 차이로 거부되는 것을 막는다.
 */
function normalizeOptionalEnum(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function findStateForHandle(
  entries: JournalEntry[],
  canonical: string,
): PrWatchState | undefined {
  for (const s of reduceActiveWatches(entries)) {
    if (s.handle.canonical === canonical) return s;
  }
  return undefined;
}

// ── MySQL 도구 핸들러 ────────────────────────────────────────────────────────
//
// 5개 모두 export 한다 — 단위테스트가 fake `MysqlExecutor` 또는 fake `ToolkitConfig` 를
// 주입할 수 있도록. 실제 등록부 (default export) 는 `MysqlExecutorRegistry` 를 한 번
// 만든 뒤 핸들마다 `getExecutor` 로 호출한다. 자격증명은 mysql-context 안에서만 살아 있고
// 도구 응답 / 에러 / 메타에는 절대 노출되지 않는다.

/** registry 트리를 평면 (handle, host, env, db, authMode, authEnv, …) 리스트로 반환. */
export function handleMysqlEnvs(config: ToolkitConfig): MysqlRegistryEntry[] {
  return listMysqlRegistry(config);
}

/** 핸들 메타 + `SELECT 1` ping. ping 실패 시 mysql2 에러를 그대로 surface. */
export async function handleMysqlStatus(
  registry: MysqlExecutorRegistry,
  config: ToolkitConfig,
  handle: string,
): Promise<MysqlRegistryEntry & { ok: boolean }> {
  const meta = mysqlDescribeHandle(handle, config);
  const executor = registry.getExecutor(handle, config);
  const { ok } = await mysqlPingHandle(executor);
  return { ...meta, ok };
}

/** `SHOW FULL TABLES` 결과. */
export async function handleMysqlTables(
  registry: MysqlExecutorRegistry,
  config: ToolkitConfig,
  handle: string,
): Promise<Array<{ name: string; type: string }>> {
  const executor = registry.getExecutor(handle, config);
  return mysqlListTables(executor);
}

/** 테이블 미지정 시 컬럼 요약, 지정 시 SHOW CREATE TABLE + SHOW INDEX FROM 합본. */
export async function handleMysqlSchema(
  registry: MysqlExecutorRegistry,
  config: ToolkitConfig,
  handle: string,
  table?: string,
): Promise<Awaited<ReturnType<typeof mysqlDescribeTable>>> {
  const executor = registry.getExecutor(handle, config);
  return mysqlDescribeTable(executor, table);
}

/** read-only 검증 + LIMIT 강제 후 SQL 실행. SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 만 통과. */
export async function handleMysqlQuery(
  registry: MysqlExecutorRegistry,
  config: ToolkitConfig,
  handle: string,
  sql: string,
  options: RunReadonlyQueryOptions = {},
): Promise<MysqlQueryResult> {
  // SQL guard 는 연결/자격증명 해석보다 먼저 실행한다. write/DDL/multi-statement 요청은
  // DB env var 가 없더라도 네트워크/secret surface 에 닿지 않고 거부되어야 한다.
  assertReadOnlySql(sql);
  const executor = registry.getExecutor(handle, config);
  return mysqlRunReadonlyQuery(executor, sql, options);
}

/**
 * opencode plugin default export.
 * `directory` 는 opencode 가 plugin 을 로드한 cwd. 우리는 import.meta 기반으로
 * 자기 저장소의 skills/ 를 절대 경로로 잡는다.
 */
export default async function agentToolkitPlugin(_input: unknown) {
  const cache = createCacheFromEnv();
  const journal = createJournalFromEnv();

  // user / project agent-toolkit.json 로드. loadConfig 는 파일별 try-catch 로 자체
  // 회복하므로 한 쪽이 손상돼도 다른 쪽은 그대로 살아나 registry 에 들어온다.
  // 손상된 파일별 에러는 console.error 로 한 줄씩 surfacing.
  const { config: toolkitConfig, errors: configErrors } = await loadConfig();
  for (const e of configErrors) {
    console.error(
      `agent-toolkit: skipped config file ${e.source} — ${e.message}. Other config sources still apply.`,
    );
  }
  const registry = toolkitConfig.openapi?.registry;
  // SpecRegistry 는 toolkit-config 의 openapi.registry 를 spec 트리로 받는다. 추가로
  // 사용자가 ad-hoc URL 을 넘기면 `resolveSwaggerInput` 이 런타임에 spec entry 를 끼워
  // 넣는다 (registerSpec).
  const openapiRegistry = createAgentToolkitRegistry({
    ...(registry !== undefined ? { registry } : {}),
  });

  // MySQL pool 들은 핸들마다 lazy 로 만들어 캐시한다 — 한 turn 안에서 같은 핸들로
  // 여러 도구가 호출돼도 connection 을 재사용한다.
  const mysqlRegistry = new MysqlExecutorRegistry(process.env);

  // 정상 종료 (process 가 자연 exit 시) 에 한해 lazy 로 만든 mysql2 pool 들을 비동기로
  // 닫는다. 실패는 한 줄 로깅 후 무시 (best-effort) — opencode 의 plugin lifecycle 에
  // teardown 훅이 따로 있으면 그쪽으로 옮길 자리. SIGINT / SIGTERM 은 핸들러를 등록하면
  // default exit 동작이 사라지는 부작용이 있어 의도적으로 등록하지 않고 OS 의 소켓 회수에
  // 맡긴다. `beforeExit` 가 한 번 호출된 뒤 다시 일이 들어올 가능성도 있어 `once` 보다
  // 더 보수적으로 `on` + 가드 로도 가능하지만, plugin 이 한 번 더 진입해 close 후의
  // executor 를 다시 쓰면 mysql2 가 명확한 에러를 내므로 디버깅에는 오히려 도움된다.
  process.once("beforeExit", () => {
    mysqlRegistry.closeAll().catch((err) => {
      console.error(
        `agent-toolkit: failed to close MySQL pools cleanly — ${(err as Error).message}`,
      );
    });
  });

  return {
    /**
     * opencode 의 skill / agent 탐색 경로에 자기 저장소의 디렉터리를 절대 경로로 끼워 넣는다.
     * Superpowers 와 동일한 패턴. plural / singular 키 모두 시도해 둬서 opencode 가 어느
     * 쪽을 쓰든 안전하게 동작한다 (현재 docs 는 plural 우선).
     */
    config(config: any) {
      const ensurePath = (host: any, key: string, value: string) => {
        host[key] ??= { paths: [] };
        if (!Array.isArray(host[key].paths)) host[key].paths = [];
        if (!host[key].paths.includes(value)) host[key].paths.push(value);
      };
      ensurePath(config, "skills", SKILLS_DIR);
      registerAgents(config);
    },

    /** opencode tool 등록. */
    tool: createOpencodeTools({
      notion_get: {
        description:
          "Notion 페이지를 캐시 우선 정책으로 읽는다. 캐시 hit 이면 remote 호출 없음. miss 면 remote MCP fetch 후 캐시에 저장. (input: pageId 또는 URL)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleNotionGet(cache, input);
        },
      },
      notion_refresh: {
        description:
          "캐시를 무시하고 remote Notion MCP 에서 강제로 다시 가져와 캐시를 갱신한다. (input: pageId 또는 URL)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleNotionRefresh(cache, input);
        },
      },
      notion_status: {
        description:
          "Notion 페이지 캐시 메타(저장 시각, TTL, 만료 여부)만 조회한다. remote 호출 없음. (input: pageId 또는 URL)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleNotionStatus(cache, input);
        },
      },
      notion_extract: {
        description:
          "긴 Notion 페이지를 캐시 우선 정책으로 읽고 heading 기반 chunk 와 구현 액션 후보(requirements/screens/apis/todos/questions)를 반환한다. remote 호출 정책은 notion_get 과 동일. (input: pageId 또는 URL, maxCharsPerChunk?: chunk 최대 문자 수 기본 1400)",
        parameters: {
          input: { type: "string", required: true },
          maxCharsPerChunk: { type: "number", required: false },
        },
        async handler({
          input,
          maxCharsPerChunk,
        }: {
          input: string;
          maxCharsPerChunk?: number;
        }) {
          return handleNotionExtract(cache, input, { maxCharsPerChunk });
        },
      },
      openapi_get: {
        description:
          "OpenAPI / Swagger spec 을 캐시 우선 정책으로 가져온다. swagger 2.0 은 자동으로 OpenAPI 3.0 으로 변환되고 $ref 는 모두 deref 된다. 캐시 hit 이면 remote 호출 없음. (input: spec URL 또는 agent-toolkit.json 의 host:env:spec handle)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerGet(openapiRegistry, input, registry);
        },
      },
      openapi_refresh: {
        description:
          "캐시 (메모리 + 디스크) 를 무시하고 OpenAPI spec 을 강제 재다운로드한다. (input: spec URL 또는 host:env:spec handle)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerRefresh(openapiRegistry, input, registry);
        },
      },
      openapi_status: {
        description:
          "캐시된 OpenAPI spec 의 메타 (cached / fetchedAt / ttlSeconds / environments) 만 조회. remote 호출 없음. (input: spec URL 또는 host:env:spec handle)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerStatus(openapiRegistry, input, registry);
        },
      },
      openapi_search: {
        description:
          "캐시된 OpenAPI spec 들을 가로질러 endpoint 를 점수화 검색한다 (operationId>path>summary>description). remote 호출 없음. (query: 검색어, limit?: 결과 최대 개수 기본 20, scope?: agent-toolkit.json 에 등록된 host / host:env / host:env:spec — 주면 그 안에서만 검색)",
        parameters: {
          query: { type: "string", required: true },
          limit: { type: "number", required: false },
          scope: { type: "string", required: false },
        },
        async handler({
          query,
          limit,
          scope,
        }: {
          query: string;
          limit?: number;
          scope?: string;
        }) {
          return handleSwaggerSearch(
            openapiRegistry,
            query,
            { limit, scope },
            registry,
          );
        },
      },
      openapi_envs: {
        description:
          "agent-toolkit.json 의 openapi.registry 를 host:env:spec 평면 리스트로 반환한다. baseUrl / format 이 leaf 에 선언돼 있으면 함께 반환. remote 호출 없음. config 가 없거나 비어 있으면 빈 배열.",
        parameters: {},
        async handler() {
          return handleSwaggerEnvs(toolkitConfig);
        },
      },
      openapi_endpoint: {
        description:
          "단일 endpoint 의 풍부한 정보 (parameters / requestBody / responses / examples / fullUrl) 를 반환한다. baseUrl 은 host:env:spec leaf 의 baseUrl 또는 빈 문자열 — 비면 fullUrl 은 path 자체. (input: spec URL 또는 host:env:spec handle. operationId 단독, 또는 method+path 페어 중 하나 필수.)",
        parameters: {
          input: { type: "string", required: true },
          operationId: { type: "string", required: false },
          method: { type: "string", required: false },
          path: { type: "string", required: false },
        },
        async handler({
          input,
          operationId,
          method,
          path,
        }: {
          input: string;
          operationId?: string;
          method?: string;
          path?: string;
        }) {
          return handleSwaggerEndpoint(
            openapiRegistry,
            input,
            { operationId, method, path },
            registry,
          );
        },
      },
      openapi_tags: {
        description:
          "spec 의 OpenAPI tag 목록 + 각 tag 의 endpoint 개수를 반환한다. (input: spec URL 또는 host:env:spec handle)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerTags(openapiRegistry, input, registry);
        },
      },
      journal_append: {
        description:
          "에이전트 저널에 한 줄을 append-only 로 기록한다. 다음 turn 에 인용할 결정 / blocker / 사용자 답변 / 메모를 남길 때 사용. (content: 본문 필수, kind?: decision/blocker/answer/note 등 자유 문자열, 기본 'note', tags?: 문자열 배열, pageId?: 연결할 Notion page id 또는 URL — 정규화되어 저장)",
        parameters: {
          content: { type: "string", required: true },
          kind: { type: "string", required: false },
          tags: {
            type: "array",
            items: { type: "string" },
            required: false,
          },
          pageId: { type: "string", required: false },
        },
        async handler({
          content,
          kind,
          tags,
          pageId,
        }: {
          content: string;
          kind?: string;
          tags?: string[];
          pageId?: string;
        }) {
          return handleJournalAppend(journal, { content, kind, tags, pageId });
        },
      },
      journal_read: {
        description:
          "저널을 가장 최근 항목부터 필터 / limit 적용해 반환한다. 손상된 라인은 자동 skip. remote 호출 없음. (limit?: 결과 최대 개수 기본 20, kind?: 종류 정확 일치, tag?: 태그 정확 일치, pageId?: Notion page id / URL 로 page 묶인 항목만, since?: ISO8601 — 그 시각 이후 항목만)",
        parameters: {
          limit: { type: "number", required: false },
          kind: { type: "string", required: false },
          tag: { type: "string", required: false },
          pageId: { type: "string", required: false },
          since: { type: "string", required: false },
        },
        async handler({
          limit,
          kind,
          tag,
          pageId,
          since,
        }: {
          limit?: number;
          kind?: string;
          tag?: string;
          pageId?: string;
          since?: string;
        }) {
          return handleJournalRead(journal, {
            limit,
            kind,
            tag,
            pageId,
            since,
          });
        },
      },
      journal_search: {
        description:
          "저널을 substring (case-insensitive) 으로 검색한다. content / kind / tags / pageId 를 매칭한다. 빈 query 는 (kind 필터 한정) 가장 최근부터 나열. remote 호출 없음. (query: 검색어, limit?: 결과 최대 개수 기본 20, kind?: 종류 필터)",
        parameters: {
          query: { type: "string", required: true },
          limit: { type: "number", required: false },
          kind: { type: "string", required: false },
        },
        async handler({
          query,
          limit,
          kind,
        }: {
          query: string;
          limit?: number;
          kind?: string;
        }) {
          return handleJournalSearch(journal, query, { limit, kind });
        },
      },
      journal_status: {
        description:
          "저널 메타(파일 경로, 존재 여부, 유효 항목 수 — 손상 라인 skip, 바이트 크기, 마지막 항목 시각) 만 조회한다. remote 호출 없음.",
        parameters: {},
        async handler() {
          return handleJournalStatus(journal);
        },
      },
      pr_watch_start: {
        description:
          "GitHub PR review watch 를 시작한다. journal 에 `pr_watch_start` 한 줄 append + 갱신된 watch state 반환. 토킷은 GitHub API 를 직접 호출하지 않는다 — 코멘트/리뷰 수신은 외부 GitHub MCP 가 처리한 결과를 `pr_event_record` 로 등록. (handle: `owner/repo#123` 또는 https://github.com/.../pull/N URL, note?: 한 줄 메모, labels?: 권고 레이블 list, mergeMode?: `merge`/`squash`/`rebase`)",
        parameters: {
          handle: { type: "string", required: true },
          note: { type: "string", required: false },
          labels: {
            type: "array",
            items: { type: "string" },
            required: false,
          },
          mergeMode: { type: "string", required: false },
        },
        async handler({
          handle,
          note,
          labels,
          mergeMode,
        }: {
          handle: string;
          note?: string;
          labels?: string[];
          mergeMode?: string;
        }) {
          return handlePrWatchStart(journal, {
            handle,
            note,
            labels,
            mergeMode,
          });
        },
      },
      pr_watch_stop: {
        description:
          "GitHub PR review watch 를 종료한다. journal 에 `pr_watch_stop` 한 줄 append + final state 반환. 머지/닫힘은 외부 GitHub MCP 응답을 caller (mindy) 가 보고 reason 을 박는다. (handle: 등록된 watch 의 handle, reason?: `merged`/`closed`/`manual` 등)",
        parameters: {
          handle: { type: "string", required: true },
          reason: { type: "string", required: false },
        },
        async handler({ handle, reason }: { handle: string; reason?: string }) {
          return handlePrWatchStop(journal, { handle, reason });
        },
      },
      pr_watch_status: {
        description:
          "현재 active 인 모든 PR watch 와 그 PR 들의 미처리 이벤트 합계를 반환한다. journal 한 번만 reduce — remote 호출 없음. 인자 없음.",
        parameters: {},
        async handler() {
          return handlePrWatchStatus(journal);
        },
      },
      pr_event_record: {
        description:
          "외부 GitHub MCP 가 가져온 PR 이벤트 1 건 (코멘트/리뷰/리뷰 코멘트/체크/머지/닫힘) 을 watch 큐에 등록한다. polling 정의상 같은 코멘트가 두 번 들어올 수 있어 — 같은 (type, externalId) 가 이미 있으면 entry 는 두 번째도 append 되지만 `alreadySeen: true` 로 응답 (디스크 dedup 안 함). (handle: PR 핸들, type: `issue_comment`/`pr_review`/`pr_review_comment`/`check_run`/`status`/`merge`/`close`, externalId: 외부 MCP 의 numeric/sha/timestamp id, summary: 한 줄 요약 — author + 짧은 발췌)",
        parameters: {
          handle: { type: "string", required: true },
          type: { type: "string", required: true },
          externalId: { type: "string", required: true },
          summary: { type: "string", required: true },
        },
        async handler({
          handle,
          type,
          externalId,
          summary,
        }: {
          handle: string;
          type: string;
          externalId: string;
          summary: string;
        }) {
          return handlePrEventRecord(journal, {
            handle,
            type,
            externalId,
            summary,
          });
        },
      },
      pr_event_pending: {
        description:
          "한 PR 핸들의 미처리 이벤트 list. inbound 가 있고 같은 toolkitKey 의 resolved 가 없는 것만 시간 오름차순으로 반환. remote 호출 없음. (handle: PR 핸들)",
        parameters: { handle: { type: "string", required: true } },
        async handler({ handle }: { handle: string }) {
          return handlePrEventPending(journal, handle);
        },
      },
      pr_event_resolve: {
        description:
          "PR 이벤트 1 건의 검증 결과를 박는다 — accepted (수정/답글 완료) / rejected (반박 답글 완료) / deferred (다음 turn 으로 미룸). 같은 (type, externalId) 의 inbound 가 이미 있어야 의미가 있음. 외부 GitHub MCP 로의 reply post 자체는 caller (mindy) 가 직접 호출 — 그 commentId 를 `replyExternalId` 로 함께 박아 추후 추적. (handle, type, externalId, decision, reasoning: 한 줄 근거, replyExternalId?: 외부 MCP 가 돌려준 reply commentId)",
        parameters: {
          handle: { type: "string", required: true },
          type: { type: "string", required: true },
          externalId: { type: "string", required: true },
          decision: { type: "string", required: true },
          reasoning: { type: "string", required: true },
          replyExternalId: { type: "string", required: false },
        },
        async handler({
          handle,
          type,
          externalId,
          decision,
          reasoning,
          replyExternalId,
        }: {
          handle: string;
          type: string;
          externalId: string;
          decision: ResolveDecision;
          reasoning: string;
          replyExternalId?: string;
        }) {
          return handlePrEventResolve(journal, {
            handle,
            type,
            externalId,
            decision,
            reasoning,
            replyExternalId,
          });
        },
      },
      mysql_envs: {
        description:
          "agent-toolkit.json 의 mysql.connections 를 host:env:db 평면 리스트로 반환한다. 비밀번호 / DSN 의 *값* 은 노출하지 않고 env 변수 *이름* 만 보여 준다. remote 호출 없음.",
        parameters: {},
        async handler() {
          return handleMysqlEnvs(toolkitConfig);
        },
      },
      mysql_status: {
        description:
          "MySQL host:env:db 핸들의 메타 (host / port / user / database 또는 dsnEnv 모드 표시) + 짧은 SELECT 1 ping. (handle: 등록된 host:env:db)",
        parameters: { handle: { type: "string", required: true } },
        async handler({ handle }: { handle: string }) {
          return handleMysqlStatus(mysqlRegistry, toolkitConfig, handle);
        },
      },
      mysql_tables: {
        description:
          "SHOW FULL TABLES — 핸들의 디폴트 database 안 테이블 / 뷰 목록을 반환한다. (handle: 등록된 host:env:db)",
        parameters: { handle: { type: "string", required: true } },
        async handler({ handle }: { handle: string }) {
          return handleMysqlTables(mysqlRegistry, toolkitConfig, handle);
        },
      },
      mysql_schema: {
        description:
          "table 미지정: INFORMATION_SCHEMA.COLUMNS 의 모든 테이블 컬럼 요약. table 지정: SHOW CREATE TABLE + SHOW INDEX FROM 합본. (handle: 등록된 host:env:db, table?: 테이블 이름)",
        parameters: {
          handle: { type: "string", required: true },
          table: { type: "string", required: false },
        },
        async handler({ handle, table }: { handle: string; table?: string }) {
          return handleMysqlSchema(mysqlRegistry, toolkitConfig, handle, table);
        },
      },
      mysql_query: {
        description:
          "검증된 read-only SQL (SELECT / SHOW / DESCRIBE / DESC / EXPLAIN / WITH) 만 실행한다. INSERT / UPDATE / DELETE / DDL / SET / CALL / LOAD / multi-statement / INTO OUTFILE 은 모두 거부. SELECT / WITH 에는 LIMIT 가 강제 부착되거나 cap 으로 재작성된다. (handle: 등록된 host:env:db, sql: SQL, limit?: row 캡 — 미지정 시 100, 절대 상한 1000)",
        parameters: {
          handle: { type: "string", required: true },
          sql: { type: "string", required: true },
          limit: { type: "number", required: false },
        },
        async handler({
          handle,
          sql,
          limit,
        }: {
          handle: string;
          sql: string;
          limit?: number;
        }) {
          return handleMysqlQuery(mysqlRegistry, toolkitConfig, handle, sql, {
            limit,
          });
        },
      },
      spec_pact_fragment: {
        description: `spec-pact 의 모드별 fragment 본문을 반환한다 (Phase 6.A — 모드 본문이 SKILL.md 에서 분리되어 plugin 절대경로 fragment 파일에 산다). grace 가 모드를 결정한 뒤 정확히 한 번만 호출. 외부 설치 (\`agent-toolkit@git+...\`) 환경에서도 사용자 cwd 와 무관하게 동작한다. (mode: ${SPEC_PACT_MODES.join(" / ")})`,
        parameters: {
          mode: { type: "string", required: true },
        },
        async handler({ mode }: { mode: string }): Promise<SpecPactFragment> {
          const validated: SpecPactMode = assertSpecPactMode(mode);
          return loadSpecPactFragment(SKILLS_DIR, validated);
        },
      },
    }),
  };
}
