import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NotionCache } from "../../lib/notion-context";
import { OpenapiCache } from "../../lib/openapi-context";
import agentToolkitPlugin, {
  handleNotionGet,
  handleNotionRefresh,
  handleNotionStatus,
  handleSwaggerGet,
  handleSwaggerRefresh,
  handleSwaggerSearch,
  handleSwaggerStatus,
} from "./agent-toolkit";

const PAGE = "1234abcd1234abcd1234abcd1234abcd";
const PAGE_DASHED = "1234abcd-1234-abcd-1234-abcd1234abcd";

let dir: string;
let cache: NotionCache;
let server: ReturnType<typeof Bun.serve>;
let calls: number;
let respondWithWrongId: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-"));
  cache = new NotionCache({ baseDir: dir, defaultTtlSeconds: 60 });
  calls = 0;
  respondWithWrongId = false;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/getPage" && req.method === "POST") {
        calls += 1;
        return Response.json({
          id: respondWithWrongId
            ? "deadbeefdeadbeefdeadbeefdeadbeef"
            : PAGE,
          title: "Hello",
          markdown: "# Hello\n\nworld",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.AGENT_TOOLKIT_NOTION_MCP_URL = `http://${server.hostname}:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  delete process.env.AGENT_TOOLKIT_NOTION_MCP_URL;
});

describe("plugin handlers", () => {
  it("notion_get: cache miss → write → second call hits cache", async () => {
    const first = await handleNotionGet(cache, PAGE);
    expect(first.fromCache).toBe(false);
    expect(first.entry.title).toBe("Hello");
    expect(first.entry.pageId).toBe(PAGE_DASHED);

    const second = await handleNotionGet(cache, PAGE);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("notion_refresh: ignores cache and re-fetches", async () => {
    await handleNotionGet(cache, PAGE);
    expect(calls).toBe(1);

    const r = await handleNotionRefresh(cache, PAGE);
    expect(r.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it("notion_status: reflects cache state", async () => {
    const before = await handleNotionStatus(cache, PAGE);
    expect(before.exists).toBe(false);

    await handleNotionGet(cache, PAGE);
    const after = await handleNotionStatus(cache, PAGE);
    expect(after.exists).toBe(true);
    expect(after.expired).toBe(false);
  });

  it("rejects remote response with mismatched page id and does not cache", async () => {
    respondWithWrongId = true;
    await expect(handleNotionGet(cache, PAGE)).rejects.toThrow(/wrong page/i);
    const s = await handleNotionStatus(cache, PAGE);
    expect(s.exists).toBe(false);
  });
});

describe("swagger handlers", () => {
  let oaDir: string;
  let oaCache: OpenapiCache;
  let oaServer: ReturnType<typeof Bun.serve>;
  let oaCalls: number;
  let respondMalformed: boolean;

  const SAMPLE_SPEC = {
    openapi: "3.0.0",
    info: { title: "Sample", version: "1.0.0" },
    paths: {
      "/pets": {
        get: { operationId: "listPets", summary: "List pets", tags: ["pet"] },
        post: { operationId: "createPet", summary: "Create pet", tags: ["pet"] },
      },
      "/users/{id}": {
        get: { operationId: "getUser", summary: "Fetch user", tags: ["user"] },
      },
    },
  };

  let baseUrl: string;

  beforeEach(() => {
    oaDir = mkdtempSync(join(tmpdir(), "plugin-oa-"));
    oaCache = new OpenapiCache({ baseDir: oaDir, defaultTtlSeconds: 60 });
    oaCalls = 0;
    respondMalformed = false;
    oaServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/spec.json" && req.method === "GET") {
          oaCalls += 1;
          if (respondMalformed) {
            return Response.json({ info: {}, paths: {} });
          }
          return Response.json(SAMPLE_SPEC);
        }
        if (url.pathname === "/other.json" && req.method === "GET") {
          oaCalls += 1;
          return Response.json({
            openapi: "3.0.0",
            info: { title: "Other", version: "0.1.0" },
            paths: { "/health": { get: { operationId: "health" } } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://${oaServer.hostname}:${oaServer.port}`;
  });

  afterEach(() => {
    oaServer.stop(true);
  });

  it("swagger_get: cache miss → write → second call hits cache", async () => {
    const url = `${baseUrl}/spec.json`;
    const first = await handleSwaggerGet(oaCache, url);
    expect(first.fromCache).toBe(false);
    expect(first.entry.title).toBe("Sample");
    expect(first.entry.endpointCount).toBe(3);

    const second = await handleSwaggerGet(oaCache, url);
    expect(second.fromCache).toBe(true);
    expect(oaCalls).toBe(1);
  });

  it("swagger_refresh: ignores cache and re-fetches", async () => {
    const url = `${baseUrl}/spec.json`;
    await handleSwaggerGet(oaCache, url);
    expect(oaCalls).toBe(1);

    const r = await handleSwaggerRefresh(oaCache, url);
    expect(r.fromCache).toBe(false);
    expect(oaCalls).toBe(2);
  });

  it("swagger_status: reflects cache state", async () => {
    const url = `${baseUrl}/spec.json`;
    const before = await handleSwaggerStatus(oaCache, url);
    expect(before.exists).toBe(false);

    await handleSwaggerGet(oaCache, url);
    const after = await handleSwaggerStatus(oaCache, url);
    expect(after.exists).toBe(true);
    expect(after.expired).toBe(false);
    expect(after.title).toBe("Sample");
  });

  it("rejects spec missing both openapi and swagger fields", async () => {
    respondMalformed = true;
    const url = `${baseUrl}/spec.json`;
    await expect(handleSwaggerGet(oaCache, url)).rejects.toThrow(
      /openapi.*swagger/i,
    );
    const s = await handleSwaggerStatus(oaCache, url);
    expect(s.exists).toBe(false);
  });

  it("swagger_search spans every cached spec", async () => {
    await handleSwaggerGet(oaCache, `${baseUrl}/spec.json`);
    await handleSwaggerGet(oaCache, `${baseUrl}/other.json`);

    const pets = await handleSwaggerSearch(oaCache, "pet");
    expect(pets.length).toBe(2);
    expect(pets.every((p) => p.path === "/pets")).toBe(true);
    expect(pets.map((p) => p.method).sort()).toEqual(["GET", "POST"]);

    const health = await handleSwaggerSearch(oaCache, "health");
    expect(health.length).toBe(1);
    expect(health[0]?.specTitle).toBe("Other");
    expect(health[0]?.path).toBe("/health");

    const all = await handleSwaggerSearch(oaCache, "");
    expect(all.length).toBe(4);

    const limited = await handleSwaggerSearch(oaCache, "", 2);
    expect(limited.length).toBe(2);
  });
});

describe("plugin config hook", () => {
  it("registers skills/, agents/, and agent/ paths and is idempotent", async () => {
    const plugin = await agentToolkitPlugin({});
    const cfg: any = {};
    plugin.config(cfg);
    plugin.config(cfg);

    // basename 비교로 cross-platform (Windows `\\` 도 안전).
    const expectPath = (key: string, leaf: string) => {
      expect(cfg[key]).toBeDefined();
      expect(Array.isArray(cfg[key].paths)).toBe(true);
      const matches = cfg[key].paths.filter((p: string) => basename(p) === leaf);
      expect(matches.length).toBe(1);
    };

    expectPath("skills", "skills");
    expectPath("agents", "agents");
    expectPath("agent", "agents");
  });

  it("preserves existing paths in config", async () => {
    const plugin = await agentToolkitPlugin({});
    const cfg: any = {
      skills: { paths: ["/pre-existing/skills"] },
      agents: { paths: ["/pre-existing/agents"] },
    };
    plugin.config(cfg);
    expect(cfg.skills.paths).toContain("/pre-existing/skills");
    expect(cfg.agents.paths).toContain("/pre-existing/agents");
  });
});
