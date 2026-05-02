/**
 * MySQL read-only SQL 가드.
 *
 * `mysql_query` 도구가 실행 직전에 호출하는 두 함수를 export 한다:
 *
 *   1. `assertReadOnlySql(sql)` — 주석 / 문자열 리터럴 / backtick 식별자를 strip 한 정규화 SQL 위에서
 *      (a) 첫 의미 키워드가 화이트리스트(`SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`)
 *      에 속하고, (b) 블랙리스트 (`INSERT` / `UPDATE` / `DELETE` / `REPLACE` / `MERGE` / `TRUNCATE`
 *      / `DROP` / `CREATE` / `ALTER` / `RENAME` / `GRANT` / `REVOKE` / `LOCK` / `UNLOCK` / `CALL` /
 *      `HANDLER` / `LOAD` / `SET`) 키워드가 단어 경계로 등장하지 않으며, (c) `INTO OUTFILE` /
 *      `INTO DUMPFILE` 가 없고, (d) 세미콜론이 trailing 위치 외에 나타나지 않는지 검증한다.
 *      위반 시 입력의 첫 120자를 인용한 명확한 에러로 throw.
 *
 *   2. `enforceLimit(sql, options?)` — `SELECT` / `WITH` 면 끝쪽 `LIMIT n` 또는 `LIMIT a, b` 또는
 *      `LIMIT a OFFSET b` 를 디폴트(100, 최대 1000)로 부착하거나 cap 한다. `SHOW` / `DESCRIBE`
 *      / `DESC` / `EXPLAIN` 은 그대로 통과 (`effectiveLimit: null`).
 *
 * 한국어 노트 — 문자열 리터럴 strip 은 doubled-quote escape (`''`, `""`, ` `` `) 만 인정한다.
 * Backslash escape (e.g. NO_BACKSLASH_ESCAPES SQL_MODE 의 반대) 는 **strip 하지 않으므로**
 * `'It\'s ok'` 같은 입력은 보수적으로 거부될 수 있다 — 이 경우 `''` doubled-quote escape 로
 * 바꿔 보내라는 안내를 SKILL.md 가 들고 있다. 정확한 SQL 파서가 아니므로 의심스러우면
 * 항상 reject 쪽으로 기운다.
 */

/** 디폴트 row 캡 — 사용자가 `mysql_query.limit` 또는 SQL 의 `LIMIT` 을 주지 않았을 때 적용. */
export const DEFAULT_LIMIT = 100;

/** row 캡 절대 상한 — 사용자가 더 큰 값을 주거나 SQL 의 `LIMIT` 이 더 크면 이 값으로 자른다. */
export const MAX_LIMIT = 1000;

/** 첫 의미 키워드 화이트리스트 (대문자 비교). */
export const ALLOWED_FIRST_KEYWORDS = [
  "SELECT",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "WITH",
] as const;

/**
 * 단어 경계로 검색하는 블랙리스트.
 * 한 번이라도 등장하면 reject — first keyword 가 화이트리스트라도 본문에 섞여 있으면 거부한다.
 *
 * `SET` 은 `SET autocommit`, `SET SESSION`, `SET @var := …` 등 부수효과 가능한 형태가 모두
 * 거부 대상이다. `SELECT … FROM tbl` 안에 column / function 으로 정확히 `SET` 이름이 나오는
 * 케이스는 백틱으로 wrap 하면 strip 단계에서 placeholder 로 바뀌어 통과한다.
 */
export const DENY_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "CREATE",
  "ALTER",
  "RENAME",
  "GRANT",
  "REVOKE",
  "LOCK",
  "UNLOCK",
  "CALL",
  "HANDLER",
  "LOAD",
  "SET",
] as const;

