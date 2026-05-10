import { describe, it, expect } from "bun:test";
import {
  buildCombinedConfig,
  buildEphemeralSpec,
  ephemeralSpecName,
  flattenHandle,
  flattenRegistry,
  parseFlatHandle,
  registryToOpenApiMcpConfig,
} from "./adapter";
import type { OpenapiRegistry } from "../toolkit-config";

describe("flatten / parse handle", () => {
  it("round-trips host:env:spec via __ separator", () => {
    expect(flattenHandle("acme", "dev", "users")).toBe("acme__dev__users");
    expect(parseFlatHandle("acme__dev__users")).toEqual({
      host: "acme",
      env: "dev",
      spec: "users",
    });
  });
  it("rejects shapes that aren't exactly three parts", () => {
    expect(parseFlatHandle("acme__dev")).toBeNull();
    expect(parseFlatHandle("acme__dev__users__extra")).toBeNull();
  });
});

describe("registryToOpenApiMcpConfig", () => {
  it("flattens host:env:spec into specs.<host__env__spec>", () => {
    const reg: OpenapiRegistry = {
      acme: {
        dev: {
          users: "https://example.com/u.json",
          orders: { url: "https://example.com/o.json", baseUrl: "https://api.dev/o" },
        },
      },
    };
    const cfg = registryToOpenApiMcpConfig(reg);
    expect(Object.keys(cfg.specs).sort()).toEqual([
      "acme__dev__orders",
      "acme__dev__users",
    ]);
    expect(cfg.specs.acme__dev__users?.environments.default?.baseUrl).toBe("");
    expect(cfg.specs.acme__dev__orders?.environments.default?.baseUrl).toBe(
      "https://api.dev/o",
    );
  });

  it("returns empty specs map when registry is undefined", () => {
    expect(registryToOpenApiMcpConfig(undefined)).toEqual({ specs: {} });
  });
});

describe("ephemeral spec helpers", () => {
  it("ephemeralSpecName uses url__<sha1-16> shape", () => {
    const n = ephemeralSpecName("https://example.com/a.json");
    expect(n.startsWith("url__")).toBe(true);
    expect(n.length).toBe("url__".length + 16);
  });
  it("buildEphemeralSpec attaches an empty-baseUrl environment", () => {
    const { name, spec } = buildEphemeralSpec("https://example.com/a.json");
    expect(name.startsWith("url__")).toBe(true);
    expect(spec.environments.default?.baseUrl).toBe("");
  });
});

describe("buildCombinedConfig + flattenRegistry", () => {
  it("merges registry-derived specs with ad-hoc URL specs and dedupes URLs", () => {
    const reg: OpenapiRegistry = {
      acme: { dev: { u: "https://example.com/u.json" } },
    };
    const combined = buildCombinedConfig({
      registry: reg,
      ephemeralUrls: [
        "https://example.com/x.json",
        "https://example.com/x.json",
      ],
    });
    expect(Object.keys(combined.specs).length).toBe(2);
  });

  it("flattenRegistry includes baseUrl/format only when present", () => {
    const reg: OpenapiRegistry = {
      acme: {
        dev: {
          a: "https://example.com/a.json",
          b: { url: "https://example.com/b.json", baseUrl: "https://api/b", format: "swagger2" },
        },
      },
    };
    const rows = flattenRegistry(reg);
    const a = rows.find((r) => r.spec === "a");
    const b = rows.find((r) => r.spec === "b");
    expect(a?.baseUrl).toBeUndefined();
    expect(a?.format).toBeUndefined();
    expect(b?.baseUrl).toBe("https://api/b");
    expect(b?.format).toBe("swagger2");
  });
});
