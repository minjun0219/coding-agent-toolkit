import path from "node:path";
import {
  createNoopDiskCache,
  type DiskCache,
  type DiskCacheEntry,
} from "./cache";
import { getLogger } from "./logger";
import type { SpecFetcher } from "./fetcher";
import type { OpenAPIV3 } from "openapi-types";
import { indexSpec, type IndexedSpec } from "./indexer";
import { parseSpecText } from "./parser";
import {
  DEFAULT_CACHE_TTL_SECONDS,
  type EnvironmentConfig,
  type OpenApiMcpConfig,
  type SpecConfig,
  type SpecSource,
} from "./schema";

/**
 * 메모리 + 디스크 캐시를 끼워둔 OpenAPI spec 레지스트리. SpecRegistry 가 caller (tool
 * handler / MCP server) 에 노출되는 단일 진입점이다.
 *
 * 동작 요약:
 *   1. `loadSpec(name, env?)` — 메모리 hit → in-flight promise → 디스크 hit hydrate
 *      → 새로 fetch + parse + index 순으로 fallback. fetch 시 etag/lastModified 를
 *      엔트리에 함께 저장.
 *   2. TTL 지난 메모리 hit 은 즉시 stale 데이터 반환 + conditional GET 재검증을
 *      백그라운드로 stage. 304 면 fetchedAt 만 갱신, 200 이면 새 indexed spec 으로 교체.
 *   3. `refresh(name?)` — 캐시 (메모리 + 디스크) 비우고 무조건 다시 fetch.
 */

export interface SpecCacheStatus {
  cached: boolean;
  fetchedAt?: string;
  ttlSeconds: number;
}

export interface SpecSummary {
  name: string;
  description?: string;
  environments: string[];
  cacheStatus: SpecCacheStatus;
}

export interface ResolvedEnvironment {
  name: string;
  baseUrl: string;
  description?: string;
}

interface CachedSpec {
  indexed: IndexedSpec;
  fetchedAt: string;
  source: SpecSource;
  document: object;
  detectedFormat: "openapi3" | "swagger2";
  etag?: string;
  lastModified?: string;
  ttlSeconds: number;
}

export interface SpecRegistry {
  listSpecs(): SpecSummary[];
  listEnvironments(specName: string): ResolvedEnvironment[];
  loadSpec(specName: string, environment?: string): Promise<IndexedSpec>;
  getEnvironment(specName: string, environment: string): EnvironmentConfig;
  refresh(specName?: string): Promise<RefreshOutcome[]>;
  hasSpec(specName: string): boolean;
  /**
   * 런타임에 spec entry 를 추가한다. agent-toolkit 의 `openapi_get(URL)` 처럼
   * config 에 없는 ad-hoc URL 을 받았을 때 사용. 이미 같은 이름이 등록돼 있으면
   * 새 entry 로 통째로 교체한다 (이름 단위 idempotent).
   */
  registerSpec(name: string, spec: SpecConfig): void;
}

export interface RefreshOutcome {
  spec: string;
  success: boolean;
  fetchedAt?: string;
  error?: string;
}

export class UnknownSpecError extends Error {
  constructor(specName: string) {
    super(`unknown spec '${specName}'`);
    this.name = "UnknownSpecError";
  }
}

export class UnknownEnvironmentError extends Error {
  constructor(specName: string, environment: string) {
    super(`unknown environment '${environment}' for spec '${specName}'`);
    this.name = "UnknownEnvironmentError";
  }
}

export interface SpecRegistryOptions {
  diskCache?: DiskCache;
  /**
   * 상대 경로 `file` source 를 해석하기 위한 디렉토리. 일반적으로 config 파일이
   * 위치한 디렉토리. 미지정 시 process.cwd() 로 떨어진다.
   */
  configDir?: string;
}

export function createSpecRegistry(
  config: OpenApiMcpConfig,
  fetcher: SpecFetcher,
  options: SpecRegistryOptions = {},
): SpecRegistry {
  return new InMemorySpecRegistry(
    config,
    fetcher,
    options.diskCache ?? createNoopDiskCache(),
    options.configDir,
  );
}

class InMemorySpecRegistry implements SpecRegistry {
  private readonly cache = new Map<string, CachedSpec>();
  private readonly inFlight = new Map<string, Promise<IndexedSpec>>();
  private readonly backgroundRefreshes = new Set<string>();

  constructor(
    private readonly config: OpenApiMcpConfig,
    private readonly fetcher: SpecFetcher,
    private readonly diskCache: DiskCache,
    private readonly configDir?: string,
  ) {}

  hasSpec(specName: string): boolean {
    return Object.hasOwn(this.config.specs, specName);
  }

