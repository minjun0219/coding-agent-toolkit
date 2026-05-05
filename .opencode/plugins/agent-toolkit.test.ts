import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NotionCache } from "../../lib/notion-context";
import { OpenapiCache } from "../../lib/openapi-context";
import type { OpenapiRegistry } from "../../lib/toolkit-config";
import { AgentJournal } from "../../lib/agent-journal";
import type { FieldPacket, RowDataPacket } from "mysql2/promise";
import type { GhExecResult, GhExecutor } from "../../lib/gh-cli";
import agentToolkitPlugin, {
  handleGhRun,
  handleIssueCreateFromSpec,
  handleIssueStatus,
  handleJournalAppend,
  handleJournalRead,
  handleJournalSearch,
  handleJournalStatus,
  handleMysqlEnvs,
  handleMysqlQuery,
  handleMysqlSchema,
  handleMysqlStatus,
  handleMysqlTables,
  handleNotionGet,
  handleNotionExtract,
  handleNotionRefresh,
  handleNotionStatus,
  handlePrEventPending,
  handlePrEventRecord,
  handlePrEventResolve,
  handlePrWatchStart,
  handlePrWatchStatus,
  handlePrWatchStop,
  handleSwaggerEnvs,
  handleSwaggerGet,
  handleSwaggerRefresh,
  handleSwaggerSearch,
  handleSwaggerStatus,
} from "./agent-toolkit";
import {
  MysqlExecutorRegistry,
  type MysqlExecutor,
} from "../../lib/mysql-context";
import type { ToolkitConfig } from "../../lib/toolkit-config";

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
          id: respondWithWrongId ? "deadbeefdeadbeefdeadbeefdeadbeef" : PAGE,
          title: "Hello",
          markdown:
            "# Hello\n\nworld\n\n## TODO\n\n- [ ] 주문 목록 API 연동\n\n## API\n\n- GET /api/orders",
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

  it("notion_extract: returns chunks and extracted action candidates", async () => {
    const result = await handleNotionExtract(cache, PAGE, {
      maxCharsPerChunk: 200,
    });
    expect(result.fromCache).toBe(false);
    expect(result.entry.pageId).toBe(PAGE_DASHED);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.chunks[0]?.id).toBe("chunk-001");
    expect("text" in (result.chunks[0] ?? {})).toBe(false);
    expect(
      result.extracted.todos.some((x) => x.text.includes("주문 목록 API 연동")),
    ).toBe(true);
    expect(
      result.extracted.apis.some((x) => x.text === "GET /api/orders"),
    ).toBe(true);

    const second = await handleNotionExtract(cache, PAGE);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
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
        post: {
          operationId: "createPet",
          summary: "Create pet",
          tags: ["pet"],
        },
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
        if (url.pathname === "/spec.yaml" && req.method === "GET") {
          oaCalls += 1;
          return new Response("openapi: 3.0.0\ninfo:\n  title: YAML\n", {
            headers: { "content-type": "application/yaml" },
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

  it("rejects YAML specs because only JSON OpenAPI documents are supported", async () => {
    const url = `${baseUrl}/spec.yaml`;
    await expect(handleSwaggerGet(oaCache, url)).rejects.toThrow(
      /non-JSON body/i,
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
        get: {
          operationId: `${title}-listPets`,
          summary: "List",
          tags: ["pet"],
        },
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
        if (u.pathname === "/dev/users.json")
          return Response.json(SAMPLE("dev-users"));
        if (u.pathname === "/dev/orders.json")
          return Response.json(SAMPLE("dev-orders"));
        if (u.pathname === "/prod/users.json")
          return Response.json(SAMPLE("prod-users"));
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
    const status = await handleSwaggerStatus(
      oaCache,
      `${baseUrl}/dev/users.json`,
    );
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
    expect(names).toEqual([
      "acme:dev:orders",
      "acme:dev:users",
      "acme:prod:users",
    ]);
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
    await handleJournalAppend(journal, {
      content: "turn-1 decision",
      kind: "decision",
    });
    await handleJournalAppend(journal, {
      content: "turn-2 blocker",
      kind: "blocker",
    });
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
    await handleJournalAppend(journal, {
      content: "use Bun for runtime",
      tags: ["infra"],
    });
    await handleJournalAppend(journal, {
      content: "auth blocker",
      kind: "blocker",
    });
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

// ── PR review watch handlers ────────────────────────────────────────────────

describe("pr-watch handlers", () => {
  let prDir: string;
  let prJournal: AgentJournal;
  const HANDLE = "minjun0219/agent-toolkit#42";

  beforeEach(() => {
    prDir = mkdtempSync(join(tmpdir(), "plugin-pr-watch-"));
    prJournal = new AgentJournal({ baseDir: prDir });
  });

  it("pr_watch_start: writes a pr_watch_start entry and returns active state", async () => {
    const r = await handlePrWatchStart(prJournal, {
      handle: HANDLE,
      note: "review 1차",
    });
    expect(r.entry.kind).toBe("pr_watch_start");
    expect(r.entry.tags[0]).toBe("pr-watch");
    expect(r.entry.tags).toContain("pr:minjun0219/agent-toolkit#42");
    expect(r.state.active).toBe(true);
    expect(r.state.handle.canonical).toBe("minjun0219/agent-toolkit#42");
  });

  it("pr_watch_start: rejects malformed handles", async () => {
    await expect(
      handlePrWatchStart(prJournal, { handle: "not-a-pr" }),
    ).rejects.toThrow(/cannot parse/);
  });

  it("pr_watch_status: aggregates active watches and pending counts", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "typo on /api/orders",
    });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "2",
      summary: "missing await",
    });
    await handlePrEventResolve(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      decision: "accepted",
      reasoning: "fixed",
    });
    const status = await handlePrWatchStatus(prJournal);
    expect(status.totals.active).toBe(1);
    expect(status.totals.pending).toBe(1);
    expect(status.active.length).toBe(1);
    expect(status.active[0]?.handle.canonical).toBe(HANDLE);
  });

  it("pr_watch_stop: flips state to inactive and removes from status", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    const stop = await handlePrWatchStop(prJournal, {
      handle: HANDLE,
      reason: "merged",
    });
    expect(stop.state.active).toBe(false);
    expect(stop.entry.kind).toBe("pr_watch_stop");
    expect(stop.entry.tags).toContain("reason:merged");
    const status = await handlePrWatchStatus(prJournal);
    expect(status.totals.active).toBe(0);
  });

  it("pr_watch_stop: rejects reason outside merged / closed / manual", async () => {
    // 자유 문자열을 막아야 `journal_read({ tag: "reason:merged" })` 같은 회수 / 집계가
    // 안정적으로 동작한다 — handler 단에서 enum 으로 끊는다.
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await expect(
      handlePrWatchStop(prJournal, { handle: HANDLE, reason: "wontfix" }),
    ).rejects.toThrow(/reason must be one of/);
    // 그래도 stop 이 박히지 않았으니 여전히 active.
    const status = await handlePrWatchStatus(prJournal);
    expect(status.totals.active).toBe(1);
  });

  it("pr_watch_stop: accepts the three valid stop reasons", async () => {
    for (const reason of ["merged", "closed", "manual"] as const) {
      await handlePrWatchStart(prJournal, { handle: HANDLE });
      const stop = await handlePrWatchStop(prJournal, {
        handle: HANDLE,
        reason,
      });
      expect(stop.entry.tags).toContain(`reason:${reason}`);
    }
  });

  it("pr_watch_status: tolerates a journal padded with non-pr-watch entries (tag-filtered read)", async () => {
    // 이전엔 readAllJournalEntries() 가 모든 종류 entry 를 5000 까지만 읽어 PR 항목이
    // 다른 도메인 (decision/blocker/spec_anchor 등) 에 밀려 잘려 나갈 수 있었다 — 이제는
    // tag: "pr-watch" 로 좁혀 읽으므로 다른 도메인 entry 가 아무리 많아도 PR 라이프사이클
    // 정확성은 유지된다. 100건의 무관한 entry 사이에 watch_start 한 건이 살아있는지 확인.
    await prJournal.append({ content: "first watch", kind: "decision" });
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    for (let i = 0; i < 100; i += 1) {
      await prJournal.append({
        content: `noise ${i}`,
        kind: "note",
        tags: ["unrelated"],
      });
    }
    const status = await handlePrWatchStatus(prJournal);
    expect(status.totals.active).toBe(1);
    expect(status.active[0]?.handle.canonical).toBe(HANDLE);
  });

  it("pr_event_record: marks alreadySeen=true on duplicate (handle, type, externalId)", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    const first = await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "first",
    });
    expect(first.alreadySeen).toBe(false);
    expect(first.ref.toolkitKey).toBe("c:1");
    const second = await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "second poll same comment",
    });
    expect(second.alreadySeen).toBe(true);
    // pending 은 여전히 1개 — dedupe 는 reduce 에서.
    const pending = await handlePrEventPending(prJournal, HANDLE);
    expect(pending.length).toBe(1);
  });

  it("pr_event_record: still alreadySeen=true after the event was resolved (re-poll guard)", async () => {
    // GitHub list-comments 류는 과거 항목을 매 호출마다 반환한다 — pending 만 보면 resolve 된
    // 코멘트가 다시 새 이벤트처럼 보이고 mindy 가 같은 답글을 두 번 달 위험. alreadySeen 은
    // resolved 여부와 무관하게 "과거 inbound 의 존재" 로 판정해야 한다.
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "typo",
    });
    await handlePrEventResolve(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      decision: "accepted",
      reasoning: "fixed",
    });
    const repolled = await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "stale poll repeat",
    });
    expect(repolled.alreadySeen).toBe(true);
    // pending 큐도 흔들리지 않는다 — 새 inbound 가 박혀도 같은 toolkitKey 의 resolved 가
    // 이미 있으니 pending 재진입 0.
    const pending = await handlePrEventPending(prJournal, HANDLE);
    expect(pending).toEqual([]);
  });

  it("pr_event_record: rejects unsupported type", async () => {
    await expect(
      handlePrEventRecord(prJournal, {
        handle: HANDLE,
        type: "workflow_run",
        externalId: "1",
        summary: "x",
      }),
    ).rejects.toThrow(/unsupported type/);
  });

  it("pr_event_pending: returns pending events in time-ascending order", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "first",
    });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "pr_review_comment",
      externalId: "9",
      summary: "review-comment",
    });
    const pending = await handlePrEventPending(prJournal, HANDLE);
    expect(pending.length).toBe(2);
    expect(pending[0]?.ref.toolkitKey).toBe("c:1");
    expect(pending[1]?.ref.toolkitKey).toBe("rc:9");
  });

  it("pr_event_resolve: removes the event from pending after acceptance", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "typo",
    });
    await handlePrEventResolve(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      decision: "accepted",
      reasoning: "fixed in commit abc1234",
      replyExternalId: "5555",
    });
    const pending = await handlePrEventPending(prJournal, HANDLE);
    expect(pending).toEqual([]);
  });

  it("pr_event_resolve: rejects unknown decision", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "x",
    });
    await expect(
      handlePrEventResolve(prJournal, {
        handle: HANDLE,
        type: "issue_comment",
        externalId: "1",
        decision: "yes" as never,
        reasoning: "y",
      }),
    ).rejects.toThrow(/decision/);
  });

  it("pr_event_resolve: rejects orphan resolve (no prior inbound)", async () => {
    // orphan resolve 가 박히면 reducePendingEvents 의 resolvedKeys 가 그 toolkitKey 를
    // 포함해서, 이후 진짜 inbound 가 들어와도 영구 제외 (큐 유실). handler 단에서 throw 로
    // 끊어 caller 가 pending 목록을 다시 보고 정확한 toolkitKey 로 재호출하게 한다.
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await expect(
      handlePrEventResolve(prJournal, {
        handle: HANDLE,
        type: "issue_comment",
        externalId: "999",
        decision: "accepted",
        reasoning: "should be rejected — never recorded",
      }),
    ).rejects.toThrow(/no prior pr_event_inbound/);
    // orphan 이 디스크에 남아 큐를 오염시키지 않았는지: 같은 toolkitKey 로 진짜 inbound 를
    // 박은 뒤 pending 에 그대로 surface 되어야 한다.
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "999",
      summary: "actual late comment",
    });
    const pending = await handlePrEventPending(prJournal, HANDLE);
    expect(pending.length).toBe(1);
    expect(pending[0]?.ref.toolkitKey).toBe("c:999");
  });

  it("pr_watch_start: rejects mergeMode outside the merge / squash / rebase enum", async () => {
    await expect(
      handlePrWatchStart(prJournal, {
        handle: HANDLE,
        mergeMode: "fast-forward",
      }),
    ).rejects.toThrow(/mergeMode/);
  });

  it("pr_watch_start: accepts the three valid mergeMode values", async () => {
    for (const mode of ["merge", "squash", "rebase"] as const) {
      const r = await handlePrWatchStart(prJournal, {
        handle: HANDLE,
        mergeMode: mode,
      });
      expect(r.entry.tags).toContain(`mergeMode:${mode}`);
    }
  });

  it("pr_watch_start: trims mergeMode before enum check (LLM-input robustness)", async () => {
    // 공백이 섞인 정상 값은 trim 후 통과. buildAppend 의 .trim() 동작과 일관.
    const r = await handlePrWatchStart(prJournal, {
      handle: HANDLE,
      mergeMode: "  squash  ",
    });
    expect(r.entry.tags).toContain("mergeMode:squash");
  });

  it("pr_watch_start: empty / whitespace-only mergeMode normalizes to no tag", async () => {
    // 빈 문자열은 undefined 로 정규화 — mergeMode 권고 미설정 의도.
    const r = await handlePrWatchStart(prJournal, {
      handle: HANDLE,
      mergeMode: "   ",
    });
    expect(r.entry.tags.some((t) => t.startsWith("mergeMode:"))).toBe(false);
  });

  it("pr_watch_stop: trims reason before enum check", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    const stop = await handlePrWatchStop(prJournal, {
      handle: HANDLE,
      reason: " merged ",
    });
    expect(stop.entry.tags).toContain("reason:merged");
  });

  it("pr_event_resolve: trims decision before enum check", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    await handlePrEventRecord(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      summary: "x",
    });
    const r = await handlePrEventResolve(prJournal, {
      handle: HANDLE,
      type: "issue_comment",
      externalId: "1",
      decision: " accepted " as never,
      reasoning: "fixed",
    });
    expect(r.entry.tags).toContain("decision:accepted");
  });

  it("end-to-end one-PR turn: start → record × 2 → resolve × 2 → stop → status 0/0", async () => {
    await handlePrWatchStart(prJournal, { handle: HANDLE });
    for (const id of ["1", "2"]) {
      await handlePrEventRecord(prJournal, {
        handle: HANDLE,
        type: "issue_comment",
        externalId: id,
        summary: `comment ${id}`,
      });
    }
    for (const id of ["1", "2"]) {
      await handlePrEventResolve(prJournal, {
        handle: HANDLE,
        type: "issue_comment",
        externalId: id,
        decision: "accepted",
        reasoning: `fixed ${id}`,
      });
    }
    await handlePrWatchStop(prJournal, { handle: HANDLE, reason: "merged" });
    const status = await handlePrWatchStatus(prJournal);
    expect(status.totals).toEqual({ active: 0, pending: 0 });
  });
});

