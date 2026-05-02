import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * OpenAPI / Swagger spec 캐시 + endpoint 검색을 한 파일에 모은다.
 *
 * 디스크 레이아웃 (한 spec 당 두 파일):
 *   <baseDir>/<key>.json        메타데이터 (OpenapiCacheEntry)
 *   <baseDir>/<key>.spec.json   다운로드한 OpenAPI document 그대로 (parsed → re-stringified)
 *
 * baseDir 기본값은 `~/.config/opencode/agent-toolkit/openapi-specs` — Notion 캐시
 * (`agent-toolkit/notion-pages`) 와 같은 부모 아래에 두되 디렉터리는 분리.
 * 환경변수는 `AGENT_TOOLKIT_OPENAPI_CACHE_*` 로 Notion 쪽과 분리되어 있다.
 *
 * 키 정규화: spec URL 자체는 길이/문자가 다양하므로 sha256 의 앞 16자(hex) 를 디스크 키로
 * 쓰고, 원본 URL 은 entry 의 `specUrl` 에 보관한다. `resolveSpecKey` 는 spec URL 과 이미
 * 정규화된 16-hex 키 둘 다 받아 디스크 키만 통일하고 입력 종류는 `isKeyInput` 로 알려준다.
 */

/** 캐시 파일 디렉터리 기본값 — 사용자 단위. `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` 로 덮어쓴다. */
export const DEFAULT_OPENAPI_CACHE_DIR = join(
  homedir(),
  ".config",
  "opencode",
  "agent-toolkit",
  "openapi-specs",
);
/** 기본 TTL 24h — Notion 캐시와 동일. `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` 로 덮어쓴다. */
export const DEFAULT_OPENAPI_TTL_SECONDS = 60 * 60 * 24;

/**
 * OpenAPI document 의 우리가 실제로 읽는 부분만 정의한 최소 인터페이스.
 * 전체 스펙 타입을 들고 가지 않는다 — 검색 / 메타 추출에 필요한 필드만.
 */
export interface OpenapiSpec {
  /** OpenAPI 3.x 의 버전 필드. swagger 2.0 이면 비어 있음. */
  openapi?: string;
  /** swagger 2.0 의 버전 필드. OpenAPI 3.x 이면 비어 있음. */
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, OpenapiPathItem>;
  /** 그 외 필드는 그대로 보존. */
  [key: string]: unknown;
}

/**
 * 한 path 아래의 method → operation 매핑.
 * 표준 외 필드(`parameters`, `summary`, `description`, `$ref` 등) 는 unknown 으로 흘려 둔다.
 */
export interface OpenapiPathItem {
  get?: OpenapiOperation;
  put?: OpenapiOperation;
  post?: OpenapiOperation;
  delete?: OpenapiOperation;
  patch?: OpenapiOperation;
  head?: OpenapiOperation;
  options?: OpenapiOperation;
  trace?: OpenapiOperation;
  [key: string]: unknown;
}

export interface OpenapiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface OpenapiCacheEntry {
  /** 디스크 키 (sha256(specUrl) 앞 16자). */
  key: string;
  /** 사용자가 입력한 spec URL (또는 마지막으로 캐시한 URL). */
  specUrl: string;
  cachedAt: string;
  ttlSeconds: number;
  /** spec 본문의 sha256 앞 16자 — 같은 본문 재캐시 판정용. */
  specHash: string;
  title: string;
  version: string;
  /** OpenAPI 버전 문자열 (`3.0.x` 또는 `2.0`). */
  openapi: string;
  /** spec.paths 안의 (path × method) 합 — 빠른 sanity check. */
  endpointCount: number;
}

export interface OpenapiCacheStatus {
  key: string;
  exists: boolean;
  expired: boolean;
  cachedAt?: string;
  ttlSeconds?: number;
  ageSeconds?: number;
  title?: string;
  specUrl?: string;
  /** spec.paths 의 (path × method) 합. 캐시 hit 일 때만 채워진다. */
  endpointCount?: number;
}

export interface OpenapiSpecResult {
  entry: OpenapiCacheEntry;
  spec: OpenapiSpec;
  fromCache: boolean;
}

export interface OpenapiCacheOptions {
  baseDir?: string;
  defaultTtlSeconds?: number;
}

