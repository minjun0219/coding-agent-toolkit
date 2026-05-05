import mysql from "mysql2/promise";
import type {
  Pool,
  PoolOptions,
  RowDataPacket,
  FieldPacket,
} from "mysql2/promise";
import { resolveHandle, type MysqlRegistryEntry } from "./mysql-registry";
import type { MysqlConnectionProfile, ToolkitConfig } from "./toolkit-config";
import {
  assertReadOnlySql,
  enforceLimit,
  type EnforceLimitOptions,
} from "./mysql-readonly";

/**
 * MySQL 핸들의 connection / pool / read-only query 실행 레이어.
 *
 * 이 파일은 mysql2 의존성을 *유일하게* 사용하는 모듈이다. 도구 핸들러는
 * `MysqlExecutor` 인터페이스만 보고 동작하므로 단위테스트에서는 fake executor 를
 * 주입할 수 있다 — DB 없이 SQL 검증 / LIMIT / 결과 형식 변환을 모두 검증 가능.
 *
 * 보안 / 안전 고정값 (`POOL_FIXED_OPTIONS`):
 *   - `multipleStatements: false` — wire 단에서 multi-statement 차단 (`assertReadOnlySql`
 *     의 추가 방어선)
 *   - `namedPlaceholders: false` — 호환성 단순화
 *   - `dateStrings: true` — 결과를 일관된 ISO-ish 문자열로 (Date 객체 직렬화 변동 회피)
 *   - `connectTimeout: 5000` — 살아 있지 않은 DB 에 오래 매달리지 않게
 *   - `timezone: "+00:00"` — 클라이언트 측 timezone 변환 비활성화 (raw 값 그대로)
 *   - `connectionLimit: 2` — admin 조회용으로 충분, idle 핸들 누수 최소화
 *
 * 자격증명은 *항상* 환경변수에서 읽는다. profile 의 `passwordEnv` (host/user/database 분해
 * 필드 + 별도 비밀번호) 또는 `dsnEnv` (`mysql://user:pass@host/db` 한 줄) 중 정확히 하나만
 * 인정된다. 나머지 검증은 `lib/toolkit-config.ts` 의 `validateConfig` 가 담당한다.
 */

export const POOL_FIXED_OPTIONS = {
  multipleStatements: false,
  namedPlaceholders: false,
  dateStrings: true,
  connectTimeout: 5_000,
  timezone: "+00:00",
  connectionLimit: 2,
} as const satisfies Partial<PoolOptions>;

/**
 * 한 row 의 실행 결과 — 도구 출력의 row 한 줄.
 * key 는 컬럼 이름, value 는 mysql2 가 반환한 raw 값 (`dateStrings: true` 라 Date 는 문자열).
 */
export type MysqlRow = Record<string, unknown>;

/** 컬럼 메타. */
export interface MysqlColumnMeta {
  /** 컬럼 이름. */
  name: string;
  /** mysql2 가 noting `columnType` 의 정수값 (실제 enum 매핑은 호출자 책임). */
  type: number | null;
  /** 컬럼이 속한 테이블 (`SELECT a.id FROM a` 처럼 alias 가 있어도 원본 테이블 이름). */
  table: string | null;
}

/** `mysql_query` 의 출력 형태 — 도구 응답이 그대로 사용한다. */
export interface MysqlQueryResult {
  /** 검증 + LIMIT 강제 후 실제로 실행된 SQL. */
  sql: string;
  rows: MysqlRow[];
  columns: MysqlColumnMeta[];
  rowCount: number;
  /** LIMIT 가 부착됐거나 cap 으로 줄어들었을 때 true. */
  truncated: boolean;
  /** 실제로 적용된 row cap. SHOW / DESCRIBE / EXPLAIN 은 `null`. */
  effectiveLimit: number | null;
}

/**
 * 핸들러가 의존하는 최소 인터페이스 — `mysql2.Pool` 의 `query` 부분집합.
 *
 * 단위테스트는 이 인터페이스의 fake 를 주입해 mysql2 를 거치지 않고 SQL 검증 + LIMIT +
 * 결과 형식 변환만 검증한다. 실제 핸들러는 `createPoolExecutor(...)` 가 반환하는 wrapper
 * 를 사용한다.
 */