describe("plugin config hook", () => {
  const expectedToolNames = [
    "notion_get",
    "notion_refresh",
    "notion_status",
    "notion_extract",
    "swagger_get",
    "swagger_refresh",
    "swagger_status",
    "swagger_search",
    "swagger_envs",
    "journal_append",
    "journal_read",
    "journal_search",
    "journal_status",
    "mysql_envs",
    "mysql_status",
    "mysql_tables",
    "mysql_schema",
    "mysql_query",
    "pr_watch_start",
    "pr_watch_stop",
    "pr_watch_status",
    "pr_event_record",
    "pr_event_pending",
    "pr_event_resolve",
    "spec_pact_fragment",
    "issue_create_from_spec",
    "issue_status",
    "gh_run",
  ];

  it("registers skills/, agents/, and agent/ paths and is idempotent", async () => {
    const plugin = await agentToolkitPlugin({});
    const cfg: any = {};
    plugin.config(cfg);
    plugin.config(cfg);

    // basename 비교로 cross-platform (Windows `\\` 도 안전).
    const expectPath = (key: string, leaf: string) => {
      expect(cfg[key]).toBeDefined();
      expect(Array.isArray(cfg[key].paths)).toBe(true);
      const matches = cfg[key].paths.filter(
        (p: string) => basename(p) === leaf,
      );
      expect(matches.length).toBe(1);
    };

    expectPath("skills", "skills");
    expectPath("agents", "agents");
    expectPath("agent", "agents");
  });

  it("registers exactly the 28 expected tools", async () => {
    const plugin = await agentToolkitPlugin({});
    const actualToolNames = Object.keys(plugin.tool).sort();
    expect(actualToolNames).toHaveLength(28);
    expect(actualToolNames).toEqual([...expectedToolNames].sort());
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

describe("spec_pact_fragment tool", () => {
  it("returns the matching fragment from the plugin's absolute skills path", async () => {
    const plugin = await agentToolkitPlugin({});
    const tool = plugin.tool.spec_pact_fragment;
    const result = await tool.handler({ mode: "draft" });

    expect(result.mode).toBe("draft");
    expect(result.path.endsWith("skills/spec-pact/fragments/draft.md")).toBe(
      true,
    );
    expect(result.content).toContain("# spec-pact — DRAFT");
  });

  it("rejects modes that are not in the four-mode set", async () => {
    const plugin = await agentToolkitPlugin({});
    const tool = plugin.tool.spec_pact_fragment;
    await expect(tool.handler({ mode: "plan" })).rejects.toThrow(
      /expected one of/,
    );
  });
});

// ── MySQL 도구 핸들러 ────────────────────────────────────────────────────────

class MysqlPluginFakeExecutor implements MysqlExecutor {
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
    if (!next) throw new Error(`fake: no response queued for ${sql}`);
    return next;
  }
}

const noFields = [] as unknown as FieldPacket[];

const mysqlConfig: ToolkitConfig = {
  mysql: {
    connections: {
      acme: {
        prod: {
          users: {
            host: "db.acme",
            user: "readonly",
            database: "app",
            passwordEnv: "MYSQL_ACME_PROD_USERS_PASSWORD",
          },
        },
      },
    },
  },
};

/**
 * Plugin 핸들러를 테스트하기 위한 미니 MysqlExecutorRegistry shim — pool 을 만들지 않고
 * 미리 만든 fake executor 를 그대로 돌려준다. 실제 mysql2 pool 은 만들지 않는다.
 */
function shimRegistry(executor: MysqlExecutor): MysqlExecutorRegistry {
  // factory 가 호출되지 않도록 getExecutor 만 override.
  const reg = new MysqlExecutorRegistry(
    {},
    () => ({ end: async () => {} }) as any,
  );
  (
    reg as unknown as { getExecutor: (h: string) => MysqlExecutor }
  ).getExecutor = () => executor;
  return reg;
}

describe("handleMysqlEnvs", () => {
  it("flattens the registry to host:env:db handles", () => {
    const out = handleMysqlEnvs(mysqlConfig);
    expect(out.length).toBe(1);
    expect(out[0]?.handle).toBe("acme:prod:users");
    expect(out[0]?.authMode).toBe("passwordEnv");
    expect(out[0]?.authEnv).toBe("MYSQL_ACME_PROD_USERS_PASSWORD");
  });

  it("returns [] when mysql.connections is not configured", () => {
    expect(handleMysqlEnvs({})).toEqual([]);
  });
});

describe("handleMysqlStatus", () => {
  it("returns handle metadata + ping=true on SELECT 1 success", async () => {
    const fake = new MysqlPluginFakeExecutor([
      { rows: [{ ok: 1 } as unknown as RowDataPacket], fields: noFields },
    ]);
    const r = await handleMysqlStatus(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
    );
    expect(r.handle).toBe("acme:prod:users");
    expect(r.ok).toBe(true);
  });

  it("throws when the handle is not registered", async () => {
    const fake = new MysqlPluginFakeExecutor([]);
    await expect(
      handleMysqlStatus(shimRegistry(fake), mysqlConfig, "acme:prod:missing"),
    ).rejects.toThrow(/not found in mysql\.connections/);
  });
});

describe("handleMysqlTables", () => {
  it("lists tables / views via SHOW FULL TABLES", async () => {
    const fake = new MysqlPluginFakeExecutor([
      {
        rows: [
          {
            Tables_in_app: "users",
            Table_type: "BASE TABLE",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
    ]);
    const r = await handleMysqlTables(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
    );
    expect(r).toEqual([{ name: "users", type: "BASE TABLE" }]);
  });
});

describe("handleMysqlSchema", () => {
  it("returns column summary when no table is given", async () => {
    const fake = new MysqlPluginFakeExecutor([
      {
        rows: [
          {
            TABLE_NAME: "users",
            COLUMN_NAME: "id",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "NO",
            COLUMN_KEY: "PRI",
            COLUMN_DEFAULT: null,
            EXTRA: "",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
    ]);
    const r = await handleMysqlSchema(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
    );
    expect(r.mode).toBe("summary");
  });

  it("returns SHOW CREATE TABLE detail when a table is given", async () => {
    const fake = new MysqlPluginFakeExecutor([
      {
        rows: [
          {
            Table: "users",
            "Create Table": "CREATE TABLE users (id INT)",
          } as unknown as RowDataPacket,
        ],
        fields: noFields,
      },
      { rows: [], fields: noFields },
    ]);
    const r = await handleMysqlSchema(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
      "users",
    );
    expect(r.mode).toBe("detail");
    expect(r.createTable).toContain("CREATE TABLE");
  });
});

describe("handleMysqlQuery", () => {
  it("rejects writes before reaching the executor", async () => {
    const fake = new MysqlPluginFakeExecutor([]);
    await expect(
      handleMysqlQuery(
        shimRegistry(fake),
        mysqlConfig,
        "acme:prod:users",
        "DELETE FROM users",
      ),
    ).rejects.toThrow(/MySQL read-only guard/);
    expect(fake.seen).toEqual([]);
  });

  it("attaches LIMIT 100 to a bare SELECT", async () => {
    const fake = new MysqlPluginFakeExecutor([
      { rows: [{ id: 1 } as unknown as RowDataPacket], fields: noFields },
    ]);
    const r = await handleMysqlQuery(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
      "SELECT * FROM users",
    );
    expect(fake.seen[0]).toContain("LIMIT 100");
    expect(r.effectiveLimit).toBe(100);
  });

  it("respects user-provided limit", async () => {
    const fake = new MysqlPluginFakeExecutor([{ rows: [], fields: noFields }]);
    await handleMysqlQuery(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
      "SELECT * FROM users",
      { limit: 5 },
    );
    expect(fake.seen[0]).toContain("LIMIT 5");
  });

  it("does not modify SHOW TABLES", async () => {
    const fake = new MysqlPluginFakeExecutor([
      {
        rows: [{ Tables_in_app: "users" } as unknown as RowDataPacket],
        fields: noFields,
      },
    ]);
    await handleMysqlQuery(
      shimRegistry(fake),
      mysqlConfig,
      "acme:prod:users",
      "SHOW TABLES",
    );
    expect(fake.seen[0]).toBe("SHOW TABLES");
  });
});

// ── spec-to-issues (Phase 2 — gh CLI delegated) ──────────────────────────────

const SPEC_PAGE_ID = "1234abcd1234abcd1234abcd1234abcd";
const validSpec = `---
slug: "user-auth"
status: locked
source_url: "https://www.notion.so/abc"
source_page_id: "${SPEC_PAGE_ID}"
spec_pact_version: 1
---

# 요약
test

# 합의 TODO
- 로그인 화면
- 비밀번호 재설정
`;

class FakeGhExecutor implements GhExecutor {
  public seen: Array<{ args: readonly string[]; stdin?: string }> = [];
  constructor(private readonly responses: GhExecResult[]) {}
  async run(args: readonly string[], stdin?: string): Promise<GhExecResult> {
    this.seen.push({ args, stdin });
    const next = this.responses.shift();
    if (!next) {
      throw new Error(
        `FakeGhExecutor: no response queued for \`gh ${args.join(" ")}\``,
      );
    }
    return next;
  }
}

const newJournalDir = (): { dir: string; journal: AgentJournal } => {
  const dir = mkdtempSync(join(tmpdir(), "issues-journal-"));
  return { dir, journal: new AgentJournal({ baseDir: dir }) };
};

const journalSnapshot = (journal: AgentJournal): string => {
  const path = journal.getPath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const writeSpecFile = (contents: string): { specPath: string; cwd: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "issues-spec-"));
  mkdirSync(join(cwd, ".agent", "specs"), { recursive: true });
  const specPath = join(cwd, ".agent", "specs", "user-auth.md");
  writeFileSync(specPath, contents);
  return { specPath, cwd };
};

describe("handleIssueCreateFromSpec", () => {
  it("dryRun=true: only `gh auth status` + `gh repo view` + `gh issue list`, plan returned, no journal mutation", async () => {
    const { specPath, cwd } = writeSpecFile(validSpec);
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "x/y\n", stderr: "", exitCode: 0 }, // repo view
      { stdout: "[]", stderr: "", exitCode: 0 }, // issue list
    ]);
    const cwdBefore = process.cwd();
    process.chdir(cwd);
    try {
      const before = journalSnapshot(journal);
      const result = await handleIssueCreateFromSpec(
        exec,
        journal,
        {},
        { slug: "user-auth", dryRun: true },
      );
      expect(result.applied).toBeUndefined();
      expect(result.plan.toCreate.epic).toBe(true);
      expect(result.plan.toCreate.subs).toEqual([1, 2]);
      expect(exec.seen.length).toBe(3);
      expect(exec.seen[0]?.args).toEqual(["auth", "status"]);
      expect(journalSnapshot(journal)).toBe(before);
      expect(await journal.read({ limit: 1 })).toEqual([]);
      expect(specPath).toMatch(/user-auth\.md$/);
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it("dryRun=false: applies and appends exactly one journal entry tagged `applied`", async () => {
    const { cwd } = writeSpecFile(validSpec);
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "x/y\n", stderr: "", exitCode: 0 }, // repo view
      { stdout: "[]", stderr: "", exitCode: 0 }, // issue list
      { stdout: "https://github.com/x/y/issues/11\n", stderr: "", exitCode: 0 }, // sub 1
      { stdout: "https://github.com/x/y/issues/12\n", stderr: "", exitCode: 0 }, // sub 2
      { stdout: "https://github.com/x/y/issues/10\n", stderr: "", exitCode: 0 }, // epic
    ]);
    const cwdBefore = process.cwd();
    process.chdir(cwd);
    try {
      const before = journalSnapshot(journal);
      const result = await handleIssueCreateFromSpec(
        exec,
        journal,
        {},
        { slug: "user-auth", dryRun: false },
      );
      expect(result.applied?.created.subs.map((s) => s.number)).toEqual([
        11, 12,
      ]);
      expect(result.applied?.created.epic?.number).toBe(10);
      expect(journalSnapshot(journal)).not.toBe(before);
      const entries = await journal.read({ limit: 5 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.tags).toContain("applied");
      expect(entries[0]?.pageId?.replace(/-/g, "")).toBe(SPEC_PAGE_ID);
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it("rejects when neither slug nor path is given", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([]);
    await expect(
      handleIssueCreateFromSpec(exec, journal, {}, { dryRun: true }),
    ).rejects.toThrow(/one of `slug` or `path` is required/);
  });

  it("rejects when both slug and path are given", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([]);
    await expect(
      handleIssueCreateFromSpec(
        exec,
        journal,
        {},
        { slug: "x", path: "y", dryRun: true },
      ),
    ).rejects.toThrow(/exactly one of `slug` or `path`/);
  });

  it("uses config.github.repo when no override is given", async () => {
    const { cwd } = writeSpecFile(validSpec);
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "[]", stderr: "", exitCode: 0 }, // issue list (no repo view since override given)
    ]);
    const cwdBefore = process.cwd();
    process.chdir(cwd);
    try {
      await handleIssueCreateFromSpec(
        exec,
        journal,
        { github: { repo: "from-config/repo" } },
        { slug: "user-auth", dryRun: true },
      );
      // 2nd call (issue list) should target from-config/repo
      const listCall = exec.seen[1];
      expect(listCall?.args).toContain("from-config/repo");
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it("tool param `repo` overrides config.github.repo", async () => {
    const { cwd } = writeSpecFile(validSpec);
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "[]", stderr: "", exitCode: 0 }, // issue list
    ]);
    const cwdBefore = process.cwd();
    process.chdir(cwd);
    try {
      await handleIssueCreateFromSpec(
        exec,
        journal,
        { github: { repo: "from-config/repo" } },
        { slug: "user-auth", repo: "from-param/repo", dryRun: true },
      );
      const listCall = exec.seen[1];
      expect(listCall?.args).toContain("from-param/repo");
    } finally {
      process.chdir(cwdBefore);
    }
  });
});

describe("handleGhRun", () => {
  it("read: executes immediately, journal tagged `read`", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status (precondition)
      { stdout: "x/y\n", stderr: "", exitCode: 0 }, // repo view
    ]);
    const result = await handleGhRun(exec, journal, ["repo", "view"], true);
    expect(result.kind).toBe("read");
    expect(result.executed).toBe(true);
    expect(result.dryRun).toBe(false);
    const entries = await journal.read({ limit: 1 });
    expect(entries[0]?.tags).toContain("read");
  });

  it("write + dryRun=true: plans only, journal tagged `dry-run`", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
    ]);
    const result = await handleGhRun(
      exec,
      journal,
      ["issue", "create", "--repo", "x/y", "--title", "t"],
      true,
    );
    expect(result.kind).toBe("write");
    expect(result.executed).toBe(false);
    expect(result.stdout).toContain("(dry-run, not executed)");
    const entries = await journal.read({ limit: 1 });
    expect(entries[0]?.tags).toContain("dry-run");
  });

  it("write + dryRun=false: executes, journal tagged `applied`", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      {
        stdout: "https://github.com/x/y/issues/9\n",
        stderr: "",
        exitCode: 0,
      },
    ]);
    const result = await handleGhRun(
      exec,
      journal,
      ["issue", "create", "--repo", "x/y", "--title", "t"],
      false,
    );
    expect(result.executed).toBe(true);
    const entries = await journal.read({ limit: 1 });
    expect(entries[0]?.tags).toContain("applied");
  });

  it("deny: throws GhDeniedCommandError, no journal entry", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([]);
    await expect(handleGhRun(exec, journal, ["auth", "login"])).rejects.toThrow(
      /is denied/,
    );
    const entries = await journal.read({ limit: 1 });
    expect(entries.length).toBe(0);
  });

  it("write apply failure: throws (no `applied` journal entry — Codex P2)", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "", stderr: "permission denied", exitCode: 1 }, // issue create
    ]);
    await expect(
      handleGhRun(
        exec,
        journal,
        ["issue", "create", "--repo", "x/y", "--title", "t"],
        false,
      ),
    ).rejects.toThrow(/failed with exit/);
    // journal must NOT contain an `applied` entry
    const entries = await journal.read({ limit: 5 });
    expect(entries.find((e) => e.tags?.includes("applied"))).toBeUndefined();
  });

  it("rejects empty args before any gh call (Copilot input validation)", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([]);
    await expect(handleGhRun(exec, journal, [])).rejects.toThrow(
      /args must be a non-empty array/,
    );
    expect(exec.seen.length).toBe(0);
  });

  it("rejects non-string elements in args before any gh call", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([]);
    await expect(
      handleGhRun(exec, journal, ["issue", 42 as unknown as string]),
    ).rejects.toThrow(/args\[1\] must be a string/);
    expect(exec.seen.length).toBe(0);
  });

  it("auth status: skips precondition (calls auth status only once)", async () => {
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // single auth status
    ]);
    const result = await handleGhRun(exec, journal, ["auth", "status"]);
    expect(result.executed).toBe(true);
    expect(exec.seen.length).toBe(1);
  });
});

describe("handleIssueStatus", () => {
  it("forces dryRun=true (read-only alias) and does not mutate journal", async () => {
    const { cwd } = writeSpecFile(validSpec);
    const { journal } = newJournalDir();
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 }, // auth status
      { stdout: "x/y\n", stderr: "", exitCode: 0 }, // repo view
      { stdout: "[]", stderr: "", exitCode: 0 }, // issue list
    ]);
    const cwdBefore = process.cwd();
    process.chdir(cwd);
    try {
      const before = journalSnapshot(journal);
      const result = await handleIssueStatus(
        exec,
        journal,
        {},
        { slug: "user-auth" },
      );
      expect(result.applied).toBeUndefined();
      expect(exec.seen.length).toBe(3); // never called create / edit
      expect(journalSnapshot(journal)).toBe(before);
      expect(await journal.read({ limit: 1 })).toEqual([]);
    } finally {
      process.chdir(cwdBefore);
    }
  });
});