/** 검색 결과 한 행 — 어느 spec 의 어느 endpoint 인지 + 매칭에 쓰인 핵심 필드. */
export interface OpenapiEndpointMatch {
  /** 매칭된 spec 의 디스크 key. */
  specKey: string;
  /** 매칭된 spec 의 원본 URL. */
  specUrl: string;
  /** 매칭된 spec 의 info.title. */
  specTitle: string;
  /** HTTP method 대문자 (`GET` / `POST` / …). */
  method: string;
  /** spec.paths 의 path 그대로. */
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
}

/** 16자 hex (sha256 앞 16자 = 디스크 key 형식) 인지 검사. */
const KEY_PATTERN = /^[0-9a-f]{16}$/;

/**
 * spec URL / 디스크 key 양쪽을 받아 정규화된 key 와 입력 종류를 반환.
 *
 * - `isKeyInput=true`: 입력이 이미 16자 hex 키 (캐시 lookup 용 — URL 정보 없음).
 * - `isKeyInput=false`: 입력이 spec URL 또는 그에 준하는 문자열 — sha256 의 앞 16자가 key.
 *
 * URL 검증은 하지 않는다 (호출 측 fetch 단계에서 처리). write 처럼 URL 이 반드시
 * 필요한 경로에서는 `isKeyInput` 을 보고 거부해야 한다.
 */
