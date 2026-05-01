import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NotionCache,
  resolveCacheKey,
  notionToMarkdown,
  createCacheFromEnv,
  type RawNotionPage,
  type NotionPageResult,
  type NotionCacheStatus,
} from "../../lib/notion-context";
import {
  OpenapiCache,
  createOpenapiCacheFromEnv,
  resolveSpecKey,
  searchEndpoints,
  assertOpenapiShape,
  type OpenapiCacheStatus,
  type OpenapiEndpointMatch,
  type OpenapiSpec,
  type OpenapiSpecResult,
} from "../../lib/openapi-context";

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
 * Notion 공식 remote MCP 가 OAuth 로 인증을 처리하므로 이 plugin 은 토큰을 다루지 않는다.
 * 로컬 게이트웨이를 쓰거나 다른 endpoint 로 보내려면 `AGENT_TOOLKIT_NOTION_MCP_URL` 로 덮어쓴다.
 */
export const DEFAULT_NOTION_MCP_URL = "https://mcp.notion.com/mcp";

/**
 * OpenAPI / Swagger spec 다운로드 timeout 기본값.
 * Notion 호출보다 spec 본문이 큰 경우가 많아 더 길게 잡는다.
 * `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS` 로 덮어쓴다.
 */
export const DEFAULT_OPENAPI_DOWNLOAD_TIMEOUT_MS = 30_000;

function readEnv() {
  const url = process.env.AGENT_TOOLKIT_NOTION_MCP_URL ?? DEFAULT_NOTION_MCP_URL;
  const timeoutMs = Number.parseInt(
    process.env.AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS ?? "15000",
    10,
  );
  return {
    url: url.replace(/\/$/, ""),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
  };
}

/**
 * OpenAPI 다운로드용 env 만 읽는다 — cache dir / TTL 은 cache 모듈이 직접 읽으므로 여기선 timeout 만.
 */
function readOpenapiEnv() {
  const timeoutMs = Number.parseInt(
    process.env.AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS ??
      String(DEFAULT_OPENAPI_DOWNLOAD_TIMEOUT_MS),
    10,
  );
  return {
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_OPENAPI_DOWNLOAD_TIMEOUT_MS,
  };
}

/**
 * remote Notion MCP 단일 호출.
 * wire format: POST `${url}/getPage` { pageId } -> RawNotionPage
 * 다른 wire 가 필요해지면 이 함수만 교체.
 */
