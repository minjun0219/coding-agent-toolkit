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
 * 한 MySQL 핸들 (`host:env:db`) 의 connection profile.
 *
 * 비밀번호는 *config 파일에 절대 두지 않는다* — `passwordEnv` (환경변수 이름) 또는
 * `dsnEnv` (`mysql://user:pass@host:port/db` 한 줄을 담은 환경변수 이름) 중 정확히 하나만
 * 허용한다. 두 모드는 상호배타이며 `validateMysqlProfile` 가 다음을 강제한다:
 *
 *   - `passwordEnv` 모드: `host` / `user` / `database` 는 필수, `port` 는 1..65535 정수 (선택).
 *   - `dsnEnv`     모드: 분해 필드 (`host` / `port` / `user` / `database`) 는 *선언 금지*
 *     (혼재는 reject) — DSN 한 줄에서 모두 파싱한다.
 *
 * 즉 분해 필드와 `dsnEnv` 가 함께 등장하면 "무시"가 아니라 *명시적 reject* 다 — 설정
 * 작성자가 잘못된 기대를 갖지 않도록 검증 단계에서 끊는다.
 */
export interface MysqlConnectionProfile {
  /** TCP host. `passwordEnv` 모드에서 필수. `dsnEnv` 모드에서는 선언 금지. */
  host?: string;
  /** TCP port (1..65535). 선택. `dsnEnv` 모드에서는 선언 금지. */
  port?: number;
  /** 접속 user. `passwordEnv` 모드에서 필수. `dsnEnv` 모드에서는 선언 금지. */
  user?: string;
  /** 디폴트 database. `passwordEnv` 모드에서 필수. `dsnEnv` 모드에서는 선언 금지. */
  database?: string;
  /** 비밀번호를 담은 환경변수 이름. `dsnEnv` 와 상호배타. */
  passwordEnv?: string;
  /** `mysql://...` DSN 한 줄을 담은 환경변수 이름. `passwordEnv` 와 분해 필드 모두와 상호배타. */
  dsnEnv?: string;
}

/** mysql.connections 트리. host → env → db → connection profile. */
export interface MysqlConnections {
  [host: string]: {
    [env: string]: {
      [db: string]: MysqlConnectionProfile;
    };
  };
}

/**
 * 한 GitHub repository 의 메타 (`pr-review-watch` 가 사용). 토킷은 GitHub API 를 직접
 * 호출하지 않으므로 토큰 / 비밀은 들고 있지 않는다 — 외부 GitHub MCP 서버가 OAuth / PAT
 * 자체 처리.
 *
 * 모든 필드 optional — 등록만으로도 의미가 있다 (allow-list 역할).
 */
export interface GithubRepositoryProfile {
  /** 짧은 별명. MVP 에서는 surface 만 — `<alias>#<num>` 핸들 파싱은 미지원. */
  alias?: string;
  /** mindy 가 답글 작성 시 고려할 레이블 권고 list (strict 가드는 외부 MCP 책임). */
  labels?: string[];
  /** repository default branch 표기 (`main` / `master`). 검증은 안 함. */
  defaultBranch?: string;
  /** 머지 권고 모드. 실제 머지는 외부 MCP 가 처리. */
  mergeMode?: "merge" | "squash" | "rebase";
}

/** `github.repositories` 트리. `owner/repo` → profile. */
export interface GithubRepositories {
  [ownerRepo: string]: GithubRepositoryProfile;
}