export interface MysqlExecutor {
  /**
   * read-only SQL 한 줄을 실행해 raw row 배열과 mysql2 의 FieldPacket[] 을 반환한다.
   * 실패 시 mysql2 의 원본 에러를 그대로 throw — 핸들러가 에러를 사용자에게 반사한다.
   */
  query(sql: string): Promise<{ rows: RowDataPacket[]; fields: FieldPacket[] }>;
}

/**
 * mysql2/promise pool 을 감싸는 closure-based executor 팩토리.
 * pool 의 lifecycle (close 등) 은 호출자 (플러그인 entrypoint) 가 들고 있다.
 */
export function createPoolExecutor(pool: Pool): MysqlExecutor {
  return {
    async query(sql: string) {
      const [rows, fields] = await pool.query<RowDataPacket[]>(sql);
      return { rows, fields };
    },
  };
}

/**
 * profile 과 환경변수 셋을 받아 mysql2/promise pool 을 만든다.
 * 자격증명은 *이 함수 안에서만* 살아 있고, 반환된 pool 은 라이브러리 바깥으로 노출하지
 * 않는다 — 도구 핸들러는 pool 을 감싼 `MysqlExecutor` 만 본다.
 *
 * @param handle `host:env:db` (에러 메시지에 안전하게 포함)
 * @param profile `validateConfig` 통과한 connection profile
 * @param env 환경변수 dictionary — 일반적으로 `process.env`. 단위테스트에서는 fixture 주입
 * @throws env 변수 누락 / DSN 파싱 실패 / pool 생성 실패 시
 */
export function createPoolFromProfile(
  handle: string,
  profile: MysqlConnectionProfile,
  env: Record<string, string | undefined>,
): Pool {
  const options = resolvePoolOptions(handle, profile, env);
  return mysql.createPool({ ...options, ...POOL_FIXED_OPTIONS });
}

/**
 * profile 의 인증 모드를 풀어 mysql2 PoolOptions 일부를 만든다 (host/port/user/password/database).
 * 보안 / 시간초과 등 고정값은 `POOL_FIXED_OPTIONS` 로 따로 합쳐진다.
 *
 * Visibility: 단위테스트에서 직접 호출하기 위해 export — fake `env` 와 함께 시그니처 검증.
 */
export function resolvePoolOptions(
  handle: string,
  profile: MysqlConnectionProfile,
  env: Record<string, string | undefined>,
): Pick<PoolOptions, "host" | "port" | "user" | "password" | "database"> {
  if (profile.dsnEnv !== undefined) {
    const dsn = env[profile.dsnEnv];
    if (!dsn || dsn.trim().length === 0) {
      throw new Error(
        `MySQL handle "${handle}": environment variable ${profile.dsnEnv} is empty or missing — cannot resolve DSN.`,
      );
    }
    return parseDsn(handle, dsn);
  }
  if (profile.passwordEnv !== undefined) {
    const password = env[profile.passwordEnv];
    if (password === undefined) {
      // 빈 문자열은 허용 (개발 환경에서 빈 비밀번호 케이스).
      throw new Error(
        `MySQL handle "${handle}": environment variable ${profile.passwordEnv} is missing — cannot resolve password.`,
      );
    }
    return {
      host: profile.host!,
      port: profile.port,
      user: profile.user!,
      password,
      database: profile.database!,
    };
  }
  // toolkit-config.validateConfig 가 사전에 거부하므로 여기 도달하면 invariant 위반.
  throw new Error(
    `MySQL handle "${handle}": profile must declare exactly one of "passwordEnv" or "dsnEnv" — got neither (config validation should have rejected this earlier).`,
  );
}

/**
 * `mysql://` / `mariadb://` DSN 을 PoolOptions 분해 필드로 파싱.
 * URL 파서를 그대로 쓰되 user / password 를 `decodeURIComponent` 로 복원한다.
 */
function parseDsn(
  handle: string,
  dsn: string,
): Pick<PoolOptions, "host" | "port" | "user" | "password" | "database"> {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(
      `MySQL handle "${handle}": DSN is not a valid URL (expected "mysql://user:pass@host:port/db", got "${redactDsn(dsn)}").`,
    );
  }
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
    throw new Error(
      `MySQL handle "${handle}": DSN scheme must be "mysql:" or "mariadb:", got "${url.protocol}".`,
    );
  }
  const host = url.hostname;
  if (!host) {
    throw new Error(`MySQL handle "${handle}": DSN missing host.`);
  }
  const portStr = url.port;
  const port = portStr ? Number(portStr) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error(
      `MySQL handle "${handle}": DSN port "${portStr}" is invalid.`,
    );
  }
  if (!url.username) {
    throw new Error(
      `MySQL handle "${handle}": DSN missing user — expected "mysql://user:pass@host:port/db".`,
    );
  }
  if (!url.pathname || url.pathname.length <= 1) {
    throw new Error(
      `MySQL handle "${handle}": DSN missing database — expected "mysql://user:pass@host:port/db".`,
    );
  }
  const user = decodeURIComponent(url.username);
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const database = decodeURIComponent(url.pathname.slice(1));
  return { host, port, user, password, database };
}

