import {
  ID_BODY,
  type MysqlConnectionProfile,
  type MysqlConnections,
  type ToolkitConfig,
} from "./toolkit-config";

/**
 * `agent-toolkit.json` 의 `mysql.connections` 트리를 다루는 helper 모음.
 *
 * 입력 표기 (`openapi.registry` 와 동일한 모양):
 *   - `host`           — 한 host 아래의 모든 db
 *   - `host:env`       — 한 host 의 한 env 아래의 모든 db
 *   - `host:env:db`    — 정확히 한 db 핸들
 *
 * 식별자는 `agent-toolkit.schema.json` 의 패턴 (`^[a-zA-Z0-9_-]+$`) 을 따른다 — 콜론은
 * separator 로 예약. 등록되지 않은 핸들은 lookup 시 명확한 에러로 거부.
 *
 * 이 모듈은 *읽기 전용* — config 트리를 해석만 한다. 실제 DB 연결 / 자격증명 resolve 는
 * `lib/mysql-context.ts` 가 담당.
 */

/** 평면화된 한 항목. `mysql_envs` 의 출력 row. 자격증명은 노출하지 않는다. */
export interface MysqlRegistryEntry {
  /** 핸들 트리의 host 키. */
  host: string;
  /** 핸들 트리의 env 키. */
  env: string;
  /** 핸들 트리의 db 키. */
  db: string;
  /** `host:env:db` 핸들 문자열. */
  handle: string;
  /** 인증 모드 — 각 profile 이 어떤 env 변수를 쓰는지 구분. */
  authMode: "passwordEnv" | "dsnEnv";
  /** 비밀번호 / DSN 을 담은 env 변수 이름. *값* 자체는 노출하지 않는다. */
  authEnv: string;
  /** profile 의 host (`passwordEnv` 모드에서만 의미 있음 — `dsnEnv` 모드면 `null`). */
  hostName: string | null;
  /** profile 의 port (지정된 경우만). */
  port: number | null;
  /** profile 의 login user (`passwordEnv` 모드에서만). */
  user: string | null;
  /** profile 의 default database (`passwordEnv` 모드에서만). */
  database: string | null;
}

const HANDLE_FULL = new RegExp(`^(${ID_BODY}):(${ID_BODY}):(${ID_BODY})$`);
const HANDLE_HOST_ENV = new RegExp(`^(${ID_BODY}):(${ID_BODY})$`);
const HANDLE_HOST = new RegExp(`^${ID_BODY}$`);

/** 입력이 정확히 `host:env:db` 형태인지. */
export function isFullHandle(s: string): boolean {
  return HANDLE_FULL.test(s);
}

/** `host`, `host:env`, `host:env:db` 중 하나라도 맞는지. */
export function isScope(s: string): boolean {
  if (!s) return false;
  return HANDLE_FULL.test(s) || HANDLE_HOST_ENV.test(s) || HANDLE_HOST.test(s);
}

/**
 * 정확한 `host:env:db` handle 을 connection profile 로 해석.
 * 형식 위반 / 미등록은 throw — 메시지에 handle 을 포함.
 */
export function resolveHandle(
  handle: string,
  connections: MysqlConnections | undefined,
): { host: string; env: string; db: string; profile: MysqlConnectionProfile } {
  const m = HANDLE_FULL.exec(handle);
  if (!m) {
    throw new Error(
      `Not a host:env:db handle: "${handle}" (expected three colon-separated identifiers matching ^[a-zA-Z0-9_-]+$)`,
    );
  }
  const [, host, env, db] = m as unknown as [string, string, string, string];
  const profile = connections?.[host]?.[env]?.[db];
  if (!profile) {
    throw new Error(
      `MySQL handle "${handle}" not found in mysql.connections. Check ./.opencode/agent-toolkit.json or ~/.config/opencode/agent-toolkit/agent-toolkit.json.`,
    );
  }
  return { host, env, db, profile };
}

/**
 * scope (`host` / `host:env` / `host:env:db`) 를 매칭되는 핸들 평면 리스트로 풀어 준다.
 * 매칭 0 건이면 빈 배열. handle 형식에 안 맞으면 빈 배열.
 */
export function resolveScopeToEntries(
  scope: string,
  config: ToolkitConfig,
): MysqlRegistryEntry[] {
  if (!scope) return [];
  const conns = config.mysql?.connections;
  if (!conns) return [];

  if (HANDLE_FULL.test(scope)) {
    try {
      const { host, env, db, profile } = resolveHandle(scope, conns);
      return [toEntry(host, env, db, profile)];
    } catch {
      return [];
    }
  }
  const fullEnv = HANDLE_HOST_ENV.exec(scope);
  if (fullEnv) {
    const [, host, env] = fullEnv as unknown as [string, string, string];
    const dbs = conns[host]?.[env];
    if (!dbs) return [];
    return Object.entries(dbs).map(([db, profile]) =>
      toEntry(host, env, db, profile),
    );
  }
  if (HANDLE_HOST.test(scope)) {
    const envs = conns[scope];
    if (!envs) return [];
    const out: MysqlRegistryEntry[] = [];
    for (const [env, dbs] of Object.entries(envs)) {
      for (const [db, profile] of Object.entries(dbs)) {
        out.push(toEntry(scope, env, db, profile));
      }
    }
    return out;
  }
  return [];
}

/** registry 트리를 평면 entry 리스트로 펼친다 — `mysql_envs` 의 출력 그대로. */
export function listRegistry(config: ToolkitConfig): MysqlRegistryEntry[] {
  const conns = config.mysql?.connections ?? {};
  const out: MysqlRegistryEntry[] = [];
  for (const [host, envs] of Object.entries(conns)) {
    for (const [env, dbs] of Object.entries(envs)) {
      for (const [db, profile] of Object.entries(dbs)) {
        out.push(toEntry(host, env, db, profile));
      }
    }
  }
  return out;
}

function toEntry(
  host: string,
  env: string,
  db: string,
  profile: MysqlConnectionProfile,
): MysqlRegistryEntry {
  const usingDsn = profile.dsnEnv !== undefined;
  return {
    host,
    env,
    db,
    handle: `${host}:${env}:${db}`,
    authMode: usingDsn ? "dsnEnv" : "passwordEnv",
    authEnv: usingDsn ? profile.dsnEnv! : profile.passwordEnv!,
    hostName: usingDsn ? null : (profile.host ?? null),
    port: profile.port ?? null,
    user: usingDsn ? null : (profile.user ?? null),
    database: usingDsn ? null : (profile.database ?? null),
  };
}