  registerSpec(name: string, spec: SpecConfig): void {
    this.config.specs[name] = spec;
    // 같은 이름 entry 의 기존 캐시는 새 spec 의 source 가 다를 수 있으니 정리.
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${name}::`)) {
        this.cache.delete(key);
        this.inFlight.delete(key);
        this.backgroundRefreshes.delete(key);
      }
    }
  }

  listSpecs(): SpecSummary[] {
    return Object.entries(this.config.specs).map(([name, spec]) => ({
      name,
      ...(spec.description !== undefined
        ? { description: spec.description }
        : {}),
      environments: Object.keys(spec.environments),
      cacheStatus: this.cacheStatus(name, spec),
    }));
  }

  listEnvironments(specName: string): ResolvedEnvironment[] {
    const spec = this.requireSpec(specName);
    return Object.entries(spec.environments).map(([name, env]) => ({
      name,
      baseUrl: env.baseUrl,
      ...(env.description !== undefined
        ? { description: env.description }
        : {}),
    }));
  }

  getEnvironment(specName: string, environment: string): EnvironmentConfig {
    const spec = this.requireSpec(specName);
    const env = spec.environments[environment];
    if (!env) throw new UnknownEnvironmentError(specName, environment);
    return env;
  }

  async loadSpec(specName: string, environment?: string): Promise<IndexedSpec> {
    const spec = this.requireSpec(specName);
    const source = this.resolveSource(specName, spec, environment);
    const ttlSeconds = spec.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    const key = this.cacheKey(specName, source);

    const memHit = this.cache.get(key);
    if (memHit) {
      if (this.isStale(memHit))
        this.scheduleBackgroundRefresh(specName, source, ttlSeconds);
      return memHit.indexed;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;

    const promise = this.hydrateOrFetch(specName, source, ttlSeconds).finally(
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, promise);
    return promise;
  }

  async refresh(specName?: string): Promise<RefreshOutcome[]> {
    const targets = specName ? [specName] : Object.keys(this.config.specs);
    // 각 spec 의 refresh 는 독립적이므로 모두 병렬로 처리한다. 한 spec 안의 여러
    // source (default + env override) 도 같이 병렬 — 한 spec 의 source 하나가
    // 실패해도 같은 spec 의 다른 source 까지 끌어내리지 않게 try/catch 는 spec
    // 단위로 둔다.
    const settled = await Promise.all(
      targets.map((name) => this.refreshOne(name)),
    );
    return settled;
  }

  private async refreshOne(name: string): Promise<RefreshOutcome> {
    try {
      const spec = this.requireSpec(name);
      const ttlSeconds = spec.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
      const sourcesByKey = new Map<string, SpecSource>();
      sourcesByKey.set(this.cacheKey(name, spec.source), spec.source);
      for (const env of Object.values(spec.environments)) {
        if (env.source) {
          sourcesByKey.set(this.cacheKey(name, env.source), env.source);
        }
      }
      // source 별로 캐시 정리 + 재다운로드를 병렬로 — 같은 spec 안에서도 여러
      // env override 가 있으면 모두 동시에 fetch.
      await Promise.all(
        Array.from(sourcesByKey.entries()).map(async ([key, source]) => {
          this.cache.delete(key);
          this.inFlight.delete(key);
          this.backgroundRefreshes.delete(key);
          await this.diskCache.delete(key);
          await this.fetchAndStore(name, source, ttlSeconds);
        }),
      );
      // fetchedAt 는 sourcesByKey 의 첫 entry 기준 — 보고 용도라 정확성보다 일관성 우선.
      const firstKey = sourcesByKey.keys().next().value;
      const fetchedAt =
        (firstKey ? this.cache.get(firstKey)?.fetchedAt : undefined) ??
        new Date().toISOString();
      return { spec: name, success: true, fetchedAt };
    } catch (err) {
      return {
        spec: name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async hydrateOrFetch(
    specName: string,
    source: SpecSource,
    ttlSeconds: number,
  ): Promise<IndexedSpec> {
    const key = this.cacheKey(specName, source);
    const disk = await this.diskCache.read(key);
    if (disk) {
      try {
        // 디스크 캐시는 이미 deref 된 OpenAPI 3.x document 를 보관하므로, 다시
        // SwaggerParser.dereference 를 돌리지 않고 곧장 indexSpec 으로 넘긴다 —
        // 큰 spec 일수록 deref 비용이 가장 무거우므로 hydrate 경로의 핵심 최적화.
        const document = disk.document as OpenAPIV3.Document;
        const indexed = indexSpec(specName, document);
        const cached: CachedSpec = {
          indexed,
          fetchedAt: disk.cachedAt,
          source,
          document,
          detectedFormat: disk.detectedFormat,
          ...(disk.etag !== undefined ? { etag: disk.etag } : {}),
          ...(disk.lastModified !== undefined
            ? { lastModified: disk.lastModified }
            : {}),
          ttlSeconds,
        };
        this.cache.set(key, cached);
        if (this.isStale(cached))
          this.scheduleBackgroundRefresh(specName, source, ttlSeconds);
        return indexed;
      } catch (err) {
        getLogger().warn(
          { err, spec: specName },
          "disk cache hydrate failed; falling back to fresh fetch",
        );
        await this.diskCache.delete(key);
      }
    }
    return this.fetchAndStore(specName, source, ttlSeconds);
  }

  private async fetchAndStore(
    specName: string,
    source: SpecSource,
    ttlSeconds: number,
  ): Promise<IndexedSpec> {
    const key = this.cacheKey(specName, source);
    const fetched = await this.fetcher.fetch(source);
    if (fetched.notModified) {
      throw new Error(
        `unexpected 304 response for spec '${specName}' on initial load`,
      );
    }
    const parsed = await parseSpecText(fetched.body, source.format);
    const indexed = indexSpec(specName, parsed.document);
    const cached: CachedSpec = {
      indexed,
      fetchedAt: fetched.fetchedAt,
      source,
      document: parsed.document,
      detectedFormat: parsed.detectedFormat,
      ...(fetched.etag !== undefined ? { etag: fetched.etag } : {}),
      ...(fetched.lastModified !== undefined
        ? { lastModified: fetched.lastModified }
        : {}),
      ttlSeconds,
    };
    this.cache.set(key, cached);
    await this.diskCache.write(key, this.toDiskEntry(cached));
    return indexed;
  }

  private scheduleBackgroundRefresh(
    specName: string,
    source: SpecSource,
    ttlSeconds: number,
  ): void {
    const key = this.cacheKey(specName, source);
    if (this.backgroundRefreshes.has(key)) return;
    this.backgroundRefreshes.add(key);
    void this.runBackgroundRefresh(specName, source, ttlSeconds, key).finally(
      () => {
        this.backgroundRefreshes.delete(key);
      },
    );
  }

  private async runBackgroundRefresh(
    specName: string,
    source: SpecSource,
    ttlSeconds: number,
    key: string,
  ): Promise<void> {
    const existing = this.cache.get(key);
    if (!existing) return;
    try {
      const conditional: { etag?: string; lastModified?: string } = {};
      if (existing.etag) conditional.etag = existing.etag;
      if (existing.lastModified)
        conditional.lastModified = existing.lastModified;
      const fetched = await this.fetcher.fetch(source, conditional);
      const current = this.cache.get(key);
      if (!current) return;
      if (fetched.notModified) {
        const refreshed: CachedSpec = {
          ...current,
          fetchedAt: fetched.fetchedAt,
          ttlSeconds,
        };
        this.cache.set(key, refreshed);
        await this.diskCache.write(key, this.toDiskEntry(refreshed));
        return;
      }
      const parsed = await parseSpecText(fetched.body, source.format);
      if (Date.parse(fetched.fetchedAt) < Date.parse(current.fetchedAt)) {
        return;
      }
      const indexed = indexSpec(specName, parsed.document);
      const refreshed: CachedSpec = {
        indexed,
        fetchedAt: fetched.fetchedAt,
        source,
        document: parsed.document,
        detectedFormat: parsed.detectedFormat,
        ...(fetched.etag !== undefined ? { etag: fetched.etag } : {}),
        ...(fetched.lastModified !== undefined
          ? { lastModified: fetched.lastModified }
          : {}),
        ttlSeconds,
      };
      this.cache.set(key, refreshed);
      await this.diskCache.write(key, this.toDiskEntry(refreshed));
    } catch (err) {
      getLogger().warn(
        { err, spec: specName },
        "background refresh failed; serving stale cache",
      );
    }
  }

  private toDiskEntry(cached: CachedSpec): DiskCacheEntry {
    return {
      schemaVersion: 1,
      cachedAt: cached.fetchedAt,
      ...(cached.etag !== undefined ? { etag: cached.etag } : {}),
      ...(cached.lastModified !== undefined
        ? { lastModified: cached.lastModified }
        : {}),
      source: cached.source,
      detectedFormat: cached.detectedFormat,
      document: cached.document,
    };
  }

  private isStale(cached: CachedSpec): boolean {
    const age = (Date.now() - Date.parse(cached.fetchedAt)) / 1000;
    return age >= cached.ttlSeconds;
  }

  private cacheStatus(specName: string, spec: SpecConfig): SpecCacheStatus {
    const ttlSeconds = spec.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    const defaultSource = this.resolveSource(specName, spec);
    const cached = this.cache.get(this.cacheKey(specName, defaultSource));
    if (cached) {
      return { cached: true, fetchedAt: cached.fetchedAt, ttlSeconds };
    }
    return { cached: false, ttlSeconds };
  }

  private resolveSource(
    specName: string,
    spec: SpecConfig,
    environment?: string,
  ): SpecSource {
    let source: SpecSource = spec.source;
    if (environment) {
      const env = spec.environments[environment];
      if (!env) throw new UnknownEnvironmentError(specName, environment);
      if (env.source) source = env.source;
    }
    return this.resolveFilePath(source);
  }

  private resolveFilePath(source: SpecSource): SpecSource {
    if (source.type !== "file" || path.isAbsolute(source.path)) return source;
    const baseDir = this.configDir ?? process.cwd();
    return { ...source, path: path.resolve(baseDir, source.path) };
  }

  private cacheKey(specName: string, source: SpecSource): string {
    const target = source.type === "url" ? source.url : source.path;
    const format = source.format ?? "auto";
    return `${specName}::${source.type}::${target}::${format}`;
  }

  private requireSpec(specName: string): SpecConfig {
    const spec = this.config.specs[specName];
    if (!spec) throw new UnknownSpecError(specName);
    return spec;
  }
}
