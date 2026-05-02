import { describe, it, expect } from "bun:test";
import {
  isFullHandle,
  isScope,
  listRegistry,
  resolveHandle,
  resolveScopeToEntries,
} from "./mysql-registry";
import type { ToolkitConfig } from "./toolkit-config";

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
        dev: {
          users: { dsnEnv: "MYSQL_ACME_DEV_USERS_DSN" },
        },
      },
      beta: {
        prod: {
          users: { dsnEnv: "MYSQL_BETA_PROD_USERS_DSN" },
        },
      },
    },
  },
};

describe("isFullHandle / isScope", () => {
  it("recognises host:env:db handles", () => {
    expect(isFullHandle("acme:prod:users")).toBe(true);
    expect(isFullHandle("acme:prod")).toBe(false);
    expect(isFullHandle("acme")).toBe(false);
    expect(isFullHandle("a:b:c:d")).toBe(false);
  });

  it("recognises scopes", () => {
    expect(isScope("acme")).toBe(true);
    expect(isScope("acme:prod")).toBe(true);
    expect(isScope("acme:prod:users")).toBe(true);
    expect(isScope("")).toBe(false);
    expect(isScope("ac:me:prod:users")).toBe(false);
  });
});

describe("resolveHandle", () => {
  it("returns the profile for a registered handle", () => {
    const r = resolveHandle("acme:prod:users", sampleConfig.mysql?.connections);
    expect(r.host).toBe("acme");
    expect(r.env).toBe("prod");
    expect(r.db).toBe("users");
    expect(r.profile.passwordEnv).toBe("MYSQL_ACME_PROD_USERS_PASSWORD");
  });

  it("throws on malformed handle", () => {
    expect(() =>
      resolveHandle("acme:prod", sampleConfig.mysql?.connections),
    ).toThrow(/Not a host:env:db handle/);
  });

  it("throws on unregistered handle", () => {
    expect(() =>
      resolveHandle("acme:prod:missing", sampleConfig.mysql?.connections),
    ).toThrow(/not found in mysql\.connections/);
  });

  it("throws when connections is undefined", () => {
    expect(() => resolveHandle("acme:prod:users", undefined)).toThrow(
      /not found in mysql\.connections/,
    );
  });
});

describe("resolveScopeToEntries", () => {
  it("returns one entry for a full handle", () => {
    const out = resolveScopeToEntries("acme:prod:users", sampleConfig);
    expect(out.length).toBe(1);
    expect(out[0]?.handle).toBe("acme:prod:users");
    expect(out[0]?.authMode).toBe("passwordEnv");
  });

  it("returns all entries under host:env", () => {
    const out = resolveScopeToEntries("acme:prod", sampleConfig);
    expect(out.map((e) => e.handle).sort()).toEqual([
      "acme:prod:orders",
      "acme:prod:users",
    ]);
  });

  it("returns all entries under host", () => {
    const out = resolveScopeToEntries("acme", sampleConfig);
    expect(out.map((e) => e.handle).sort()).toEqual([
      "acme:dev:users",
      "acme:prod:orders",
      "acme:prod:users",
    ]);
  });

  it("returns [] when scope matches nothing", () => {
    expect(resolveScopeToEntries("nonexistent", sampleConfig)).toEqual([]);
    expect(resolveScopeToEntries("acme:nonexistent", sampleConfig)).toEqual([]);
    expect(
      resolveScopeToEntries("acme:prod:nonexistent", sampleConfig),
    ).toEqual([]);
  });

  it("returns [] when connections is missing", () => {
    expect(resolveScopeToEntries("acme:prod:users", {})).toEqual([]);
  });
});

describe("listRegistry", () => {
  it("flattens all profiles", () => {
    const out = listRegistry(sampleConfig);
    expect(out.length).toBe(4);
    const handles = out.map((e) => e.handle).sort();
    expect(handles).toEqual([
      "acme:dev:users",
      "acme:prod:orders",
      "acme:prod:users",
      "beta:prod:users",
    ]);
  });

  it("does not leak credential values, only env-var names", () => {
    const out = listRegistry(sampleConfig);
    for (const e of out) {
      expect(e.authEnv).toMatch(/^MYSQL_/);
      // 모든 entry 에 password / dsn 값이 있으면 안 된다 — 이름만.
      expect((e as any).password).toBeUndefined();
      expect((e as any).dsn).toBeUndefined();
    }
  });

  it("returns dsnEnv mode entries with hostName/user/database null", () => {
    const out = listRegistry(sampleConfig).find(
      (e) => e.handle === "acme:prod:orders",
    );
    expect(out?.authMode).toBe("dsnEnv");
    expect(out?.hostName).toBe(null);
    expect(out?.user).toBe(null);
    expect(out?.database).toBe(null);
  });

  it("returns passwordEnv mode entries with hostName / user / database surfaced", () => {
    const out = listRegistry(sampleConfig).find(
      (e) => e.handle === "acme:prod:users",
    );
    expect(out?.authMode).toBe("passwordEnv");
    expect(out?.hostName).toBe("db.acme.com");
    expect(out?.port).toBe(3306);
    expect(out?.user).toBe("readonly");
    expect(out?.database).toBe("app");
  });

  it("returns [] for empty config", () => {
    expect(listRegistry({})).toEqual([]);
  });
});