const INTO_OUTFILE_RE = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/**
 * SQL 의 주석 / 문자열 리터럴 / backtick 식별자를 모두 빈 placeholder 로 치환한다.
 * 단어 경계 / multi-statement 검사가 *코드 영역* 만 보도록 만들기 위한 사전 단계.
 *
 * 처리 대상:
 *   - `-- ...\n` 한 줄 주석
 *   - `# ...\n` 한 줄 주석 (MySQL 확장)
 *   - `\/* ... *\/` 블록 주석 (중첩 미지원 — MySQL 도 미지원)
 *   - `'...'` 작은따옴표 문자열 (`''` doubled-quote escape 인정)
 *   - `"..."` 큰따옴표 문자열 (`""` doubled-quote escape 인정)
 *   - `` `...` `` backtick 식별자 (` `` ` doubled-quote escape 인정)
 *
 * Backslash escape (`\\'`, `\\"`) 는 **인정하지 않는다** — escape 처리 변종이 SQL_MODE 에 따라
 * 갈리고, 의심스러운 입력은 보수적으로 거부하는 쪽이 read-only 보장에 안전하다.
 *
 * @param sql 원본 SQL
 * @returns 주석 / 문자열 / 식별자가 placeholder 로 치환된 SQL (길이는 원본과 다를 수 있다)
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : "";
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "'") {
      out += "''";
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      out += '""';
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      out += "``";
      i++;
      while (i < n) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 입력 SQL 이 read-only 검증을 통과하는지 확인한다. 통과하지 못하면 throw.
 * 통과 기준은 모듈 머리 JSDoc 의 (a)~(d).
 *
 * @throws 입력의 첫 120자를 인용한 컨텍스트-rich 한 Error
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("MySQL read-only guard: sql must be a non-empty string.");
  }
  const stripped = stripSqlComments(sql).trim();
  if (stripped.length === 0) {
    throw new Error(
      `MySQL read-only guard: sql contains only comments / whitespace — got "${truncate(sql, 120)}".`,
    );
  }

  // (d) trailing 외 위치의 ';' 거부 — multi-statement 차단.
  const noTrailingSemi = stripped.replace(/\s*;+\s*$/, "");
  if (noTrailingSemi.includes(";")) {
    throw new Error(
      `MySQL read-only guard: multi-statement SQL is rejected (semicolon at non-trailing position). Got "${truncate(sql, 120)}".`,
    );
  }

  // (a) first keyword 화이트리스트.
  const firstKeyword = readFirstKeyword(noTrailingSemi);
  if (!firstKeyword) {
    throw new Error(
      `MySQL read-only guard: cannot identify leading keyword. Got "${truncate(sql, 120)}".`,
    );
  }
  if (!(ALLOWED_FIRST_KEYWORDS as readonly string[]).includes(firstKeyword)) {
    throw new Error(
      `MySQL read-only guard: leading keyword "${firstKeyword}" is not allowed (must be one of: ${ALLOWED_FIRST_KEYWORDS.join(", ")}).`,
    );
  }

  // (b) 본문에 블랙리스트 키워드 등장 거부 — 단, `SHOW` 의 모든 변형 (`SHOW CREATE TABLE`,
  // `SHOW MASTER STATUS` 등) 은 의미상 read-only 이므로 본문 검사를 건너뛴다.
  if (firstKeyword !== "SHOW") {
    for (const kw of DENY_KEYWORDS) {
      const re = new RegExp(`\\b${kw}\\b`, "i");
      if (re.test(noTrailingSemi)) {
        throw new Error(
          `MySQL read-only guard: forbidden keyword "${kw}" detected — write / DDL / SET / CALL / LOAD / HANDLER / LOCK 등은 모두 거부합니다. Got "${truncate(sql, 120)}".`,
        );
      }
    }
  }

  // (c) INTO OUTFILE / DUMPFILE 거부.
  if (INTO_OUTFILE_RE.test(noTrailingSemi)) {
    throw new Error(
      `MySQL read-only guard: INTO OUTFILE / DUMPFILE is rejected — read-only mode does not allow writing to disk. Got "${truncate(sql, 120)}".`,
    );
  }
}

/** `enforceLimit` 옵션. */
export interface EnforceLimitOptions {
  /** 사용자가 명시한 row 캡. 미지정 시 `DEFAULT_LIMIT`. */
  limit?: number;
  /** 절대 상한. 미지정 시 `MAX_LIMIT`. 사용자 limit 이 max 보다 크면 max 로 자른다. */
  max?: number;
}

/** `enforceLimit` 결과. */
export interface EnforceLimitResult {
  /** 재작성된 SQL (LIMIT 부착 / cap). 첫 키워드가 SELECT/WITH 가 아니면 입력 그대로. */
  sql: string;
  /** 적용된 row 캡. SELECT/WITH 에만 의미 있음 — SHOW/DESCRIBE/EXPLAIN 은 `null`. */
  effectiveLimit: number | null;
  /** 원본 SQL 의 LIMIT 또는 사용자 옵션이 cap 으로 줄어들었거나 새로 부착됐는지 여부. */
  capped: boolean;
}