/** 에러 메시지에 DSN 을 직접 박지 않도록 비밀번호 부분만 가린 형태로 노출. */
function redactDsn(dsn: string): string {
  return dsn.replace(/^(\w+:\/\/[^:]+:)[^@]+(@.*)$/, "$1***$2");
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 핸들러가 호출하는 read-only 동작들. executor 만 보고 동작 — pool 은 외부에서 들고 있음.
// ─────────────────────────────────────────────────────────────────────────────

/** `SELECT 1 AS ok` 한 번. timeout / auth 실패 시 mysql2 에러를 그대로 throw. */
export async function pingHandle(
  executor: MysqlExecutor,
): Promise<{ ok: boolean }> {
  const { rows } = await executor.query("SELECT 1 AS ok");
  const first = rows[0] as Record<string, unknown> | undefined;
  return { ok: first?.ok === 1 || first?.ok === "1" };
}

/** `SHOW FULL TABLES` — 테이블 목록 + table_type (BASE TABLE / VIEW). */
export async function listTables(
  executor: MysqlExecutor,
): Promise<Array<{ name: string; type: string }>> {
  const { rows } = await executor.query("SHOW FULL TABLES");
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    // 첫 컬럼은 `Tables_in_<db>` 처럼 동적이라 Object.values 로 첫 두 값만 사용.
    const values = Object.values(r);
    return {
      name: String(values[0] ?? ""),
      type: String(values[1] ?? ""),
    };
  });
}

/**
 * 테이블 미지정 시: `INFORMATION_SCHEMA.COLUMNS` 의 현재 DB 컬럼 요약.
 * 테이블 지정 시: `SHOW CREATE TABLE` + `SHOW INDEX FROM` 합본.
 *
 * @param executor MysqlExecutor
 * @param table optional 테이블 이름 (식별자만 — 사용자 입력 검증은 호출자가 한다)
 */
export async function describeTable(
  executor: MysqlExecutor,
  table?: string,
): Promise<{
  mode: "summary" | "detail";
  columns?: Array<{
    table: string;
    column: string;
    type: string;
    nullable: string;
    key: string;
    default: unknown;
    extra: string;
  }>;
  createTable?: string;
  indexes?: Array<{
    keyName: string;
    column: string;
    nonUnique: number;
    type: string;
  }>;
}> {
  if (!table) {
    const sql =
      "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA " +
      "FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() " +
      "ORDER BY TABLE_NAME, ORDINAL_POSITION";
    const { rows } = await executor.query(sql);
    return {
      mode: "summary",
      columns: rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          table: String(row.TABLE_NAME ?? ""),
          column: String(row.COLUMN_NAME ?? ""),
          type: String(row.COLUMN_TYPE ?? ""),
          nullable: String(row.IS_NULLABLE ?? ""),
          key: String(row.COLUMN_KEY ?? ""),
          default: row.COLUMN_DEFAULT ?? null,
          extra: String(row.EXTRA ?? ""),
        };
      }),
    };
  }

  const safeTable = table.replace(/`/g, "``");
  const createSql = `SHOW CREATE TABLE \`${safeTable}\``;
  const indexSql = `SHOW INDEX FROM \`${safeTable}\``;
  const [{ rows: createRows }, { rows: indexRows }] = await Promise.all([
    executor.query(createSql),
    executor.query(indexSql),
  ]);
  const createRow = createRows[0] as Record<string, unknown> | undefined;
  const createTable = createRow
    ? String(createRow["Create Table"] ?? createRow["Create View"] ?? "")
    : "";
  return {
    mode: "detail",
    createTable,
    indexes: indexRows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        keyName: String(row.Key_name ?? ""),
        column: String(row.Column_name ?? ""),
        nonUnique: Number(row.Non_unique ?? 0),
        type: String(row.Index_type ?? ""),
      };
    }),
  };
}

