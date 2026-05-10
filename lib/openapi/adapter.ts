import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type OpenapiRegistry,
  type OpenapiRegistryLeaf,
  getRegistryUrl,
  getRegistryBaseUrl,
  getRegistryFormat,
} from "../toolkit-config";
import type {
  EnvironmentConfig,
  OpenApiMcpConfig,
  SpecConfig,
} from "./schema";
import {
  createDiskCache,
  createNoopDiskCache,
  type DiskCache,
} from "./cache";
import { createFetcher } from "./fetcher";
import { createSpecRegistry, type SpecRegistry } from "./registry";

/**
 * agent-toolkit 의 `openapi.registry` 트리를 SpecRegistry 가 받는 `OpenApiMcpConfig`
 * 형태로 변환한다.
 *
 * 평탄화 규칙:
 *   - specName       = `<host>__<env>__<spec>` (콜론은 SpecRegistry 의 cacheKey 와
 *                      충돌하므로 더블 언더스코어로 escape)
 *   - environment    = `default` 한 개 — registry leaf 가 host:env:spec 단위라 이미
 *                      env 가 분리돼 있다. baseUrl 은 leaf 의 `baseUrl` 또는 빈 문자열.
 *   - source         = `{ type: 'url', url, format? }`
 *
 * leaf 가 단순 string 인 경우 baseUrl 은 빈 문자열 — `openapi_endpoint` 의 fullUrl
 * 합성 시 path 자체로만 떨어진다.
 *
 * `openapi-mcp.json` (specs.environments.baseUrl) 형태와는 별도 — 그쪽은
 * `lib/openapi/config-loader.ts` 가 직접 OpenApiMcpConfig 로 받는다.
 */

/** flat handle (`host__env__spec`) 과 원래 host/env/spec 을 양방향 변환. */
export const HANDLE_SEPARATOR = "__";

export function flattenHandle(host: string, env: string, spec: string): string {
  return `${host}${HANDLE_SEPARATOR}${env}${HANDLE_SEPARATOR}${spec}`;
}

export interface ParsedFlatHandle {
  host: string;
  env: string;
  spec: string;
}

export function parseFlatHandle(flat: string): ParsedFlatHandle | null {
  const parts = flat.split(HANDLE_SEPARATOR);
  if (parts.length !== 3) return null;
  const [host, env, spec] = parts as [string, string, string];
  if (!host || !env || !spec) return null;
  return { host, env, spec };
}

export const DEFAULT_ENVIRONMENT = "default";

/**
 * registry 트리 → OpenApiMcpConfig.specs 변환. registry 가 비어 있거나 undefined 면
 * specs 가 빈 객체 — caller (SpecRegistry) 가 이 빈 config 를 거부하지 않도록
 * 호출 측에서 leaf 0 개 케이스를 분기한다.
 */
export function registryToOpenApiMcpConfig(
  registry: OpenapiRegistry | undefined,
): OpenApiMcpConfig {
  const specs: Record<string, SpecConfig> = {};
  if (!registry) {
    return { specs };
  }
  for (const [host, envs] of Object.entries(registry)) {
    for (const [env, leafSpecs] of Object.entries(envs)) {
      for (const [spec, leaf] of Object.entries(leafSpecs)) {
        const url = getRegistryUrl(leaf);
        const baseUrl = getRegistryBaseUrl(leaf);
        const format = getRegistryFormat(leaf);
        const name = flattenHandle(host, env, spec);
        const environment: EnvironmentConfig = {
          baseUrl: baseUrl ?? "",
        };
        const source = format
          ? ({ type: "url" as const, url, format })
          : ({ type: "url" as const, url });
        specs[name] = {
          source,
          environments: { [DEFAULT_ENVIRONMENT]: environment },
        };
      }
    }
  }
  return { specs };
}

/**
 * 임시 (ad-hoc) URL 입력을 OpenApiMcpConfig.specs 한 entry 로 만들어 끼워 넣는다.
 * `openapi_get(<URL>)` 처럼 registry 외 URL 을 받을 때 SpecRegistry 가 그래도
 * `loadSpec(name)` 으로 다룰 수 있도록 한다.
 *
 * specName 은 URL 의 sha1 앞 16자에 `url__` 접두 — flat handle 과 충돌하지 않게.
 */
export function ephemeralSpecName(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return `url__${hash}`;
}

export function buildEphemeralSpec(url: string): {
  name: string;
  spec: SpecConfig;
} {
  const name = ephemeralSpecName(url);
  const spec: SpecConfig = {
    source: { type: "url", url },
    environments: {
      [DEFAULT_ENVIRONMENT]: { baseUrl: "" },
    },
  };
  return { name, spec };
}

