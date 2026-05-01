import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenapiCache,
  resolveSpecKey,
  searchEndpoints,
  countEndpoints,
  assertOpenapiShape,
  specHash,
  type OpenapiSpec,
} from "./openapi-context";

const SPEC_URL = "https://example.com/openapi.json";

/** 최소 OpenAPI 3 doc — paths 두 개, method 세 개, tag/operationId 다양. */
const SAMPLE_SPEC: OpenapiSpec = {
  openapi: "3.0.0",
  info: { title: "Sample", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        tags: ["pet"],
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        tags: ["pet"],
      },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Fetch user by id",
        tags: ["user"],
      },
    },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-toolkit-openapi-"));
});

describe("resolveSpecKey", () => {
  it("hashes a URL to a 16-hex key and reports isKeyInput=false", () => {
    const r = resolveSpecKey(SPEC_URL);
    expect(r.key).toMatch(/^[0-9a-f]{16}$/);
    expect(r.isKeyInput).toBe(false);
  });

  it("treats an already-normalized 16-hex input as the key itself with isKeyInput=true", () => {
    const { key } = resolveSpecKey(SPEC_URL);
    const r = resolveSpecKey(key);
    expect(r.key).toBe(key);
    expect(r.isKeyInput).toBe(true);
  });

  it("rejects empty / whitespace input", () => {
    expect(() => resolveSpecKey("")).toThrow();
    expect(() => resolveSpecKey("   ")).toThrow();
  });
});

describe("countEndpoints", () => {
  it("counts (path × method) pairs", () => {
    expect(countEndpoints(SAMPLE_SPEC)).toBe(3);
  });

  it("returns 0 for malformed spec", () => {
    expect(countEndpoints({} as OpenapiSpec)).toBe(0);
    expect(countEndpoints({ paths: null } as unknown as OpenapiSpec)).toBe(0);
  });
});

describe("searchEndpoints", () => {
  it("matches by path substring", () => {
    const r = searchEndpoints(SAMPLE_SPEC, "/pets");
    expect(r.length).toBe(2);
    expect(r.map((e) => e.method).sort()).toEqual(["GET", "POST"]);
  });

  it("matches by tag", () => {
    const r = searchEndpoints(SAMPLE_SPEC, "user");
    expect(r.length).toBe(1);
    expect(r[0]?.path).toBe("/users/{id}");
  });

  it("matches by operationId", () => {
    const r = searchEndpoints(SAMPLE_SPEC, "createPet");
    expect(r.length).toBe(1);
    expect(r[0]?.method).toBe("POST");
  });

  it("matches by summary substring", () => {
    const r = searchEndpoints(SAMPLE_SPEC, "fetch user");
    expect(r.length).toBe(1);
    expect(r[0]?.operationId).toBe("getUser");
  });

  it("empty query returns all up to limit", () => {
    expect(searchEndpoints(SAMPLE_SPEC, "").length).toBe(3);
    expect(searchEndpoints(SAMPLE_SPEC, "", 2).length).toBe(2);
  });
});

describe("assertOpenapiShape", () => {
  it("accepts OpenAPI 3.x", () => {
    expect(() =>
      assertOpenapiShape({ openapi: "3.0.0", info: {}, paths: {} }),
    ).not.toThrow();
  });
  it("accepts swagger 2.x", () => {
    expect(() =>
      assertOpenapiShape({ swagger: "2.0", info: {}, paths: {} }),
    ).not.toThrow();
  });
  it("rejects payload missing both fields", () => {
    expect(() => assertOpenapiShape({ info: {}, paths: {} })).toThrow(
      /openapi.*swagger/i,
    );
  });
  it("rejects non-object payload", () => {
    expect(() => assertOpenapiShape("string")).toThrow();
    expect(() => assertOpenapiShape(null)).toThrow();
  });
});