/** `runReadonlyQuery` 옵션 — `enforceLimit` 와 정확히 동일한 모양. */
export type RunReadonlyQueryOptions = EnforceLimitOptions;

/**
 * 사용자 SQL 을 검증 + LIMIT 강제 후 실행하고, 도구 응답 형식으로 정리해 반환한다.
 *
 * 단계:
 *   1. `assertReadOnlySql(sql)` — 위반 시 throw. **DB 호출 없음**.
 *   2. `enforceLimit(sql, options)` — SELECT/WITH 면 LIMIT 부착 / cap.
 *   3. `executor.query(rewrittenSql)` — mysql2 가 mysql 서버로 보낸다.
 *   4. row 개수가 `effectiveLimit` 와 같으면 truncated 로 표시 (이미 cap 됐을 수 있음).
 */
export async function runReadonlyQuery(
  executor: MysqlExecutor,
  sql: string,
  options: RunReadonlyQueryOptions = {},
): Promise<MysqlQueryResult> {
  assertReadOnlySql(sql);
  const { sql: rewritten, effectiveLimit } = enforceLimit(sql, options);
  const { rows, fields } = await executor.query(rewritten);
  const columns: MysqlColumnMeta[] = (fields ?? []).map((f) => ({
    name: String((f as { name: string }).name ?? ""),
    type:
      typeof (f as { columnType?: number }).columnType === "number"
        ? (f as { columnType: number }).columnType
        : null,
    table:
      typeof (f as { table?: string }).table === "string"
        ? (f as { table: string }).table
        : null,
  }));
  const rowCount = rows.length;
  const truncated = effectiveLimit !== null && rowCount === effectiveLimit;
  return {
    sql: rewritten,
    rows: rows as MysqlRow[],
    columns,
    rowCount,
    truncated,
    effectiveLimit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 핸들 → executor 라이프사이클 매니저. 플러그인 entrypoint 가 한 instance 를 들고 있는다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 핸들마다 lazy 로 pool 을 만들고 캐시한다 — `mysql_*` 도구가 같은 turn 안에서 같은
 * 핸들로 여러 번 호출돼도 connection 을 재사용하기 위함.
 *
 * 이 클래스는 mysql2 를 직접 사용하지 않는다 — pool 생성 함수를 주입받아 단위테스트가
 * 가능하다 (실제 entrypoint 는 `createPoolFromProfile` 을 그대로 넘긴다).
 */
export class MysqlExecutorRegistry {
  private readonly pools = new Map<string, Pool>();
  private readonly executors = new Map<string, MysqlExecutor>();

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly factory: (
      handle: string,
      profile: MysqlConnectionProfile,
      env: Record<string, string | undefined>,
    ) => Pool = createPoolFromProfile,
  ) {}

  /**
   * 핸들 검증 + 미존재 시 pool 새로 생성. 이미 만들어진 핸들이면 그대로 재사용.
   * @param handle `host:env:db` — `validateConfig` 통과한 핸들이어야 한다
   * @param config user+project merge 결과
   */
  getExecutor(handle: string, config: ToolkitConfig): MysqlExecutor {
    const cached = this.executors.get(handle);
    if (cached) return cached;
    const { profile } = resolveHandle(handle, config.mysql?.connections);
    const pool = this.factory(handle, profile, this.env);
    this.pools.set(handle, pool);
    const executor = createPoolExecutor(pool);
    this.executors.set(handle, executor);
    return executor;
  }

  /**
   * 모든 pool 을 닫는다 (플러그인 종료 시점). 일부가 실패해도 나머지는 시도.
   */
  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [, pool] of this.pools) {
      try {
        await pool.end();
      } catch (err) {
        errors.push(err);
      }
    }
    this.pools.clear();
    this.executors.clear();
    if (errors.length > 0) {
      throw new AggregateError(
        errors as Error[],
        "Failed to close some MySQL pools",
      );
    }
  }
}

/**
 * 핸들 → registry entry 의 메타만 노출. 인증값은 절대 포함하지 않는다.
 * `mysql_status` 가 ping 전에 일관 메타를 보여 줄 때 사용한다.
 */
export function describeHandle(
  handle: string,
  config: ToolkitConfig,
): MysqlRegistryEntry {
  const { host, env, db, profile } = resolveHandle(
    handle,
    config.mysql?.connections,
  );
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