/**
 * `github` 객체. 두 surface 가 같이 산다:
 *
 * - `repositories` — PR review watch (`mindy` + `pr-review-watch`) 가 참조하는 repo
 *   메타 (`owner/repo` 별 alias / labels / defaultBranch / mergeMode). PR API 호출은
 *   외부 GitHub MCP 책임이므로 여기 토큰은 두지 않는다.
 * - `repo` / `defaultLabels` — `spec-to-issues` skill (Phase 2) 의 `gh` CLI 호출 기본값.
 *   인증 / 토큰은 모두 `gh` CLI 가 들고 있으므로 여기에 토큰 키는 없다 — 토큰은
 *   `gh auth login` 으로만. `repo` 는 선택이며 미지정 시 `gh repo view` 로 자동 감지한다
 *   (precedence: tool param > 이 config > `gh repo view`). `defaultLabels[0]` 는 dedupe
 *   검색 (`gh issue list --label`) 의 1차 필터로 쓰이므로 stable 해야 한다.
 */
export interface GithubConfig {
  /** PR review watch 가 참조하는 repo 메타. */
  repositories?: GithubRepositories;
  /** spec-to-issues 동기화의 default repo. "owner/name". 미지정 시 `gh repo view` 자동 감지. */
  repo?: string;
  /** spec-to-issues 가 새 issue 에 부착할 라벨. default `["spec-pact"]`. `[0]` 이 dedupe 필터. */
  defaultLabels?: string[];
}

export interface ToolkitConfig {
  $schema?: string;
  openapi?: {
    registry?: OpenapiRegistry;
  };
  spec?: SpecConfig;
  github?: GithubConfig;
  mysql?: {
    connections?: MysqlConnections;
  };
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

/**
 * GitHub `owner/repo` 키 패턴.
 * 슬래시 정확히 1 개 + 양쪽이 `[a-zA-Z0-9_.-]` 본문. 다른 핸들의 콜론 separator 와
 * 의도적으로 분리된다 (`ID_BODY` 가 슬래시를 허용하지 않으므로 별도 정규식 신설).
 */
const GITHUB_REPO_BODY = "[a-zA-Z0-9_.-]+";
const GITHUB_REPO_PATTERN = new RegExp(
  `^${GITHUB_REPO_BODY}\\/${GITHUB_REPO_BODY}$`,
);

const ALLOWED_GITHUB_REPO_KEYS = new Set([
  "alias",
  "labels",
  "defaultBranch",
  "mergeMode",
]);

/**
 * GitHub merge mode enum. Schema (`agent-toolkit.schema.json`),
 * runtime config 검증 (`validateGithubRepositoryProfile` 아래),
 * 그리고 PR review watch handler (`handlePrWatchStart`) 가 *모두 이 한 곳* 을 참조한다 —
 * pr-watch.ts 가 이 enum 을 import 해서 쓰지, 자체 enum 을 두지 않는다 (drift 방지).
 *
 * 미래에 squash 외 새 전략 (예: `rebase-merge`) 이 추가되면 여기만 바꾸면 schema /
 * runtime / handler 가 같이 따라간다.
 */
export const MERGE_MODES = ["merge", "squash", "rebase"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

export function isMergeMode(value: string): value is MergeMode {
  return (MERGE_MODES as readonly string[]).includes(value);
}

const ALLOWED_GITHUB_MERGE_MODES: ReadonlySet<string> = new Set(MERGE_MODES);

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
  if (config.mysql !== undefined) {
    if (
      config.mysql === null ||
      typeof config.mysql !== "object" ||
      Array.isArray(config.mysql)
    ) {
      throw new Error(`${source}: mysql must be an object`);
    }
    const my = config.mysql as Record<string, unknown>;
    if (my.connections !== undefined) {
      validateMysqlConnections(my.connections, source);
    }
  }
  if (config.github !== undefined) {
    validateGithub(config.github, source);
  }
  return config as ToolkitConfig;
}

/**
 * `github` 객체 모양 검증. 두 surface 의 필드를 한 곳에서 같이 검증한다:
 *   - `repositories` — PR review watch 가 참조하는 `owner/repo` 메타 트리.
 *   - `repo` / `defaultLabels` — `spec-to-issues` 의 `gh` CLI 기본값.
 *
 * 미지원 key 는 reject (오타 가드, 스키마 lockstep). 토큰 / 비밀 키 (`token`,
 * `passwordEnv`, `apiKey` 등) 가 들어오면 거부 — 외부 GitHub MCP / `gh auth login` 의
 * 책임 영역과 명확히 분리.
 */
const ALLOWED_GITHUB_KEYS = new Set(["repositories", "repo", "defaultLabels"]);

/** spec-to-issues 의 `repo` 필드 패턴. dot 허용 (Phase 2 기존 정규식 유지). */
const SPEC_ISSUES_REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateGithub(
  gh: unknown,
  source: string,
): asserts gh is GithubConfig {
  if (gh === null || typeof gh !== "object" || Array.isArray(gh)) {
    throw new Error(`${source}: github must be an object`);
  }
  const g = gh as Record<string, unknown>;
  for (const key of Object.keys(g)) {
    if (!ALLOWED_GITHUB_KEYS.has(key)) {
      throw new Error(
        `${source}: github has unsupported key "${key}" — allowed: ${[...ALLOWED_GITHUB_KEYS].join(", ")}`,
      );
    }
  }
  if (g.repositories !== undefined) {
    validateGithubRepositories(g.repositories, source);
  }
  if (g.repo !== undefined) {
    if (typeof g.repo !== "string" || !SPEC_ISSUES_REPO_PATTERN.test(g.repo)) {
      throw new Error(
        `${source}: github.repo must match "owner/name" — got ${JSON.stringify(g.repo)}`,
      );
    }
  }
  if (g.defaultLabels !== undefined) {
    if (!Array.isArray(g.defaultLabels) || g.defaultLabels.length === 0) {
      throw new Error(
        `${source}: github.defaultLabels must be a non-empty string array — [0] is the dedupe filter`,
      );
    }
    for (const [i, label] of g.defaultLabels.entries()) {
      if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
        throw new Error(
          `${source}: github.defaultLabels[${i}] must match ${LABEL_PATTERN} — got ${JSON.stringify(label)}`,
        );
      }
    }
  }
}