/**
 * SELECT / WITH 면 LIMIT 을 부착하거나 SQL / 옵션 / 절대 상한 중 가장 작은 쪽으로 재작성한다.
 * SHOW / DESCRIBE / DESC / EXPLAIN 은 그대로 통과 (`effectiveLimit: null`).
 *
 * 시멘틱:
 *   - `options.max` (디폴트 `MAX_LIMIT`) 는 *항상* 적용되는 절대 상한.
 *   - `options.limit` 가 명시적으로 주어지면 사용자 cap 으로 함께 적용.
 *   - SQL 에 `LIMIT` 이 없으면 `min(options.limit ?? DEFAULT_LIMIT, max)` 를 부착.
 *   - SQL 에 `LIMIT` 이 있으면 `min(sqlLimit, options.limit ?? Infinity, max)` 로 재작성.
 *
 * 정밀 SQL 파서가 아니므로 끝쪽의 `LIMIT n` / `LIMIT a, b` / `LIMIT n OFFSET m` 패턴만
 * 잡는다. 서브쿼리 안의 LIMIT 은 무시되고 outer 에 새 LIMIT 이 append 된다.
 *
 * @param sql `assertReadOnlySql` 를 통과한 SQL
 * @param options 사용자 cap (`limit`) 과 절대 상한 (`max`, 디폴트 `MAX_LIMIT`)
 * @returns 재작성된 SQL + 적용된 limit + capped 플래그
 */
export function enforceLimit(
  sql: string,
  options: EnforceLimitOptions = {},
): EnforceLimitResult {
  const max = clampPositive(options.max, MAX_LIMIT);
  const userLimit =
    typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const userBound = userLimit === null ? max : Math.min(userLimit, max);

  const stripped = stripSqlComments(sql).trim().replace(/\s*;+\s*$/, "");
  const firstKeyword = readFirstKeyword(stripped);
  if (firstKeyword !== "SELECT" && firstKeyword !== "WITH") {
    return { sql, effectiveLimit: null, capped: false };
  }

  const trailingSemi = /;\s*$/.test(sql) ? ";" : "";
  const body = sql.replace(/;\s*$/, "").replace(/\s+$/, "");

  // 끝쪽 LIMIT 검출 — `LIMIT n` / `LIMIT a, b` / `LIMIT n OFFSET m` 의 trailing 형태.
  // 정밀하지 않으므로 매칭 실패 시 LIMIT append 로 폴백 (안전 쪽).
  const limitRe = /\bLIMIT\s+(\d+)\s*(?:,\s*(\d+))?\s*(?:OFFSET\s+(\d+))?\s*$/i;
  const m = limitRe.exec(body);
  if (m) {
    const a = Number(m[1]);
    const hasComma = m[2] !== undefined;
    const offset = m[3];
    if (hasComma) {
      // LIMIT <offset>, <rowCount>
      const rowCount = Number(m[2]);
      const capped = Math.min(rowCount, userBound);
      const wasCapped = capped < rowCount;
      const prefix = body.slice(0, m.index);
      const replaced = `${prefix}LIMIT ${a}, ${capped}`;
      return { sql: replaced + trailingSemi, effectiveLimit: capped, capped: wasCapped };
    } else {
      // LIMIT <rowCount> [OFFSET <m>]
      const rowCount = a;
      const capped = Math.min(rowCount, userBound);
      const wasCapped = capped < rowCount;
      const prefix = body.slice(0, m.index);
      const offsetStr = offset !== undefined ? ` OFFSET ${offset}` : "";
      const replaced = `${prefix}LIMIT ${capped}${offsetStr}`;
      return { sql: replaced + trailingSemi, effectiveLimit: capped, capped: wasCapped };
    }
  }

  // SQL 에 LIMIT 없음 — 사용자가 명시한 limit 또는 디폴트를 부착 (max 로 cap).
  const attached = userLimit === null ? Math.min(DEFAULT_LIMIT, max) : userBound;
  return {
    sql: `${body}\nLIMIT ${attached}${trailingSemi}`,
    effectiveLimit: attached,
    capped: true,
  };
}

/** 정규화된 SQL 의 첫 의미 키워드를 대문자로 반환. 없으면 `null`. */
function readFirstKeyword(stripped: string): string | null {
  const m = stripped.match(/^[\s(]*([A-Za-z]+)/);
  return m ? m[1]!.toUpperCase() : null;
}

function clampPositive(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
