import { describe, it, expect } from "bun:test";
import type { FieldPacket, RowDataPacket } from "mysql2/promise";
import {
  MysqlExecutorRegistry,
  describeHandle,
  describeTable,
  listTables,
  pingHandle,
  resolvePoolOptions,
  runReadonlyQuery,
  type MysqlExecutor,
} from "./mysql-context";
import type { ToolkitConfig } from "./toolkit-config";

// ── Fixtures ────────────────────────────────────────────────────────────────

const sampleConfig: ToolkitConfig = {
  mysql: {
    connections: {
      acme: {
        prod: {
          users: {
            host: "db.acme.com",
            port: 3306,
            user: "readonly",
            database: "app",
            passwordEnv: "MYSQL_ACME_PROD_USERS_PASSWORD",
          },
          orders: { dsnEnv: "MYSQL_ACME_PROD_ORDERS_DSN" },
        },
      },
    },
  },
};

class FakeExecutor implements MysqlExecutor {
  public seen: string[] = [];
  constructor(
    private readonly responses: Array<{
      rows: RowDataPacket[];
      fields: FieldPacket[];
    }>,
  ) {}
  async query(sql: string) {
    this.seen.push(sql);
    const next = this.responses.shift();
    if (!next)
      throw new Error(`FakeExecutor: no response queued for SQL: ${sql}`);
    return next;
  }
}

const noFields = [] as unknown as FieldPacket[];

// ── resolvePoolOptions ──────────────────────────────────────────────────────

describe("resolvePoolOptions — passwordEnv mode", () => {
  it("composes options from profile + password env", () => {
    const profile = sampleConfig.mysql!.connections!.acme!.prod!.users!;
    const options = resolvePoolOptions("acme:prod:users", profile, {
      MYSQL_ACME_PROD_USERS_PASSWORD: "s3cret",
    });
    expect(options).toEqual({
      host: "db.acme.com",
      port: 3306,
      user: "readonly",
      password: "s3cret",
      database: "app",
    });
  });

  it("throws when password env is missing", () => {
    const profile = sampleConfig.mysql!.connections!.acme!.prod!.users!;
    expect(() => resolvePoolOptions("acme:prod:users", profile, {})).toThrow(
      /MYSQL_ACME_PROD_USERS_PASSWORD is missing/,
    );
  });

  it("allows empty-string password (dev environments)", () => {
    const profile = sampleConfig.mysql!.connections!.acme!.prod!.users!;
    const options = resolvePoolOptions("acme:prod:users", profile, {
      MYSQL_ACME_PROD_USERS_PASSWORD: "",
    });
    expect(options.password).toBe("");
  });
});

describe("resolvePoolOptions — dsnEnv mode", () => {
  it("parses a DSN with all parts", () => {
    const profile = { dsnEnv: "MYSQL_DSN" };
    const options = resolvePoolOptions("a:b:c", profile, {
      MYSQL_DSN: "mysql://user:p%40ss@db.example.com:3307/orders",
    });
    expect(options).toEqual({
      host: "db.example.com",
      port: 3307,
      user: "user",
      password: "p@ss",
      database: "orders",
    });
  });

  it("accepts mariadb:// scheme", () => {
    const profile = { dsnEnv: "MYSQL_DSN" };
    const options = resolvePoolOptions("a:b:c", profile, {
      MYSQL_DSN: "mariadb://u:p@h/d",
    });
    expect(options.host).toBe("h");
    expect(options.user).toBe("u");
    expect(options.database).toBe("d");
  });

  it("throws on missing DSN env", () => {
    expect(() =>
      resolvePoolOptions("a:b:c", { dsnEnv: "MYSQL_DSN" }, {}),
    ).toThrow(/MYSQL_DSN is empty or missing/);
  });

  it("throws on empty-string DSN env", () => {
    expect(() =>
      resolvePoolOptions("a:b:c", { dsnEnv: "MYSQL_DSN" }, { MYSQL_DSN: "" }),
    ).toThrow(/MYSQL_DSN is empty or missing/);
  });

  it("rejects non-mysql scheme", () => {
    expect(() =>
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "postgres://u:p@h/d" },
      ),
    ).toThrow(/scheme must be "mysql:" or "mariadb:"/);
  });

  it("rejects malformed URL", () => {
    expect(() =>
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "not a url" },
      ),
    ).toThrow(/not a valid URL/);
  });

  it("rejects DSN missing user", () => {
    expect(() =>
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "mysql://h:3306/db" },
      ),
    ).toThrow(/DSN missing user/);
  });

  it("rejects DSN missing database (no path)", () => {
    expect(() =>
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "mysql://u:p@h" },
      ),
    ).toThrow(/DSN missing database/);
  });

  it("rejects DSN missing database (root path only)", () => {
    expect(() =>
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "mysql://u:p@h/" },
      ),
    ).toThrow(/DSN missing database/);
  });

  it("does not leak the password into the error message", () => {
    try {
      resolvePoolOptions(
        "a:b:c",
        { dsnEnv: "MYSQL_DSN" },
        { MYSQL_DSN: "mongodb://u:supersecret@h/d" },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("supersecret");
    }
  });
});