/**
 * `github.repositories` 트리 검증. owner/repo 패턴 + leaf profile 의 4 종 필드 허용.
 * 미지원 key 는 reject (오타 가드, 스키마 lockstep).
 */
function validateGithubRepositories(
  repos: unknown,
  source: string,
): asserts repos is GithubRepositories {
  if (repos === null || typeof repos !== "object" || Array.isArray(repos)) {
    throw new Error(`${source}: github.repositories must be an object`);
  }
  for (const [key, profile] of Object.entries(
    repos as Record<string, unknown>,
  )) {
    if (!GITHUB_REPO_PATTERN.test(key)) {
      throw new Error(
        `${source}: github repository key "${key}" must match ${GITHUB_REPO_PATTERN} (owner/repo, body characters: alphanumeric, "_", ".", "-")`,
      );
    }
    validateGithubRepositoryProfile(
      profile,
      `${source}: github.repositories["${key}"]`,
    );
  }
}

function validateGithubRepositoryProfile(
  profile: unknown,
  where: string,
): void {
  if (
    profile === null ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    throw new Error(`${where} must be a repository-profile object`);
  }
  const p = profile as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!ALLOWED_GITHUB_REPO_KEYS.has(key)) {
      throw new Error(
        `${where} has unsupported key "${key}" — allowed: ${[...ALLOWED_GITHUB_REPO_KEYS].join(", ")}`,
      );
    }
  }
  if (p.alias !== undefined) {
    if (typeof p.alias !== "string" || !ID_PATTERN.test(p.alias)) {
      throw new Error(
        `${where}.alias must match ${ID_PATTERN} (alphanumeric, "_" or "-")`,
      );
    }
  }
  if (p.labels !== undefined) {
    if (!Array.isArray(p.labels)) {
      throw new Error(`${where}.labels must be an array of strings`);
    }
    for (const [i, label] of p.labels.entries()) {
      if (typeof label !== "string" || label.trim().length === 0) {
        throw new Error(`${where}.labels[${i}] must be a non-empty string`);
      }
    }
  }
  if (p.defaultBranch !== undefined) {
    if (
      typeof p.defaultBranch !== "string" ||
      p.defaultBranch.trim().length === 0
    ) {
      throw new Error(`${where}.defaultBranch must be a non-empty string`);
    }
  }
  if (p.mergeMode !== undefined) {
    if (
      typeof p.mergeMode !== "string" ||
      !ALLOWED_GITHUB_MERGE_MODES.has(p.mergeMode)
    ) {
      throw new Error(
        `${where}.mergeMode must be one of ${[...ALLOWED_GITHUB_MERGE_MODES].join(" / ")}`,
      );
    }
  }
}