/**
 * SpecRegistry 위에 ad-hoc URL 을 즉석에서 등록하고 lookup 하는 헬퍼. registry 가
 * 미리 만들어진 후에 들어온 URL 입력을 다루기 위함 — `openapi_get(URL)` 호출 시
 * 임시 spec entry 를 추가하고 그 이름으로 loadSpec 한다.
 *
 * SpecRegistry 인터페이스 자체는 mutation 메서드가 없으므로, 어댑터는 위 두 영역
 * (registry-from-config + ad-hoc URL) 을 하나의 OpenApiMcpConfig 로 합쳐 새
 * SpecRegistry 를 만든다. caller 가 두 Registry 를 동시에 들고 다닐지, 한 번에
 * 합칠지는 호출 측 결정.
 */
export interface CombinedConfigOptions {
  /** agent-toolkit.json 의 openapi.registry 트리. */
  registry?: OpenapiRegistry;
  /** registry 외 추가로 받을 ad-hoc URL 목록 (중복은 deduplicate). */
  ephemeralUrls?: string[];
}

export function buildCombinedConfig(
  options: CombinedConfigOptions,
): OpenApiMcpConfig {
  const base = registryToOpenApiMcpConfig(options.registry);
  if (options.ephemeralUrls) {
    const seen = new Set<string>();
    for (const url of options.ephemeralUrls) {
      if (seen.has(url)) continue;
      seen.add(url);
      const { name, spec } = buildEphemeralSpec(url);
      base.specs[name] = spec;
    }
  }
  return base;
}

/**
 * agent-toolkit MCP 진입점이 사용하는 SpecRegistry factory.
 *
 * `AGENT_TOOLKIT_OPENAPI_CACHE_DIR` / `AGENT_TOOLKIT_OPENAPI_CACHE_TTL` 환경변수를
 * 인지해 디스크 캐시 dir 와 TTL 기본값을 잡는다 (구 `lib/openapi-context.ts` 와
 * 호환). registry leaf 가 0 개여도 SpecRegistry 는 정상 생성 — caller 가 ad-hoc
 * URL 을 넘겨 동적으로 spec 을 등록할 수 있어야 한다.
 */
export interface CreateAgentToolkitRegistryOptions {
  registry?: OpenapiRegistry;
  ephemeralUrls?: string[];
  /** 디스크 캐시 강제 비활성화 (테스트). */
  diskCacheDisabled?: boolean;
}

export function createAgentToolkitRegistry(
  options: CreateAgentToolkitRegistryOptions,
): SpecRegistry {
  const config = buildCombinedConfig({
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.ephemeralUrls !== undefined
      ? { ephemeralUrls: options.ephemeralUrls }
      : {}),
  });
  // SpecRegistry 의 zod 스키마는 specs 가 1개 이상이어야 통과하지만, 우린 zod 검증을
  // 거치지 않고 직접 타입 캐스팅한 config 를 넣는다 — registry 비었을 때도 동작 가능.
  const fetcher = createFetcher();
  const diskCache: DiskCache = options.diskCacheDisabled
    ? createNoopDiskCache()
    : createDiskCache(resolveOpenapiCacheDir());
  return createSpecRegistry(config, fetcher, { diskCache });
}

function resolveOpenapiCacheDir(): string {
  const override = process.env.AGENT_TOOLKIT_OPENAPI_CACHE_DIR;
  if (override && override.trim().length > 0) return override;
  // 구 `lib/openapi-context.ts` 의 default 와 동일한 위치로 통일.
  // (.config/opencode/agent-toolkit/openapi-specs)
  return join(
    homedir(),
    ".config",
    "opencode",
    "agent-toolkit",
    "openapi-specs",
  );
}

/** registry leaf 만 받아 한 줄 평탄 row 로 만든다 — `handleSwaggerEnvs` 의 출력 형태. */
export interface FlatRegistryRow {
  host: string;
  env: string;
  spec: string;
  url: string;
  baseUrl?: string;
  format?: "openapi3" | "swagger2" | "auto";
  /** flatten 된 SpecRegistry 등록 이름 (`host__env__spec`). 디버깅용. */
  registryName: string;
}

export function flattenRegistry(
  registry: OpenapiRegistry | undefined,
): FlatRegistryRow[] {
  const out: FlatRegistryRow[] = [];
  if (!registry) return out;
  for (const [host, envs] of Object.entries(registry)) {
    for (const [env, leafSpecs] of Object.entries(envs)) {
      for (const [spec, leaf] of Object.entries(leafSpecs)) {
        const url = getRegistryUrl(leaf);
        const baseUrl = getRegistryBaseUrl(leaf);
        const format = getRegistryFormat(leaf);
        const row: FlatRegistryRow = {
          host,
          env,
          spec,
          url,
          registryName: flattenHandle(host, env, spec),
        };
        if (baseUrl !== undefined) row.baseUrl = baseUrl;
        if (format !== undefined) row.format = format;
        out.push(row);
      }
    }
  }
  return out;
}

/** ParsedFlatHandle 의 leaf 를 다시 꺼낸다 — registry 가 변형됐다면 undefined. */
export function lookupRegistryLeaf(
  registry: OpenapiRegistry | undefined,
  handle: ParsedFlatHandle,
): OpenapiRegistryLeaf | undefined {
  return registry?.[handle.host]?.[handle.env]?.[handle.spec];
}