export async function callRemoteNotionMcp(
  pageId: string,
): Promise<RawNotionPage> {
  const { url, timeoutMs } = readEnv();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // 인증은 remote MCP 측 OAuth 가 처리. 이 plugin 은 헤더에 자격증명을 붙이지 않는다.
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
      throw new Error("Remote Notion MCP returned malformed payload (missing id)");
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
  const raw = await callRemoteNotionMcp(pageId);
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

/**
 * 공유된 OpenAPI / Swagger JSON spec 을 한 번 다운로드한다.
 * wire format: GET `${specUrl}` -> JSON OpenAPI document.
 *
 * YAML 은 MVP 에서 미지원 — content-type 무관하게 JSON parse 만 시도한다 (parse 실패 → throw).
 * timeout / 빈 응답 / 잘못된 shape 는 모두 메시지에 URL 과 함께 throw.
 */
export async function downloadOpenapiSpec(
  specUrl: string,
): Promise<OpenapiSpec> {
  const { timeoutMs } = readOpenapiEnv();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(specUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenAPI download error ${res.status} ${res.statusText} (url=${specUrl}): ${body.slice(0, 200)}`,
      );
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(
        `OpenAPI download from ${specUrl} returned non-JSON body (first 120 chars: ${text.slice(0, 120)})`,
      );
    }
    assertOpenapiShape(data);
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `OpenAPI download timed out after ${timeoutMs}ms (url=${specUrl})`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 다운로드 → 검증 → 캐시에 기록.
 * Notion 의 `fetchAndCache` 와 같은 모양이지만 id 검증 단은 없다 (URL 자체가 키).
 *
 * 16-hex 키 입력 (`swagger_status` / search 결과로 얻은 디스크 key) 으로 들어왔을 때는
 * 캐시 메타에서 원본 URL 을 복구한다 — 메타까지 사라진 경우엔 키를 fetch URL 로 쓰면
 * `ERR_INVALID_URL` 이 나므로 명확한 에러로 거부한다.
 */
async function fetchAndCacheSpec(
  cache: OpenapiCache,
  input: string,
): Promise<OpenapiSpecResult> {
  const { isKeyInput } = resolveSpecKey(input);
  let specUrl = input;
  if (isKeyInput) {
    const recovered = await cache.peekSpecUrl(input);
    if (!recovered) {
      throw new Error(
        `Cached key "${input}" has no recoverable spec URL — pass the original spec URL or use swagger_search to find one.`,
      );
    }
    specUrl = recovered;
  }
  const spec = await downloadOpenapiSpec(specUrl);
  const written = await cache.write(specUrl, spec);
  return { ...written, fromCache: false };
}

/** 도구 핸들러: 캐시 우선. 단위 테스트에서 직접 호출 가능하도록 export. */
export async function handleSwaggerGet(
  cache: OpenapiCache,
  input: string,
): Promise<OpenapiSpecResult> {
  const cached = await cache.read(input);
  if (cached) return { ...cached, fromCache: true };
  return fetchAndCacheSpec(cache, input);
}

export async function handleSwaggerRefresh(
  cache: OpenapiCache,
  input: string,
): Promise<OpenapiSpecResult> {
  return fetchAndCacheSpec(cache, input);
}

export async function handleSwaggerStatus(
  cache: OpenapiCache,
  input: string,
): Promise<OpenapiCacheStatus> {
  return cache.status(input);
}

/**
 * 캐시된 모든 spec 을 가로질러 endpoint substring 검색.
 * - 결과는 caller 가 입력한 `limit` 까지 (기본 20).
 * - 빈 query 는 캐시된 모든 endpoint 를 limit 까지 나열.
 */
export async function handleSwaggerSearch(
  cache: OpenapiCache,
  query: string,
  limit?: number,
): Promise<OpenapiEndpointMatch[]> {
  const cap = Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : 20;
  const all = await cache.list();
  const out: OpenapiEndpointMatch[] = [];
  for (const { entry, spec } of all) {
    const remaining = cap - out.length;
    if (remaining <= 0) break;
    const matches = searchEndpoints(spec, query, remaining);
    for (const m of matches) {
      out.push({
        specKey: entry.key,
        specUrl: entry.specUrl,
        specTitle: entry.title,
        method: m.method,
        path: m.path,
        operationId: m.operationId,
        summary: m.summary,
        tags: m.tags,
      });
      if (out.length >= cap) break;
    }
  }
  return out;
}

/**
 * opencode plugin default export.
 * `directory` 는 opencode 가 plugin 을 로드한 cwd. 우리는 import.meta 기반으로
 * 자기 저장소의 skills/ 를 절대 경로로 잡는다.
 */
export default async function agentToolkitPlugin(_input: unknown) {
  const cache = createCacheFromEnv();
  const openapi = createOpenapiCacheFromEnv();

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
      ensurePath(config, "agents", AGENTS_DIR);
      // 일부 버전이 singular `agent` 를 쓰는 경우의 호환 셔틀.
      ensurePath(config, "agent", AGENTS_DIR);
    },

    /** opencode tool 등록. notion_get / notion_refresh / notion_status. */
    tool: {
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
      swagger_get: {
        description:
          "OpenAPI / Swagger JSON spec 을 캐시 우선 정책으로 가져온다. 캐시 hit 이면 remote 호출 없음. miss 면 spec URL 을 GET 으로 받아 형식 검증 후 캐시에 저장. (input: spec URL 또는 이미 캐시된 16-hex key)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerGet(openapi, input);
        },
      },
      swagger_refresh: {
        description:
          "캐시를 무시하고 OpenAPI spec URL 에서 강제로 다시 가져와 캐시를 갱신한다. (input: spec URL)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerRefresh(openapi, input);
        },
      },
      swagger_status: {
        description:
          "캐시된 OpenAPI spec 의 메타(저장 시각, TTL, 만료 여부, title, endpoint 수)만 조회. remote 호출 없음. (input: spec URL 또는 16-hex key)",
        parameters: { input: { type: "string", required: true } },
        async handler({ input }: { input: string }) {
          return handleSwaggerStatus(openapi, input);
        },
      },
      swagger_search: {
        description:
          "캐시된 모든 OpenAPI spec 을 가로질러 path / method / tag / operationId / summary 를 substring 으로 검색한다. remote 호출 없음. (query: 검색어, limit?: 결과 최대 개수, 기본 20)",
        parameters: {
          query: { type: "string", required: true },
          limit: { type: "number", required: false },
        },
        async handler({ query, limit }: { query: string; limit?: number }) {
          return handleSwaggerSearch(openapi, query, limit);
        },
      },
    },
  };
}
