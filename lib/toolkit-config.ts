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

/**
 * SPEC-합의 lifecycle (`spec-pact` skill, conducted by the `grace` sub-agent) 설정.
 * 모든 키 optional — caller (현재는 grace) 가 default 를 적용한다.
 */
export interface SpecConfig {
  /** slug-mode SPEC 디렉터리. default `.agent/specs`. */
  dir?: string;
  /** `**\/SPEC.md` directory-mode 디스커버리 활성화. default `true`. */
  scanDirectorySpec?: boolean;
  /** `<dir>/<indexFile>` LLM-wiki entry point 파일명. default `INDEX.md`. */
  indexFile?: string;
}

/**
 * `spec-to-issues` skill (Phase 2) 설정. 모두 optional — 누락 시 caller / env 가
 * 기본값을 적용한다. token 같은 비밀값은 여기에 저장하지 않는다 (env 만).
 */
export interface GithubConfig {
  /** "owner/repo" 형식. 누락 시 동기화 도구는 호출 시 throw. */
  repo?: string;
  /** GitHub REST API base URL. default `https://api.github.com` (GHE 시 override). */
  apiBaseUrl?: string;
  /**
   * 새로 생성되는 epic / sub-issue 에 붙일 라벨. default `["spec-pact"]`.
   * 첫 라벨이 dedupe 검색의 `labels=` 필터로도 쓰이므로 한 개 이상 있어야 한다.
   */
  defaultLabels?: string[];
}

export interface ToolkitConfig {
  $schema?: string;
  openapi?: {
    registry?: OpenapiRegistry;
  };
  spec?: SpecConfig;
  github?: GithubConfig;
}

export interface LoadConfigOptions {
  /** user config 경로 override. 기본 `USER_CONFIG_PATH`. */
  userPath?: string;
  /** project root. 기본 `process.cwd()`. */
  projectRoot?: string;
}

export interface LoadConfigError {
  /** 실패한 파일의 절대 경로. */
  source: string;
  /** 파싱 또는 검증 실패 메시지 (Error.message 또는 stringified). */
  message: string;
}

export interface LoadConfigResult {
  /** user + project 를 leaf 단위로 merge 한 결과. 둘 다 실패 / 둘 다 부재면 빈 객체. */
  config: ToolkitConfig;
  /** 파싱 / 검증에 실패한 파일별 에러. caller 가 logging / surfacing 결정. */
  errors: LoadConfigError[];
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
  // 알려진 top-level key 만 strict 검증 — 모르는 key 는 forward compatibility 로 통과.
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
  if (config.spec !== undefined) {
    validateSpec(config.spec, source);
  }
  if (config.github !== undefined) {
    validateGithub(config.github, source);
  }
  return config as ToolkitConfig;
}

/**
 * `spec` 객체 모양 검증. 모든 필드 optional + 빈 문자열 / 잘못된 타입은 reject.
 * 미지원 key (오타 포함) 도 reject — schema 의 `additionalProperties: false` 와 lockstep.
 * grace sub-agent 가 SPEC-합의 lifecycle 의 storage 위치를 잡을 때 사용.
 */
const ALLOWED_SPEC_KEYS = new Set(["dir", "scanDirectorySpec", "indexFile"]);