export function resolveSpecKey(input: string): {
  key: string;
  isKeyInput: boolean;
} {
  if (!input || typeof input !== "string") {
    throw new Error("resolveSpecKey: input must be a non-empty string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("resolveSpecKey: input must be a non-empty string");
  }
  if (KEY_PATTERN.test(trimmed)) {
    return { key: trimmed, isKeyInput: true };
  }
  const key = createHash("sha256")
    .update(trimmed, "utf8")
    .digest("hex")
    .slice(0, 16);
  return { key, isKeyInput: false };
}

/** 짧은(앞 16자) sha256 — spec 본문 동일성 비교용. */
export function specHash(content: string): string {
  return createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * spec 의 path × method 합을 센다. malformed 입력은 0.
 * OpenAPI 표준 HTTP method 8 종을 카운트 (`get`/`put`/`post`/`delete`/`patch`/`head`/`options`/`trace`).
 */
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

export function countEndpoints(spec: OpenapiSpec): number {
  if (!spec.paths || typeof spec.paths !== "object") return 0;
  let total = 0;
  for (const item of Object.values(spec.paths)) {
    if (!item || typeof item !== "object") continue;
    for (const m of HTTP_METHODS) {
      if (item[m] && typeof item[m] === "object") total += 1;
    }
  }
  return total;
}

/**
 * 한 spec 안에서 endpoint 를 substring 검색 (case-insensitive).
 * 매칭 대상: path / method / operationId / summary / tags.
 *
 * 빈 query 는 모든 endpoint 를 limit 까지 반환 — "이 spec 에 뭐 있는지 일단 보여줘" 용도.
 *
 * 외부 spec 은 종종 부분적으로 깨져 있다 (`operationId` 가 숫자, `tags` 가 배열이 아닌 등).
 * `.toLowerCase()` 가 TypeError 로 검색 자체를 무너뜨리지 않도록 매 필드마다 typeof 가드.
 */
export function searchEndpoints(
  spec: OpenapiSpec,
  query: string,
  limit = 20,
): Array<{
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
}> {
  if (!spec.paths || typeof spec.paths !== "object") return [];
  const needle = (query ?? "").trim().toLowerCase();
  const out: Array<{
    method: string;
    path: string;
    operationId?: string;
    summary?: string;
    tags?: string[];
  }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== "object") continue;
    for (const m of HTTP_METHODS) {
      const op = (item as OpenapiPathItem)[m];
      if (!op || typeof op !== "object") continue;

      // 안전 추출 — 비-string 은 ""/[] 로 떨어뜨려 매칭 / 결과 모두에서 제외한다.
      const opId = typeof op.operationId === "string" ? op.operationId : "";
      const summary = typeof op.summary === "string" ? op.summary : "";
      const tagsArr = Array.isArray(op.tags)
        ? op.tags.filter((t): t is string => typeof t === "string")
        : [];

      // 빈 query 면 무조건 hit, 그 외에는 한 필드라도 substring 매칭되어야 한다.
      const hit =
        needle.length === 0 ||
        path.toLowerCase().includes(needle) ||
        m.includes(needle) ||
        opId.toLowerCase().includes(needle) ||
        summary.toLowerCase().includes(needle) ||
        tagsArr.some((t) => t.toLowerCase().includes(needle));
      if (!hit) continue;
      out.push({
        method: m.toUpperCase(),
        path,
        operationId: opId !== "" ? opId : undefined,
        summary: summary !== "" ? summary : undefined,
        tags: tagsArr.length > 0 ? tagsArr : undefined,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * raw 응답이 OpenAPI 3.x 또는 swagger 2.x 인지 검증.
 * 둘 다 아니면 throw — 호출 측이 캐시에 잘못된 페이로드를 박지 못하게 한다.
 */
export function assertOpenapiShape(
  payload: unknown,
): asserts payload is OpenapiSpec {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenAPI payload must be a JSON object");
  }
  const obj = payload as Record<string, unknown>;
  const hasOpenapi = typeof obj.openapi === "string" && obj.openapi.length > 0;
  const hasSwagger = typeof obj.swagger === "string" && obj.swagger.length > 0;
  if (!hasOpenapi && !hasSwagger) {
    throw new Error(
      "OpenAPI payload missing both `openapi` and `swagger` version fields — refusing to cache",
    );
  }
}

/**
 * 파일시스템 기반 OpenAPI spec 캐시.
 *
 * 외부에 노출되는 메서드는 read / write / status / invalidate / list 5가지.
 * `read` 와 `status` 는 `.json` 과 `.spec.json` 모두 존재해야 hit 으로 간주 — 한 쪽만
 * 남아있으면 손상 상태로 보고 cache miss 처리.
 */
export class OpenapiCache {
  private readonly dir: string;
  private readonly defaultTtl: number;

  constructor(options: OpenapiCacheOptions = {}) {
    this.dir = resolve(options.baseDir ?? DEFAULT_OPENAPI_CACHE_DIR);
    this.defaultTtl = options.defaultTtlSeconds ?? DEFAULT_OPENAPI_TTL_SECONDS;
  }

  getDir(): string {
    return this.dir;
  }

  /** hit 이면 entry+spec, miss/만료/손상이면 null. */
  async read(
    input: string,
  ): Promise<{ entry: OpenapiCacheEntry; spec: OpenapiSpec } | null> {
    const { key } = resolveSpecKey(input);
    const metaPath = join(this.dir, `${key}.json`);
    const specPath = join(this.dir, `${key}.spec.json`);
    if (!existsSync(metaPath) || !existsSync(specPath)) return null;
    let entry: OpenapiCacheEntry;
    let spec: OpenapiSpec;
    try {
      entry = JSON.parse(await readFile(metaPath, "utf8")) as OpenapiCacheEntry;
      spec = JSON.parse(await readFile(specPath, "utf8")) as OpenapiSpec;
    } catch {
      return null;
    }
    if (this.isExpired(entry)) return null;
    return { entry, spec };
  }

  /**
   * raw spec 을 검증 후 캐시에 기록. spec 본문은 안정적인 들여쓰기로 re-stringify
   * 하므로 같은 내용이면 specHash 가 동일하게 유지된다.
   *
   * `specUrl` 은 반드시 실제 URL (sha256 의 앞 16자 형식인 디스크 key 입력은 거부) —
   * 캐시 entry 의 `specUrl` 필드가 후속 fetch 의 source-of-truth 이기 때문이다.
   */
  async write(
    specUrl: string,
    spec: OpenapiSpec,
    ttlSeconds?: number,
  ): Promise<{ entry: OpenapiCacheEntry; spec: OpenapiSpec }> {
    assertOpenapiShape(spec);
    const { key, isKeyInput } = resolveSpecKey(specUrl);
    if (isKeyInput) {
      throw new Error(
        `OpenapiCache.write requires a spec URL, got a 16-hex cache key "${specUrl}" — pass the original URL instead`,
      );
    }
    const serialized = `${JSON.stringify(spec, null, 2)}\n`;
    const entry: OpenapiCacheEntry = {
      key,
      specUrl,
      cachedAt: new Date().toISOString(),
      ttlSeconds: ttlSeconds ?? this.defaultTtl,
      specHash: specHash(serialized),
      title:
        typeof spec.info?.title === "string" ? spec.info.title : "(untitled)",
      version: typeof spec.info?.version === "string" ? spec.info.version : "",
      openapi:
        typeof spec.openapi === "string"
          ? spec.openapi
          : typeof spec.swagger === "string"
            ? spec.swagger
            : "",
      endpointCount: countEndpoints(spec),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, `${key}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(this.dir, `${key}.spec.json`), serialized, "utf8");
    return { entry, spec };
  }

  /**
   * 캐시 메타 + 만료 여부.
   * `.json` 또는 `.spec.json` 한쪽이라도 없으면 exists=false 로 보고한다 — read 와 일관.
   */
  async status(input: string): Promise<OpenapiCacheStatus> {
    const { key } = resolveSpecKey(input);
    const metaPath = join(this.dir, `${key}.json`);
    const specPath = join(this.dir, `${key}.spec.json`);
    if (!existsSync(metaPath) || !existsSync(specPath)) {
      return { key, exists: false, expired: false };
    }
    try {
      const entry = JSON.parse(
        await readFile(metaPath, "utf8"),
      ) as OpenapiCacheEntry;
      const ageSeconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(entry.cachedAt).getTime()) / 1000),
      );
      return {
        key,
        exists: true,
        expired: this.isExpired(entry),
        cachedAt: entry.cachedAt,
        ttlSeconds: entry.ttlSeconds,
        ageSeconds,
        title: entry.title,
        specUrl: entry.specUrl,
        endpointCount: entry.endpointCount,
      };
    } catch {
      return { key, exists: false, expired: false };
    }
  }

  /** ttl 을 0 으로 갱신해 다음 read 에서 miss 처리. */
  async invalidate(input: string): Promise<boolean> {
    const status = await this.status(input);
    if (!status.exists) return false;
    const { key } = resolveSpecKey(input);
    const metaPath = join(this.dir, `${key}.json`);
    const entry = JSON.parse(
      await readFile(metaPath, "utf8"),
    ) as OpenapiCacheEntry;
    entry.ttlSeconds = 0;
    await writeFile(metaPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return true;
  }

  /**
   * 메타 파일이 (만료 / .spec.json 누락 여부와 무관하게) 존재하면 그 안의 `specUrl` 만 꺼내 반환.
   * fetchAndCacheSpec 이 16-hex key 입력으로부터 원본 URL 을 복구할 때 쓴다.
   * 메타 자체가 없거나 파싱이 깨진 경우 null.
   */
  async peekSpecUrl(input: string): Promise<string | null> {
    const { key } = resolveSpecKey(input);
    const metaPath = join(this.dir, `${key}.json`);
    if (!existsSync(metaPath)) return null;
    try {
      const entry = JSON.parse(
        await readFile(metaPath, "utf8"),
      ) as OpenapiCacheEntry;
      return typeof entry.specUrl === "string" && entry.specUrl.length > 0
        ? entry.specUrl
        : null;
    } catch {
      return null;
    }
  }

  /**
   * 캐시 디렉터리 안의 모든 entry 를 훑어 (entry, spec) 페어로 반환.
   * 손상되거나 만료된 항목은 건너뛴다 — search 단의 입력 필터.
   */
  async list(): Promise<
    Array<{ entry: OpenapiCacheEntry; spec: OpenapiSpec }>
  > {
    if (!existsSync(this.dir)) return [];
    const files = await readdir(this.dir);
    const out: Array<{ entry: OpenapiCacheEntry; spec: OpenapiSpec }> = [];
    for (const f of files) {
      // meta 파일만 골라낸 뒤, 짝이 되는 .spec.json 이 있는지 read 가 검증한다.
      if (!f.endsWith(".json") || f.endsWith(".spec.json")) continue;
      const key = f.slice(0, -".json".length);
      const r = await this.read(key);
      if (r) out.push(r);
    }
    return out;
  }

  private isExpired(entry: OpenapiCacheEntry): boolean {
    if (entry.ttlSeconds <= 0) return true;
    const cachedAtMs = new Date(entry.cachedAt).getTime();
    if (!Number.isFinite(cachedAtMs)) return true;
    return Date.now() >= cachedAtMs + entry.ttlSeconds * 1000;
  }
}

/** env 변수에서 baseDir / TTL 을 읽어 인스턴스 생성. */
export function createOpenapiCacheFromEnv(): OpenapiCache {
  const baseDir = process.env.AGENT_TOOLKIT_OPENAPI_CACHE_DIR;
  const ttlRaw = process.env.AGENT_TOOLKIT_OPENAPI_CACHE_TTL;
  const ttl = ttlRaw ? Number.parseInt(ttlRaw, 10) : undefined;
  return new OpenapiCache({
    baseDir,
    defaultTtlSeconds: Number.isFinite(ttl) && ttl! > 0 ? ttl : undefined,
  });
}
