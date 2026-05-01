import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Plugin 의 단일 config 로더 + 검증.
 *
 * 두 위치를 병합한다 (project 가 leaf 단위로 user 를 덮어쓴다):
 *   1. user:    ~/.config/opencode/agent-toolkit/agent-toolkit.json
 *   2. project: <projectRoot>/.opencode/agent-toolkit.json
 *
 * 스키마는 repo 루트의 `agent-toolkit.schema.json` 에 동일 모양으로 박혀 있다 — IDE 자동완성용.
 * 런타임은 외부 JSON Schema 라이브러리에 의존하지 않고 직접 검증한다 (의존성 0 유지).
 */

/** spec 등록 단위. host → env → spec → URL 평면 트리. */
export interface OpenapiRegistry {
  [host: string]: {
    [env: string]: {
      [spec: string]: string;
    };
  };
}

export interface ToolkitConfig {
  $schema?: string;
  openapi?: {
    registry?: OpenapiRegistry;
  };
}

export interface LoadConfigOptions {
  /** user config 경로 override. 기본 `USER_CONFIG_PATH`. */
  userPath?: string;
  /** project root. 기본 `process.cwd()`. */
  projectRoot?: string;
}

/** user-level config 기본 경로. `AGENT_TOOLKIT_CONFIG` 로 오버라이드. */
export const USER_CONFIG_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "agent-toolkit",
  "agent-toolkit.json",
);

/** project-level config 의 상대 경로. */
export const PROJECT_CONFIG_RELATIVE = ".opencode/agent-toolkit.json";

/**
 * host / env / spec 식별자 본문 (anchor 없음).
 * 다른 모듈 (`openapi-registry.ts`) 이 핸들 / 스코프 정규식을 합성할 때 재사용한다 —
 * 이 한 군데만 바꾸면 schema / registry 둘 다 같이 따라간다.
 */
export const ID_BODY = "[a-zA-Z0-9_-]+";

/** host / env / spec 식별자 정규식 (앵커 포함). 콜론은 handle separator 로 예약. */
export const ID_PATTERN = new RegExp(`^${ID_BODY}$`);

/** 레지스트리 leaf URL 에 허용되는 스킴. spec 다운로드 단이 받는 종류와 동일. */
const URL_SCHEMES = new Set(["http:", "https:", "file:"]);

/**
 * 파싱된 JSON 값이 ToolkitConfig 인지 검증한다. 어긋나면 throw — 메시지에 source(path) 포함.
 * 부분 적합도 OK (모든 필드 optional). registry 가 있으면 깊이 끝까지 식별자 / URL 검증.
 */
export function validateConfig(input: unknown, source: string): ToolkitConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${source}: config must be a JSON object`);
  }
  const config = input as Record<string, unknown>;
  // openapi 만 검증한다 — 다른 top-level key 는 미래 확장 여지로 둔다.
  if (config.openapi !== undefined) {
    if (
      config.openapi === null ||
      typeof config.openapi !== "object" ||
      Array.isArray(config.openapi)
    ) {
      throw new Error(`${source}: openapi must be an object`);
    }
    const oapi = config.openapi as Record<string, unknown>;
    if (oapi.registry !== undefined) {
      validateRegistry(oapi.registry, source);
    }
  }
  return config as ToolkitConfig;
}

function validateRegistry(reg: unknown, source: string): asserts reg is OpenapiRegistry {
  if (reg === null || typeof reg !== "object" || Array.isArray(reg)) {
    throw new Error(`${source}: openapi.registry must be an object`);
  }
  for (const [host, envs] of Object.entries(reg as Record<string, unknown>)) {
    if (!ID_PATTERN.test(host)) {
      throw new Error(
        `${source}: host name "${host}" must match ${ID_PATTERN} (alphanumeric, "_" or "-" only — colons are reserved for handle separators)`,
      );
    }
    if (envs === null || typeof envs !== "object" || Array.isArray(envs)) {
      throw new Error(
        `${source}: openapi.registry["${host}"] must be an object of environments`,
      );
    }
    for (const [env, specs] of Object.entries(envs as Record<string, unknown>)) {
      if (!ID_PATTERN.test(env)) {
        throw new Error(
          `${source}: env name "${host}:${env}" must match ${ID_PATTERN}`,
        );
      }
      if (specs === null || typeof specs !== "object" || Array.isArray(specs)) {
        throw new Error(
          `${source}: openapi.registry["${host}"]["${env}"] must be an object of specs`,
        );
      }
      for (const [spec, url] of Object.entries(specs as Record<string, unknown>)) {
        if (!ID_PATTERN.test(spec)) {
          throw new Error(
            `${source}: spec name "${host}:${env}:${spec}" must match ${ID_PATTERN}`,
          );
        }
        if (typeof url !== "string" || url.trim().length === 0) {
          throw new Error(
            `${source}: openapi.registry["${host}"]["${env}"]["${spec}"] must be a non-empty URL string`,
          );
        }
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(
            `${source}: openapi.registry["${host}"]["${env}"]["${spec}"] is not a valid URL — got "${url}"`,
          );
        }
        if (!URL_SCHEMES.has(parsed.protocol)) {
          throw new Error(
            `${source}: openapi.registry["${host}"]["${env}"]["${spec}"] uses unsupported scheme "${parsed.protocol}" — only http / https / file are accepted`,
          );
        }
      }
    }
  }
}

async function loadOne(path: string): Promise<ToolkitConfig | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${path} as JSON: ${(err as Error).message}`,
    );
  }
  return validateConfig(parsed, path);
}

/**
 * user → project 순서로 깊이 병합. 같은 leaf (host:env:spec) 는 project 가 이긴다.
 * 새 host / env / spec 은 project 쪽에서 추가 가능.
 */
export function mergeConfigs(
  user: ToolkitConfig,
  project: ToolkitConfig,
): ToolkitConfig {
  // structuredClone 도 가능하지만 Bun runtime 호환성을 보수적으로 — JSON round-trip 으로 deep clone.
  const out = JSON.parse(JSON.stringify(user)) as ToolkitConfig;
  if (project.openapi?.registry) {
    out.openapi ??= {};
    out.openapi.registry ??= {};
    for (const [host, envs] of Object.entries(project.openapi.registry)) {
      out.openapi.registry[host] ??= {};
      for (const [env, specs] of Object.entries(envs)) {
        out.openapi.registry[host]![env] ??= {};
        for (const [spec, url] of Object.entries(specs)) {
          out.openapi.registry[host]![env]![spec] = url;
        }
      }
    }
  }
  return out;
}

/**
 * user + project config 를 읽어 merge 된 결과를 반환.
 * 두 파일 모두 없으면 빈 객체를 반환한다 (config 가 optional 이므로).
 *
 * `AGENT_TOOLKIT_CONFIG` 환경변수가 있으면 user 경로를 그 값으로 덮어쓴다.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<ToolkitConfig> {
  const userPath =
    options.userPath ?? process.env.AGENT_TOOLKIT_CONFIG ?? USER_CONFIG_PATH;
  const projectRoot = options.projectRoot ?? process.cwd();
  const projectPath = resolve(projectRoot, PROJECT_CONFIG_RELATIVE);
  const user = (await loadOne(userPath)) ?? {};
  const project = (await loadOne(projectPath)) ?? {};
  return mergeConfigs(user, project);
}
