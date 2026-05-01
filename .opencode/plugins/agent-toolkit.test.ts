import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NotionCache } from "../../lib/notion-context";
import { OpenapiCache } from "../../lib/openapi-context";
import type { OpenapiRegistry } from "../../lib/toolkit-config";
import { AgentJournal } from "../../lib/agent-journal";
import { epicMarker, subMarker } from "../../lib/github-issue-sync";
import agentToolkitPlugin, {
  handleIssueCreateFromSpec,
  handleIssueStatus,
  handleJournalAppend,
  handleJournalRead,
  handleJournalSearch,
  handleJournalStatus,
  handleNotionGet,
  handleNotionRefresh,
  handleNotionStatus,
  handleSwaggerEnvs,
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

  it("swagger_get with a 16-hex key recovers the spec URL via meta and refetches", async () => {
    const url = `${baseUrl}/spec.json`;
    const first = await handleSwaggerGet(oaCache, url);
    expect(first.fromCache).toBe(false);

    // 본문만 날리고 메타 유지 → 캐시 miss 지만 specUrl 은 복구 가능.
    const { rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    rmSync(join(oaDir, `${first.entry.key}.spec.json`));

    const recovered = await handleSwaggerGet(oaCache, first.entry.key);
    expect(recovered.fromCache).toBe(false);
    expect(recovered.entry.specUrl).toBe(url);
    expect(oaCalls).toBe(2);
  });

  it("swagger_get with a 16-hex key throws clearly when meta is also gone", async () => {
    const url = `${baseUrl}/spec.json`;
    const first = await handleSwaggerGet(oaCache, url);
    const { rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    rmSync(join(oaDir, `${first.entry.key}.spec.json`));
    rmSync(join(oaDir, `${first.entry.key}.json`));

    await expect(handleSwaggerGet(oaCache, first.entry.key)).rejects.toThrow(
      /no recoverable spec URL/i,
    );
  });

  it("swagger_status returns endpointCount on cache hit", async () => {
    const url = `${baseUrl}/spec.json`;
    await handleSwaggerGet(oaCache, url);
    const s = await handleSwaggerStatus(oaCache, url);
    expect(s.endpointCount).toBe(3);
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

    const limited = await handleSwaggerSearch(oaCache, "", { limit: 2 });
    expect(limited.length).toBe(2);
  });
});

describe("swagger handlers — registry handles", () => {
  let oaDir: string;
  let oaCache: OpenapiCache;
  let oaServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let registry: OpenapiRegistry;

  const SAMPLE = (title: string) => ({
    openapi: "3.0.0",
    info: { title, version: "1.0.0" },
    paths: {
      "/pets": {
        get: { operationId: `${title}-listPets`, summary: "List", tags: ["pet"] },
      },
    },
  });

  beforeEach(() => {
    oaDir = mkdtempSync(join(tmpdir(), "plugin-oa-reg-"));
    oaCache = new OpenapiCache({ baseDir: oaDir, defaultTtlSeconds: 60 });
    oaServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/dev/users.json") return Response.json(SAMPLE("dev-users"));
        if (u.pathname === "/dev/orders.json") return Response.json(SAMPLE("dev-orders"));
        if (u.pathname === "/prod/users.json") return Response.json(SAMPLE("prod-users"));
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://${oaServer.hostname}:${oaServer.port}`;
    registry = {
      acme: {
        dev: {
          users: `${baseUrl}/dev/users.json`,
          orders: `${baseUrl}/dev/orders.json`,
        },
        prod: {
          users: `${baseUrl}/prod/users.json`,
        },
      },
    };
  });

  afterEach(() => {
    oaServer.stop(true);
  });

  it("swagger_get accepts a host:env:spec handle and resolves via registry", async () => {
    const r = await handleSwaggerGet(oaCache, "acme:dev:users", registry);
    expect(r.fromCache).toBe(false);
    expect(r.entry.title).toBe("dev-users");
    // 캐시에 같은 URL 로 박혀 있어야 — handle 이 아니라.
    const status = await handleSwaggerStatus(oaCache, `${baseUrl}/dev/users.json`);
    expect(status.exists).toBe(true);
  });

  it("swagger_get throws on unregistered handle", async () => {
    await expect(
      handleSwaggerGet(oaCache, "acme:dev:missing", registry),
    ).rejects.toThrow(/acme:dev:missing/);
  });

  it("swagger_search scope=host:env limits the search to that env", async () => {
    await handleSwaggerGet(oaCache, "acme:dev:users", registry);
    await handleSwaggerGet(oaCache, "acme:dev:orders", registry);
    await handleSwaggerGet(oaCache, "acme:prod:users", registry);

    const dev = await handleSwaggerSearch(
      oaCache,
      "pet",
      { scope: "acme:dev" },
      registry,
    );
    expect(dev.length).toBe(2);
    expect(dev.every((m) => m.specTitle.startsWith("dev-"))).toBe(true);

    const prod = await handleSwaggerSearch(
      oaCache,
      "pet",
      { scope: "acme:prod" },
      registry,
    );
    expect(prod.length).toBe(1);
    expect(prod[0]?.specTitle).toBe("prod-users");
  });

  it("swagger_search throws on unknown scope", async () => {
    await handleSwaggerGet(oaCache, "acme:dev:users", registry);
    await expect(
      handleSwaggerSearch(oaCache, "pet", { scope: "nope" }, registry),
    ).rejects.toThrow(/scope.*nope/i);
  });

  it("swagger_envs returns the flat registry list", () => {
    const flat = handleSwaggerEnvs({ openapi: { registry } });
    expect(flat.length).toBe(3);
    const names = flat.map((e) => `${e.host}:${e.env}:${e.spec}`).sort();
    expect(names).toEqual(["acme:dev:orders", "acme:dev:users", "acme:prod:users"]);
  });

  it("swagger_envs returns [] for empty config", () => {
    expect(handleSwaggerEnvs({})).toEqual([]);
  });
});

describe("journal handlers", () => {
  let jDir: string;
  let journal: AgentJournal;

  beforeEach(() => {
    jDir = mkdtempSync(join(tmpdir(), "plugin-journal-"));
    journal = new AgentJournal({ baseDir: jDir });
  });

  it("journal_append: writes a normalized entry", async () => {
    const entry = await handleJournalAppend(journal, {
      content: "decided to ship phase 3",
      kind: "decision",
      tags: ["phase3"],
    });
    expect(entry.kind).toBe("decision");
    expect(entry.tags).toEqual(["phase3"]);
    expect(entry.content).toBe("decided to ship phase 3");
  });

  it("journal_read: returns most recent first across turns", async () => {
    await handleJournalAppend(journal, { content: "turn-1 decision", kind: "decision" });
    await handleJournalAppend(journal, { content: "turn-2 blocker", kind: "blocker" });
    // 시뮬레이션: 다음 turn 에서 새 인스턴스로 읽기.
    const next = new AgentJournal({ baseDir: jDir });
    const r = await handleJournalRead(next);
    expect(r.length).toBe(2);
    expect(r[0]?.content).toBe("turn-2 blocker");
    expect(r[1]?.content).toBe("turn-1 decision");
  });

  it("journal_read: kind filter narrows the result", async () => {
    await handleJournalAppend(journal, { content: "a", kind: "decision" });
    await handleJournalAppend(journal, { content: "b", kind: "blocker" });
    const r = await handleJournalRead(journal, { kind: "decision" });
    expect(r.length).toBe(1);
    expect(r[0]?.content).toBe("a");
  });

  it("journal_search: matches across content and tags", async () => {
    await handleJournalAppend(journal, { content: "use Bun for runtime", tags: ["infra"] });
    await handleJournalAppend(journal, { content: "auth blocker", kind: "blocker" });
    expect((await handleJournalSearch(journal, "bun")).length).toBe(1);
    expect((await handleJournalSearch(journal, "infra")).length).toBe(1);
    expect((await handleJournalSearch(journal, "MISSING")).length).toBe(0);
  });

  it("journal_status: reflects journal state", async () => {
    const before = await handleJournalStatus(journal);
    expect(before.exists).toBe(false);
    expect(before.totalEntries).toBe(0);

    const last = await handleJournalAppend(journal, { content: "first" });
    const after = await handleJournalStatus(journal);
    expect(after.exists).toBe(true);
    expect(after.totalEntries).toBe(1);
    expect(after.lastEntryAt).toBe(last.timestamp);
  });
});

describe("issue handlers", () => {
  let projectRoot: string;
  let specDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let issues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: string;
  }>;
  let nextNumber: number;
  let createCalls: number;

  const SPEC_BODY = `---
slug: "user-auth"
spec_pact_version: 1
source_page_id: "1234abcd-1234-abcd-1234-abcd1234abcd"
source_url: "https://www.notion.so/team/Auth-1234abcd1234abcd1234abcd1234abcd"
status: "locked"
---

# 요약
사용자 인증 합의안.

# 합의 TODO
- 로그인 폼 컴포넌트
- POST /auth/login 호출 클라이언트
`;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "issue-plugin-"));
    specDir = ".agent/specs";
    mkdirSync(join(projectRoot, specDir), { recursive: true });
    writeFileSync(join(projectRoot, specDir, "user-auth.md"), SPEC_BODY, "utf8");

    issues = [];
    nextNumber = 100;
    createCalls = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (
          url.pathname === "/repos/acme/widgets/issues" &&
          req.method === "GET"
        ) {
          return Response.json(
            issues.map((i) => ({
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              html_url: `${baseUrl}/issue/${i.number}`,
            })),
          );
        }
        if (
          url.pathname === "/repos/acme/widgets/issues" &&
          req.method === "POST"
        ) {
          createCalls += 1;
          return req.json().then((parsed: any) => {
            const num = nextNumber;
            nextNumber += 1;
            const item = {
              number: num,
              title: parsed.title ?? "",
              body: parsed.body ?? "",
              labels: Array.isArray(parsed.labels) ? parsed.labels : [],
              state: "open",
            };
            issues.push(item);
            return Response.json({
              number: item.number,
              title: item.title,
              body: item.body,
              state: item.state,
              html_url: `${baseUrl}/issue/${item.number}`,
            });
          });
        }
        const patchMatch = url.pathname.match(
          /^\/repos\/acme\/widgets\/issues\/(\d+)$/,
        );
        if (patchMatch && req.method === "PATCH") {
          const n = Number.parseInt(patchMatch[1]!, 10);
          return req.json().then((parsed: any) => {
            const found = issues.find((i) => i.number === n);
            if (!found) return new Response("not found", { status: 404 });
            if (typeof parsed.body === "string") found.body = parsed.body;
            return Response.json({
              number: found.number,
              title: found.title,
              body: found.body,
              state: found.state,
              html_url: `${baseUrl}/issue/${found.number}`,
            });
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
  });

  function ctx(overrides: Partial<{ token: string; defaultRepo: string }> = {}) {
    return {
      projectRoot,
      specDir,
      defaultRepo: overrides.defaultRepo ?? "acme/widgets",
      apiBaseUrl: baseUrl,
      defaultLabels: ["spec-pact"],
      token: overrides.token ?? "ghp_test",
    };
  }

  it("issue_create_from_spec: creates epic + subs from a slug, idempotent on re-run", async () => {
    const first = await handleIssueCreateFromSpec(ctx(), {
      slug: "user-auth",
    });
    expect(first.applied).toBe(true);
    expect(first.epic.existed).toBe(false);
    expect(first.subs.length).toBe(2);
    expect(first.subs.every((s) => !s.existed)).toBe(true);
    // sub 2 + epic 1
    expect(createCalls).toBe(3);

    const second = await handleIssueCreateFromSpec(ctx(), {
      slug: "user-auth",
    });
    expect(second.applied).toBe(true);
    expect(createCalls).toBe(3);
    expect(second.epic.existed).toBe(true);
    expect(second.subs.every((s) => s.existed)).toBe(true);
  });

  it("issue_create_from_spec: dryRun makes no remote write but still matches existing", async () => {
    issues.push({
      number: 1,
      title: "[spec] user-auth v1",
      body: `seeded\n${epicMarker("user-auth")}\n`,
      labels: ["spec-pact"],
      state: "open",
    });
    issues.push({
      number: 2,
      title: "[user-auth] 로그인 폼 컴포넌트",
      body: `seeded\n${subMarker("user-auth", 0)}\n`,
      labels: ["spec-pact"],
      state: "closed",
    });
    const r = await handleIssueCreateFromSpec(ctx(), {
      slug: "user-auth",
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(createCalls).toBe(0);
    expect(r.epic.existed).toBe(true);
    expect(r.subs[0]?.existed).toBe(true);
    expect(r.subs[1]?.existed).toBe(false);
  });

  it("issue_status: equivalent to dryRun and never creates issues", async () => {
    const r = await handleIssueStatus(ctx(), { slug: "user-auth" });
    expect(r.applied).toBe(false);
    expect(createCalls).toBe(0);
    expect(r.epic.existed).toBe(false);
    expect(r.subs.every((s) => !s.existed)).toBe(true);
  });

  it("throws clearly when token is missing", async () => {
    await expect(
      handleIssueCreateFromSpec(ctx({ token: "" }), { slug: "user-auth" }),
    ).rejects.toThrow(/AGENT_TOOLKIT_GITHUB_TOKEN/);
  });

  it("throws clearly when repo is missing from both ctx and input", async () => {
    await expect(
      handleIssueCreateFromSpec(ctx({ defaultRepo: "" }), {
        slug: "user-auth",
      }),
    ).rejects.toThrow(/owner\/repo/);
  });

  it("path input bypasses slug resolution and reads the SPEC verbatim", async () => {
    const dirPath = join(projectRoot, "apps", "web", "orders");
    mkdirSync(dirPath, { recursive: true });
    const directorySpec = `---
slug: "orders-flow"
spec_pact_version: 2
---

# 요약
주문 흐름 합의안.

# 합의 TODO
- 결제 완료 콜백
`;
    writeFileSync(join(dirPath, "SPEC.md"), directorySpec, "utf8");
    const r = await handleIssueCreateFromSpec(ctx(), {
      path: "apps/web/orders/SPEC.md",
    });
    expect(r.slug).toBe("orders-flow");
    expect(r.subs.length).toBe(1);
    expect(r.subs[0]?.title).toContain("결제 완료 콜백");
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