/**
 * `spec` 객체 모양 검증. 모든 필드 optional + 빈 문자열 / 잘못된 타입은 reject.
 * 미지원 key (오타 포함) 도 reject — schema 의 `additionalProperties: false` 와 lockstep.
 * grace sub-agent 가 SPEC-합의 lifecycle 의 storage 위치를 잡을 때 사용.
 */
const ALLOWED_SPEC_KEYS = new Set(["dir", "scanDirectorySpec", "indexFile"]);

function validateSpec(
  spec: unknown,
  source: string,
): asserts spec is SpecConfig {
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
 * `mysql.connections` 트리 검증. host / env / db 식별자 패턴은 `openapi.registry` 와
 * 동일 (`ID_PATTERN`). 각 leaf profile 은 `passwordEnv` 와 `dsnEnv` 중 정확히 하나여야
 * 하고, 분해 필드 (host / port / user / database) 는 비어 있지 않은 string / 1..65535
 * 정수로만 받는다. 미지원 key 는 reject (오타 가드, 스키마 lockstep).
 */
const ALLOWED_PROFILE_KEYS = new Set([
  "host",
  "port",
  "user",
  "database",
  "passwordEnv",
  "dsnEnv",
]);

function validateMysqlConnections(
  conns: unknown,
  source: string,
): asserts conns is MysqlConnections {
  if (conns === null || typeof conns !== "object" || Array.isArray(conns)) {
    throw new Error(`${source}: mysql.connections must be an object`);
  }
  for (const [host, envs] of Object.entries(conns as Record<string, unknown>)) {
    if (!ID_PATTERN.test(host)) {
      throw new Error(
        `${source}: mysql host name "${host}" must match ${ID_PATTERN} (alphanumeric, "_" or "-" only — colons are reserved for handle separators)`,
      );
    }
    if (envs === null || typeof envs !== "object" || Array.isArray(envs)) {
      throw new Error(
        `${source}: mysql.connections["${host}"] must be an object of environments`,
      );
    }
    for (const [env, dbs] of Object.entries(envs as Record<string, unknown>)) {
      if (!ID_PATTERN.test(env)) {
        throw new Error(
          `${source}: mysql env name "${host}:${env}" must match ${ID_PATTERN}`,
        );
      }
      if (dbs === null || typeof dbs !== "object" || Array.isArray(dbs)) {
        throw new Error(
          `${source}: mysql.connections["${host}"]["${env}"] must be an object of databases`,
        );
      }
      for (const [db, profile] of Object.entries(
        dbs as Record<string, unknown>,
      )) {
        if (!ID_PATTERN.test(db)) {
          throw new Error(
            `${source}: mysql db name "${host}:${env}:${db}" must match ${ID_PATTERN}`,
          );
        }
        validateMysqlProfile(
          profile,
          `${source}: mysql.connections["${host}"]["${env}"]["${db}"]`,
        );
      }
    }
  }
}

function validateMysqlProfile(profile: unknown, where: string): void {
  if (
    profile === null ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    throw new Error(`${where} must be a connection-profile object`);
  }
  const p = profile as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!ALLOWED_PROFILE_KEYS.has(key)) {
      throw new Error(
        `${where} has unsupported key "${key}" — allowed: ${[...ALLOWED_PROFILE_KEYS].join(", ")}`,
      );
    }
  }
  const hasPasswordEnv = p.passwordEnv !== undefined;
  const hasDsnEnv = p.dsnEnv !== undefined;
  if (hasPasswordEnv && hasDsnEnv) {
    throw new Error(
      `${where} must declare exactly one of "passwordEnv" or "dsnEnv" — both were given`,
    );
  }
  if (!hasPasswordEnv && !hasDsnEnv) {
    throw new Error(
      `${where} must declare exactly one of "passwordEnv" or "dsnEnv" — neither was given (config files must never carry plaintext credentials)`,
    );
  }
  if (hasPasswordEnv) {
    if (
      typeof p.passwordEnv !== "string" ||
      p.passwordEnv.trim().length === 0
    ) {
      throw new Error(
        `${where}.passwordEnv must be a non-empty environment-variable name`,
      );
    }
    // dsnEnv 미사용 시 분해 필드는 host / user / database 모두 명시 필요. port 는 optional.
    requireNonEmptyString(p.host, `${where}.host`);
    requireNonEmptyString(p.user, `${where}.user`);
    requireNonEmptyString(p.database, `${where}.database`);
    if (p.port !== undefined) {
      if (
        typeof p.port !== "number" ||
        !Number.isInteger(p.port) ||
        p.port < 1 ||
        p.port > 65535
      ) {
        throw new Error(`${where}.port must be an integer in 1..65535`);
      }
    }
  } else {
    if (typeof p.dsnEnv !== "string" || p.dsnEnv.trim().length === 0) {
      throw new Error(
        `${where}.dsnEnv must be a non-empty environment-variable name`,
      );
    }
    // dsnEnv 사용 시 분해 필드는 무시되지만, 사용자가 적었으면 잘못된 기대를 막기 위해 reject.
    for (const k of ["host", "port", "user", "database"]) {
      if (p[k] !== undefined) {
        throw new Error(
          `${where} declares both "dsnEnv" and "${k}" — drop the decomposed field; dsnEnv carries it.`,
        );
      }
    }
  }
}

