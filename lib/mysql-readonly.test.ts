import { describe, it, expect } from "bun:test";
import {
  assertReadOnlySql,
  enforceLimit,
  stripSqlComments,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./mysql-readonly";

describe("stripSqlComments", () => {
  it("strips -- line comments", () => {
    expect(stripSqlComments("SELECT 1 -- DELETE FROM users\n")).not.toContain("DELETE");
  });

  it("strips # line comments", () => {
    expect(stripSqlComments("SELECT 1 # DROP TABLE users\n")).not.toContain("DROP");
  });

  it("strips /* block */ comments", () => {
    expect(stripSqlComments("SELECT /* DROP TABLE x */ 1")).not.toContain("DROP");
  });

  it("strips single-quoted string literals", () => {
    expect(stripSqlComments("SELECT 'DELETE FROM users'")).not.toContain("DELETE");
  });

  it("respects doubled-quote escape inside strings", () => {
    // 'It''s ok' → 닫히지 않음 처리 X. 닫힘 후 본문 SELECT 만 남아야 한다.
    const stripped = stripSqlComments("SELECT 'It''s ok' FROM t");
    expect(stripped).not.toContain("It''s ok");
    expect(stripped.toUpperCase()).toContain("SELECT");
    expect(stripped.toUpperCase()).toContain("FROM T");
  });

  it("strips backtick identifiers", () => {
    // column 이름이 SET 인 경우 — 백틱으로 wrap 하면 deny-list 우회 가능해야 한다.
    const stripped = stripSqlComments("SELECT `SET` FROM t");
    expect(/\bSET\b/i.test(stripped)).toBe(false);
  });
});

describe("assertReadOnlySql — allow", () => {
  const allow = [
    "SELECT 1",
    "SELECT * FROM users",
    "  SELECT * FROM users  ",
    "select * from users",
    "SELECT * FROM users LIMIT 5",
    "SELECT * FROM users;",
    "SHOW TABLES",
    "SHOW CREATE TABLE users",
    "SHOW COLUMNS FROM users",
    "SHOW INDEX FROM users",
    "DESCRIBE users",
    "DESC users",
    "EXPLAIN SELECT * FROM users",
    "WITH cte AS (SELECT 1) SELECT * FROM cte",
    "(SELECT 1) UNION (SELECT 2)",
    "-- a leading comment\nSELECT 1",
    "/* leading block */ SELECT 1",
    "SELECT * FROM logs WHERE action = 'DELETE FROM users'",
    "SELECT * FROM logs WHERE action = 'DROP TABLE x'",
    "SELECT `SET`, `UPDATE` FROM cfg",
    "SELECT * FROM users WHERE id IN (SELECT id FROM admins)",
  ];
  for (const sql of allow) {
    it(`allows: ${sql}`, () => {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });
  }
});

describe("assertReadOnlySql — deny first keyword", () => {
  const deny = [
    "INSERT INTO users (id) VALUES (1)",
    "UPDATE users SET active = 0",
    "DELETE FROM users WHERE id = 1",
    "REPLACE INTO users (id) VALUES (1)",
    "DROP TABLE users",
    "CREATE TABLE x (id INT)",
    "ALTER TABLE users ADD COLUMN x INT",
    "TRUNCATE TABLE users",
    "RENAME TABLE a TO b",
    "GRANT SELECT ON *.* TO 'u'@'h'",
    "REVOKE SELECT ON *.* FROM 'u'@'h'",
    "CALL proc()",
    "LOAD DATA INFILE '/tmp/x' INTO TABLE t",
    "SET autocommit = 0",
    "SET @x := 1",
    "LOCK TABLES users WRITE",
    "UNLOCK TABLES",
    "HANDLER t OPEN",
  ];
  for (const sql of deny) {
    it(`denies: ${sql}`, () => {
      expect(() => assertReadOnlySql(sql)).toThrow(/MySQL read-only guard/);
    });
  }
});

describe("assertReadOnlySql — deny in body", () => {
  it("rejects WITH ... DELETE", () => {
    expect(() =>
      assertReadOnlySql("WITH cte AS (SELECT id FROM t) DELETE FROM users WHERE id IN (SELECT id FROM cte)"),
    ).toThrow(/forbidden keyword "DELETE"/);
  });

  it("rejects SELECT followed by another SELECT (multi-statement)", () => {
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(/multi-statement/);
  });

  it("rejects SELECT followed by a write statement", () => {
    expect(() => assertReadOnlySql("SELECT 1; DELETE FROM users")).toThrow(/multi-statement/);
  });

  it("rejects INTO OUTFILE", () => {
    expect(() => assertReadOnlySql("SELECT * FROM users INTO OUTFILE '/tmp/x'")).toThrow(
      /INTO OUTFILE/,
    );
  });

  it("rejects INTO DUMPFILE", () => {
    expect(() => assertReadOnlySql("SELECT * FROM users LIMIT 1 INTO DUMPFILE '/tmp/x'")).toThrow(
      /INTO OUTFILE/,
    );
  });

  it("rejects empty / whitespace-only", () => {
    expect(() => assertReadOnlySql("")).toThrow(/non-empty/);
    expect(() => assertReadOnlySql("   ")).toThrow(/non-empty/);
  });

  it("rejects comment-only input", () => {
    expect(() => assertReadOnlySql("-- nothing here\n")).toThrow(/comments \/ whitespace/);
  });

  it("rejects bypass via comment containing forbidden keyword tail", () => {
    // 주석은 strip 되지만, 그 뒤의 본문도 reject 사유가 있어야 한다.
    // /* DROP */ DELETE 는 DELETE 가 첫 키워드라 화이트리스트 위반.
    expect(() => assertReadOnlySql("/* SELECT */ DELETE FROM users")).toThrow(
      /leading keyword "DELETE"/,
    );
  });

  it("rejects cleverly-cased UPDATE", () => {
    expect(() => assertReadOnlySql("UpDaTe users SET x=1")).toThrow();
  });

  it("rejects MySQL executable comment with INTO OUTFILE inside", () => {
    // MySQL 의 `/*! ... */` 는 일반 주석처럼 보이지만 서버가 실행한다.
    expect(() =>
      assertReadOnlySql("SELECT /*! INTO OUTFILE '/tmp/x' */ 1"),
    ).toThrow(/MySQL executable comment/);
  });

  it("rejects version-prefixed MySQL executable comment", () => {
    expect(() =>
      assertReadOnlySql("SELECT /*!50100 INTO OUTFILE '/tmp/x' */ 1"),
    ).toThrow(/MySQL executable comment/);
  });

  it("rejects executable comment hiding a write statement", () => {
    expect(() =>
      assertReadOnlySql("SELECT 1 /*!50000 ; DELETE FROM users */"),
    ).toThrow(/MySQL executable comment/);
  });

  it("still allows ordinary /* ... */ block comments", () => {
    expect(() =>
      assertReadOnlySql("SELECT /* this is fine */ 1"),
    ).not.toThrow();
  });
});

describe("enforceLimit — SELECT", () => {
  it("appends LIMIT when missing", () => {
    const r = enforceLimit("SELECT * FROM users");
    expect(r.sql).toContain(`LIMIT ${DEFAULT_LIMIT}`);
    expect(r.effectiveLimit).toBe(DEFAULT_LIMIT);
    expect(r.capped).toBe(true);
  });

  it("preserves user LIMIT below cap", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 5");
    expect(r.sql).toMatch(/LIMIT 5\b/);
    expect(r.effectiveLimit).toBe(5);
    expect(r.capped).toBe(false);
  });

  it("caps user LIMIT above MAX_LIMIT", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 5000");
    expect(r.sql).toMatch(new RegExp(`LIMIT ${MAX_LIMIT}\\b`));
    expect(r.effectiveLimit).toBe(MAX_LIMIT);
    expect(r.capped).toBe(true);
  });

  it("caps user LIMIT above option.limit", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 500", { limit: 50 });
    expect(r.sql).toMatch(/LIMIT 50\b/);
    expect(r.effectiveLimit).toBe(50);
    expect(r.capped).toBe(true);
  });

  it("preserves OFFSET", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 10 OFFSET 20");
    expect(r.sql).toContain("OFFSET 20");
    expect(r.effectiveLimit).toBe(10);
    expect(r.capped).toBe(false);
  });

  it("handles LIMIT a, b form (offset, count)", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 5, 50");
    expect(r.sql).toMatch(/LIMIT 5,\s*50/);
    expect(r.effectiveLimit).toBe(50);
    expect(r.capped).toBe(false);
  });

  it("caps LIMIT a, b above cap", () => {
    const r = enforceLimit("SELECT * FROM users LIMIT 5, 5000");
    expect(r.sql).toMatch(new RegExp(`LIMIT 5,\\s*${MAX_LIMIT}`));
    expect(r.effectiveLimit).toBe(MAX_LIMIT);
    expect(r.capped).toBe(true);
  });

  it("preserves trailing semicolon", () => {
    const r = enforceLimit("SELECT * FROM users;");
    expect(r.sql.endsWith(";")).toBe(true);
    expect(r.sql).toContain(`LIMIT ${DEFAULT_LIMIT}`);
  });

  it("attaches LIMIT to WITH/CTE queries", () => {
    const r = enforceLimit("WITH cte AS (SELECT 1) SELECT * FROM cte");
    expect(r.sql).toContain(`LIMIT ${DEFAULT_LIMIT}`);
    expect(r.effectiveLimit).toBe(DEFAULT_LIMIT);
  });
});

describe("enforceLimit — non-SELECT", () => {
  it("does not modify SHOW", () => {
    const r = enforceLimit("SHOW TABLES");
    expect(r.sql).toBe("SHOW TABLES");
    expect(r.effectiveLimit).toBe(null);
    expect(r.capped).toBe(false);
  });

  it("does not modify DESCRIBE", () => {
    const r = enforceLimit("DESCRIBE users");
    expect(r.sql).toBe("DESCRIBE users");
    expect(r.effectiveLimit).toBe(null);
  });

  it("does not modify EXPLAIN", () => {
    const r = enforceLimit("EXPLAIN SELECT * FROM users");
    expect(r.sql).toBe("EXPLAIN SELECT * FROM users");
    expect(r.effectiveLimit).toBe(null);
  });
});