function validateSpec(spec: unknown, source: string): asserts spec is SpecConfig {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${source}: spec must be an object`);
  }
  const s = spec as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!ALLOWED_SPEC_KEYS.has(key)) {
      throw new Error(
        `${source}: spec has unsupported key "${key}" — allowed: ${[...ALLOWED_SPEC_KEYS].join(", ")}`,
      );
    }
  }
  if (s.dir !== undefined) {
    if (typeof s.dir !== "string" || s.dir.trim().length === 0) {
      throw new Error(`${source}: spec.dir must be a non-empty string`);
    }
  }
  if (s.scanDirectorySpec !== undefined) {
    if (typeof s.scanDirectorySpec !== "boolean") {
      throw new Error(`${source}: spec.scanDirectorySpec must be a boolean`);
    }
  }
  if (s.indexFile !== undefined) {
    if (typeof s.indexFile !== "string" || s.indexFile.trim().length === 0) {
      throw new Error(`${source}: spec.indexFile must be a non-empty string`);
    }
  }
}

/**
 * `github` 객체 모양 검증. `spec-to-issues` skill 이 epic + sub-issue 를 만들 때 쓰는
 * repo / API URL / 라벨 default 만 받는다. 비밀값(token) 은 여기 저장 X — env 에서만.
 * 미지원 key 는 reject — schema 의 `additionalProperties: false` 와 lockstep.
 */
const ALLOWED_GITHUB_KEYS = new Set(["repo", "apiBaseUrl", "defaultLabels"]);
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function validateGithub(
  github: unknown,
  source: string,
): asserts github is GithubConfig {
  if (github === null || typeof github !== "object" || Array.isArray(github)) {
    throw new Error(`${source}: github must be an object`);
  }
  const g = github as Record<string, unknown>;
  for (const key of Object.keys(g)) {
    if (!ALLOWED_GITHUB_KEYS.has(key)) {
      throw new Error(
        `${source}: github has unsupported key "${key}" — allowed: ${[...ALLOWED_GITHUB_KEYS].join(", ")}`,
      );
    }
  }
  if (g.repo !== undefined) {
    if (typeof g.repo !== "string" || !REPO_PATTERN.test(g.repo)) {
      throw new Error(
        `${source}: github.repo must match "owner/repo" (got ${JSON.stringify(g.repo)})`,
      );
    }
  }
  if (g.apiBaseUrl !== undefined) {
    if (typeof g.apiBaseUrl !== "string" || g.apiBaseUrl.trim().length === 0) {
      throw new Error(`${source}: github.apiBaseUrl must be a non-empty string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(g.apiBaseUrl);
    } catch {
      throw new Error(
        `${source}: github.apiBaseUrl is not a valid URL — got "${g.apiBaseUrl}"`,
      );
    }
    if (!URL_SCHEMES.has(parsed.protocol)) {
      throw new Error(
        `${source}: github.apiBaseUrl uses unsupported scheme "${parsed.protocol}" — only http / https / file are accepted`,
      );
    }
  }
  if (g.defaultLabels !== undefined) {
    if (!Array.isArray(g.defaultLabels) || g.defaultLabels.length === 0) {
      throw new Error(
        `${source}: github.defaultLabels must be a non-empty array of strings (first label is also the dedupe filter)`,
      );
    }
    for (const v of g.defaultLabels) {
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error(
          `${source}: github.defaultLabels must contain only non-empty strings — got ${JSON.stringify(v)}`,
        );
      }
    }
  }
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
 * user → project 순서로 깊이 병합. 같은 leaf (host:env:spec, spec 의 각 key) 는 project 가 이긴다.
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
  if (project.spec) {
    out.spec ??= {};
    for (const [key, value] of Object.entries(project.spec) as [
      keyof SpecConfig,
      SpecConfig[keyof SpecConfig],
    ][]) {
      if (value !== undefined) {
        // 각 key 는 leaf — project 가 user 를 통째로 덮어쓴다.
        (out.spec as Record<string, unknown>)[key] = value;
      }
    }
  }
  if (project.github) {
    out.github ??= {};
    for (const [key, value] of Object.entries(project.github) as [
      keyof GithubConfig,
      GithubConfig[keyof GithubConfig],
    ][]) {
      if (value !== undefined) {
        (out.github as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/**
 * user + project config 를 읽어 merge 된 결과 + 파일별 에러를 반환.
 *
 * 한 쪽 파일이 손상되어도 다른 쪽은 그대로 살린다 — 즉 잘못된 user 파일이 정상 project
 * registry 를 무력화하지 않는다 (반대도 마찬가지). caller 는 `errors` 를 보고 logging /
 * surfacing 을 결정한다 (plugin 은 console.error 로 한 줄씩 흘린다).
 *
 * 두 파일 모두 없으면 `{ config: {}, errors: [] }`. `AGENT_TOOLKIT_CONFIG` 환경변수가
 * 있으면 user 경로를 그 값으로 덮어쓴다.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const userPath =
    options.userPath ?? process.env.AGENT_TOOLKIT_CONFIG ?? USER_CONFIG_PATH;
  const projectRoot = options.projectRoot ?? process.cwd();
  const projectPath = resolve(projectRoot, PROJECT_CONFIG_RELATIVE);
  const errors: LoadConfigError[] = [];

  let user: ToolkitConfig = {};
  try {
    user = (await loadOne(userPath)) ?? {};
  } catch (err) {
    errors.push({
      source: userPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  let project: ToolkitConfig = {};
  try {
    project = (await loadOne(projectPath)) ?? {};
  } catch (err) {
    errors.push({
      source: projectPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { config: mergeConfigs(user, project), errors };
}