// ── pingHandle / listTables / describeTable / runReadonlyQuery ─────────────

describe("pingHandle", () => {
  it("returns ok:true on SELECT 1 success", async () => {
    const fake = new FakeExecutor([
      { rows: [{ ok: 1 } as unknown as RowDataPacket], fields: noFields },
    ]);
    const r = await pingHandle(fake);
    expect(r.ok).toBe(true);
    expect(fake.seen).toEqual(["SELECT 1 AS ok"]);
  });

  it("returns ok:false when ping returns nothing usable", async () => {
    const fake = new FakeExecutor([{ rows: [], fields: noFields }]);
    const r = await pingHandle(fake);
    expect(r.ok).toBe(false);
  });
});

describe("listTables", () => {
  it("flattens SHOW FULL TABLES rows by ordinal position", async () => {
    const fake = new FakeExecutor([
      {
        rows: [
          {
            Tables_in_app: "users",
            Table_type: "BASE TABLE",
          } as unknown as RowDataPacket,
          {
            Tables_in_app: "v_active",
            Table_type: "VIEW",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
    ]);
    const r = await listTables(fake);
    expect(r).toEqual([
      { name: "users", type: "BASE TABLE" },
      { name: "v_active", type: "VIEW" },
    ]);
  });
});

describe("describeTable", () => {
  it("returns a summary of all columns when no table is given", async () => {
    const fake = new FakeExecutor([
      {
        rows: [
          {
            TABLE_NAME: "users",
            COLUMN_NAME: "id",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "NO",
            COLUMN_KEY: "PRI",
            COLUMN_DEFAULT: null,
            EXTRA: "auto_increment",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
    ]);
    const r = await describeTable(fake);
    expect(r.mode).toBe("summary");
    expect(r.columns?.[0]?.column).toBe("id");
    expect(r.columns?.[0]?.type).toBe("int");
    expect(fake.seen[0]).toContain("INFORMATION_SCHEMA.COLUMNS");
  });

  it("returns SHOW CREATE TABLE + SHOW INDEX FROM when a table is given", async () => {
    const fake = new FakeExecutor([
      {
        rows: [
          {
            Table: "users",
            "Create Table": "CREATE TABLE users (id INT PRIMARY KEY)",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
      {
        rows: [
          {
            Key_name: "PRIMARY",
            Column_name: "id",
            Non_unique: 0,
            Index_type: "BTREE",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
    ]);
    const r = await describeTable(fake, "users");
    expect(r.mode).toBe("detail");
    expect(r.createTable).toContain("CREATE TABLE");
    expect(r.indexes?.[0]?.keyName).toBe("PRIMARY");
    expect(fake.seen[0]).toContain("SHOW CREATE TABLE `users`");
    expect(fake.seen[1]).toContain("SHOW INDEX FROM `users`");
  });

  it("escapes backticks in table names", async () => {
    const fake = new FakeExecutor([
      { rows: [], fields: noFields },
      { rows: [], fields: noFields },
    ]);
    await describeTable(fake, "weird`name");
    expect(fake.seen[0]).toContain("SHOW CREATE TABLE `weird``name`");
  });
});

describe("runReadonlyQuery", () => {
  it("throws on a forbidden write before touching the executor", async () => {
    const fake = new FakeExecutor([]);
    await expect(runReadonlyQuery(fake, "DELETE FROM users")).rejects.toThrow(
      /MySQL read-only guard/,
    );
    expect(fake.seen).toEqual([]);
  });

  it("appends LIMIT to a bare SELECT and reports truncated when row count == cap", async () => {
    const fake = new FakeExecutor([
      {
        rows: Array.from(
          { length: 100 },
          (_, i) => ({ id: i }) as unknown as RowDataPacket,
        ),
        fields: [
          {
            name: "id",
            columnType: 3,
            table: "users",
          } as unknown as FieldPacket,
        ],
      },
    ]);
    const r = await runReadonlyQuery(fake, "SELECT * FROM users");
    expect(fake.seen[0]).toContain("LIMIT 100");
    expect(r.rowCount).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.effectiveLimit).toBe(100);
    expect(r.columns).toEqual([{ name: "id", type: 3, table: "users" }]);
  });

  it("does not report truncated when an attached LIMIT returns fewer rows than the cap", async () => {
    const fake = new FakeExecutor([
      {
        rows: [{ id: 1 } as unknown as RowDataPacket],
        fields: [],
      },
    ]);
    const r = await runReadonlyQuery(fake, "SELECT * FROM users");
    expect(fake.seen[0]).toContain("LIMIT 100");
    expect(r.rowCount).toBe(1);
    expect(r.effectiveLimit).toBe(100);
    expect(r.truncated).toBe(false);
  });

  it("does not modify SHOW TABLES", async () => {
    const fake = new FakeExecutor([
      {
        rows: [{ Tables_in_app: "users" } as unknown as RowDataPacket],
        fields: [],
      },
    ]);
    const r = await runReadonlyQuery(fake, "SHOW TABLES");
    expect(fake.seen[0]).toBe("SHOW TABLES");
    expect(r.effectiveLimit).toBe(null);
    expect(r.truncated).toBe(false);
  });

  it("caps user LIMIT above MAX_LIMIT", async () => {
    const fake = new FakeExecutor([{ rows: [], fields: [] }]);
    await runReadonlyQuery(fake, "SELECT * FROM users LIMIT 5000");
    expect(fake.seen[0]).toMatch(/LIMIT 1000/);
  });
});

// ── MysqlExecutorRegistry ────────────────────────────────────────────────────

describe("MysqlExecutorRegistry", () => {
  it("creates a pool once per handle and reuses it", () => {
    const calls: string[] = [];
    const factory = (handle: string) => {
      calls.push(handle);
      return { end: async () => {} } as any;
    };
    const reg = new MysqlExecutorRegistry({}, factory);
    const a = reg.getExecutor("acme:prod:users", sampleConfig);
    const b = reg.getExecutor("acme:prod:users", sampleConfig);
    expect(a).toBe(b);
    expect(calls).toEqual(["acme:prod:users"]);
  });

  it("throws when the handle is not in the registry", () => {
    const reg = new MysqlExecutorRegistry(
      {},
      () => ({ end: async () => {} }) as any,
    );
    expect(() => reg.getExecutor("acme:prod:missing", sampleConfig)).toThrow(
      /not found in mysql\.connections/,
    );
  });

  it("closeAll calls pool.end for every created pool", async () => {
    const ended: string[] = [];
    const factory = (handle: string) =>
      ({
        end: async () => {
          ended.push(handle);
        },
      }) as any;
    const reg = new MysqlExecutorRegistry({}, factory);
    reg.getExecutor("acme:prod:users", sampleConfig);
    reg.getExecutor("acme:prod:orders", {
      mysql: {
        connections: {
          acme: {
            prod: { orders: { dsnEnv: "MYSQL_ACME_PROD_ORDERS_DSN" } },
          },
        },
      },
    });
    await reg.closeAll();
    expect(ended.sort()).toEqual(["acme:prod:orders", "acme:prod:users"]);
  });
});

// ── describeHandle ──────────────────────────────────────────────────────────

describe("describeHandle", () => {
  it("returns surface metadata for passwordEnv profile, never the password", () => {
    const r = describeHandle("acme:prod:users", sampleConfig);
    expect(r.handle).toBe("acme:prod:users");
    expect(r.authMode).toBe("passwordEnv");
    expect(r.authEnv).toBe("MYSQL_ACME_PROD_USERS_PASSWORD");
    expect(r.hostName).toBe("db.acme.com");
    expect(r.user).toBe("readonly");
    // no secret field exposed.
    expect((r as any).password).toBeUndefined();
  });

  it("hides decomposed fields for dsnEnv profile", () => {
    const r = describeHandle("acme:prod:orders", sampleConfig);
    expect(r.authMode).toBe("dsnEnv");
    expect(r.authEnv).toBe("MYSQL_ACME_PROD_ORDERS_DSN");
    expect(r.hostName).toBe(null);
    expect(r.user).toBe(null);
    expect(r.database).toBe(null);
  });
});