function requireNonEmptyString(value: unknown, where: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${where} must be a non-empty string`);
  }
}

function validateRegistry(
  reg: unknown,
  source: string,
): asserts reg is OpenapiRegistry {
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
    for (const [env, specs] of Object.entries(
      envs as Record<string, unknown>,
    )) {
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
      for (const [spec, url] of Object.entries(
        specs as Record<string, unknown>,
      )) {
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
  if (project.mysql?.connections) {
    out.mysql ??= {};
    out.mysql.connections ??= {};
    for (const [host, envs] of Object.entries(project.mysql.connections)) {
      out.mysql.connections[host] ??= {};
      for (const [env, dbs] of Object.entries(envs)) {
        out.mysql.connections[host]![env] ??= {};
        for (const [db, profile] of Object.entries(dbs)) {
          // profile 자체가 leaf — project 가 user 의 profile 을 통째로 덮어쓴다.
          out.mysql.connections[host]![env]![db] = profile;
        }
      }
    }
  }
  if (project.github) {
    out.github ??= {};
    // `repositories` 는 entry-by-entry leaf merge (mysql 과 동일 패턴) — project 가 같은
    // owner/repo entry 를 통째로 덮어쓰되, user 만 등록한 다른 owner/repo 는 살아남는다.
    if (project.github.repositories) {
      out.github.repositories ??= {};
      for (const [repo, profile] of Object.entries(
        project.github.repositories,
      )) {
        out.github.repositories[repo] = profile;
      }
    }
    // `repo` / `defaultLabels` 는 자체 leaf — project 가 user 를 통째로 덮어쓴다.
    if (project.github.repo !== undefined) {
      out.github.repo = project.github.repo;
    }
    if (project.github.defaultLabels !== undefined) {
      out.github.defaultLabels = project.github.defaultLabels;
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