describe("OpenapiCache", () => {
  it("returns null for missing specs", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    expect(await cache.read(SPEC_URL)).toBeNull();
  });

  it("writes and reads back, with stable specHash and derived metadata", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    expect(w.entry.title).toBe("Sample");
    expect(w.entry.version).toBe("1.0.0");
    expect(w.entry.openapi).toBe("3.0.0");
    expect(w.entry.endpointCount).toBe(3);

    const r = await cache.read(SPEC_URL);
    expect(r?.entry.specHash).toBe(w.entry.specHash);
    expect(r?.spec.paths?.["/pets"]?.get?.operationId).toBe("listPets");

    // 같은 본문을 다시 쓰면 specHash 가 같아야 한다.
    const reHash = specHash(`${JSON.stringify(SAMPLE_SPEC, null, 2)}\n`);
    expect(r?.entry.specHash).toBe(reHash);
  });

  it("treats expired entries as miss but still reports them via status", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    await cache.write(SPEC_URL, SAMPLE_SPEC);
    expect(await cache.invalidate(SPEC_URL)).toBe(true);
    expect(await cache.read(SPEC_URL)).toBeNull();
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(true);
    expect(s.expired).toBe(true);
  });

  it("status reports exists=false when only meta exists (missing .spec.json)", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    rmSync(join(dir, `${w.entry.key}.spec.json`));
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(false);
    expect(await cache.read(SPEC_URL)).toBeNull();
  });

  it("status reports exists=false when only .spec.json exists (missing meta)", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    rmSync(join(dir, `${w.entry.key}.json`));
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(false);
  });

  it("treats corrupt meta as miss without throwing", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    writeFileSync(join(dir, `${w.entry.key}.json`), "{ not json", "utf8");
    expect(await cache.read(SPEC_URL)).toBeNull();
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(false);
  });

  it("write rejects payload missing both openapi and swagger fields", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    await expect(
      cache.write(SPEC_URL, { info: {}, paths: {} } as OpenapiSpec),
    ).rejects.toThrow(/openapi.*swagger/i);
  });

  it("write rejects 16-hex cache key input (URL required)", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    await expect(cache.write(w.entry.key, SAMPLE_SPEC)).rejects.toThrow(
      /requires a spec URL/i,
    );
  });

  it("status includes endpointCount for cache hits", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    await cache.write(SPEC_URL, SAMPLE_SPEC);
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(true);
    expect(s.endpointCount).toBe(3);
  });

  it("status omits endpointCount for cache miss", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const s = await cache.status(SPEC_URL);
    expect(s.exists).toBe(false);
    expect(s.endpointCount).toBeUndefined();
  });

  it("peekSpecUrl recovers original URL even after .spec.json is removed", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    rmSync(join(dir, `${w.entry.key}.spec.json`));
    // status now reports miss, but the meta is still on disk.
    expect((await cache.status(SPEC_URL)).exists).toBe(false);
    expect(await cache.peekSpecUrl(SPEC_URL)).toBe(SPEC_URL);
    expect(await cache.peekSpecUrl(w.entry.key)).toBe(SPEC_URL);
  });

  it("peekSpecUrl returns null when the meta file is gone", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    rmSync(join(dir, `${w.entry.key}.json`));
    expect(await cache.peekSpecUrl(SPEC_URL)).toBeNull();
  });

  it("list returns all unexpired (entry, spec) pairs across the cache dir", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    await cache.write("https://a.example.com/spec.json", SAMPLE_SPEC);
    await cache.write("https://b.example.com/spec.json", {
      openapi: "3.0.0",
      info: { title: "B", version: "2.0.0" },
      paths: { "/health": { get: { operationId: "health" } } },
    });
    const all = await cache.list();
    expect(all.length).toBe(2);
    const titles = all.map((r) => r.entry.title).sort();
    expect(titles).toEqual(["B", "Sample"]);
  });

  it("list skips entries whose .spec.json is missing", async () => {
    const cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const w = await cache.write(SPEC_URL, SAMPLE_SPEC);
    rmSync(join(dir, `${w.entry.key}.spec.json`));
    const all = await cache.list();
    expect(all.length).toBe(0);
  });
});
