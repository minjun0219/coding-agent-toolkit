import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NotionCache } from "../../lib/notion-context";
import type { OpenapiRegistry } from "../../lib/toolkit-config";
import { AgentJournal } from "../../lib/agent-journal";
import { createAgentToolkitRegistry } from "../../lib/openapi/adapter";
import type { FieldPacket, RowDataPacket } from "mysql2/promise";
import agentToolkitPlugin, {
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
  handleSwaggerEndpoint,
  handleSwaggerEnvs,
  handleSwaggerGet,
  handleSwaggerRefresh,
  handleSwaggerSearch,
  handleSwaggerStatus,
  handleSwaggerTags,
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
let mcpOmitIdentifier: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-"));
  cache = new NotionCache({ baseDir: dir, defaultTtlSeconds: 60 });
  calls = 0;
  respondWithWrongId = false;
  mcpOmitIdentifier = false;
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
      if (url.pathname === "/mcp" && req.method === "POST") {
        if (req.headers.get("authorization") !== "Bearer test-token") {
          return new Response("missing authorization", { status: 401 });
        }
        const sessionHeaders = { "mcp-session-id": "test-session" };
        return req.json().then((body: any) => {
          if (body.method !== "initialize") {
            if (req.headers.get("mcp-session-id") !== "test-session") {
              return new Response("missing mcp-session-id", { status: 400 });
            }
            if (req.headers.get("mcp-protocol-version") !== "2025-06-18") {
              return new Response("missing mcp-protocol-version", {
                status: 400,
              });
            }
          }
          if (body.method === "initialize") {
            return new Response(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "Mock Notion MCP", version: "1.0.0" } } })}\n\n`,
              {
                headers: {
                  ...sessionHeaders,
                  "content-type": "text/event-stream",
                },
              },
            );
          }
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202, headers: sessionHeaders });
          }
          if (body.method === "tools/call") {
            calls += 1;
            const payload = mcpOmitIdentifier
              ? { title: "Hello MCP", text: "# Hello MCP\n\nworld" }
              : {
                  title: "Hello MCP",
                  url: `https://www.notion.so/${PAGE}`,
                  text: "# Hello MCP\n\nworld",
                };
            return new Response(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "not found" },
          });
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
  delete process.env.AGENT_TOOLKIT_MCP_AUTH_FILE;
  delete process.env.AGENT_TOOLKIT_NOTION_MCP_AUTH_KEY;
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

  it("notion_get: uses opencode MCP OAuth auth file when it matches the remote MCP URL", async () => {
    const authFile = join(dir, "mcp-auth.json");
    process.env.AGENT_TOOLKIT_NOTION_MCP_URL = `http://${server.hostname}:${server.port}/mcp`;
    process.env.AGENT_TOOLKIT_MCP_AUTH_FILE = authFile;
    writeFileSync(
      authFile,
      JSON.stringify({
        notion: {
          serverUrl: process.env.AGENT_TOOLKIT_NOTION_MCP_URL,
          tokens: {
            accessToken: "test-token",
            expiresAt: Date.now() / 1000 + 3600,
          },
        },
      }),
    );

    const first = await handleNotionGet(cache, PAGE);
    expect(first.fromCache).toBe(false);
    expect(first.entry.title).toBe("Hello MCP");
    expect(first.markdown).toBe("# Hello MCP\n\nworld");
    expect(calls).toBe(1);

    const second = await handleNotionGet(cache, PAGE);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("rejects OAuth MCP response without a remote identifier and does not cache", async () => {
    const authFile = join(dir, "mcp-auth.json");
    process.env.AGENT_TOOLKIT_NOTION_MCP_URL = `http://${server.hostname}:${server.port}/mcp`;
    process.env.AGENT_TOOLKIT_MCP_AUTH_FILE = authFile;
    writeFileSync(
      authFile,
      JSON.stringify({
        notion: {
          serverUrl: process.env.AGENT_TOOLKIT_NOTION_MCP_URL,
          tokens: { accessToken: "test-token" },
        },
      }),
    );
    mcpOmitIdentifier = true;

    await expect(handleNotionGet(cache, PAGE)).rejects.toThrow(
      /missing remote page identifier/i,
    );
    const s = await handleNotionStatus(cache, PAGE);
    expect(s.exists).toBe(false);
  });

  it("rejects remote response with mismatched page id and does not cache", async () => {
    respondWithWrongId = true;
    await expect(handleNotionGet(cache, PAGE)).rejects.toThrow(/wrong page/i);
    const s = await handleNotionStatus(cache, PAGE);
    expect(s.exists).toBe(false);
  });
});

// petstore 3.0 / 2.0 fixture 경로 — 두 단독 진입점 양쪽에서 같이 쓴다.
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "lib",
  "openapi",
  "__fixtures__",
);
const PETSTORE_3 = `file://${join(FIXTURE_DIR, "petstore-3.0.json")}`;
const PETSTORE_2 = `file://${join(FIXTURE_DIR, "petstore-2.0.json")}`;

describe("openapi handlers — file URL inputs", () => {
  it("openapi_get: file URL input gets parsed + dereferenced + cached", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    const r = await handleSwaggerGet(reg, PETSTORE_3);
    expect(r.fromCache).toBe(false);
    expect(r.document.openapi?.startsWith("3.")).toBe(true);
    expect(r.document.info?.title).toBe("Swagger Petstore");
    // 두 번째 호출은 메모리 캐시 hit.
    const r2 = await handleSwaggerGet(reg, PETSTORE_3);
    expect(r2.fromCache).toBe(true);
  });

  it("openapi_get: swagger 2.0 fixture is auto-converted to OpenAPI 3", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    const r = await handleSwaggerGet(reg, PETSTORE_2);
    expect(r.document.openapi?.startsWith("3.")).toBe(true);
    // swagger 본문엔 swagger 필드가 있었지만 변환 후엔 openapi 만 있어야 한다.
    expect(
      (r.document as unknown as Record<string, unknown>).swagger,
    ).toBeUndefined();
  });

  it("openapi_status / openapi_refresh: cache lifecycle", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    const before = await handleSwaggerStatus(reg, PETSTORE_3);
    expect(before.cacheStatus.cached).toBe(false);

    await handleSwaggerGet(reg, PETSTORE_3);
    const after = await handleSwaggerStatus(reg, PETSTORE_3);
    expect(after.cacheStatus.cached).toBe(true);

    const refreshed = await handleSwaggerRefresh(reg, PETSTORE_3);
    expect(refreshed.length).toBe(1);
    expect(refreshed[0]?.success).toBe(true);
  });

  it("openapi_search: scored keyword across loaded specs", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    await handleSwaggerGet(reg, PETSTORE_3);
    const matches = await handleSwaggerSearch(reg, "pet");
    expect(matches.length).toBeGreaterThan(0);
    // 점수화 검색은 operationId / path / summary / description 모두를 본다 — petstore
    // 의 store / user 도메인도 summary 에 "pet" 단어가 있으면 매칭될 수 있다. 핵심은
    // 첫 매칭이 path / operationId 같은 high-score 필드에서 잡혔는지.
    const top = matches[0];
    expect(top).toBeDefined();
    expect(
      top!.path.toLowerCase().includes("pet") ||
        top!.operationId.toLowerCase().includes("pet"),
    ).toBe(true);

    const limited = await handleSwaggerSearch(reg, "", { limit: 2 });
    expect(limited.length).toBe(2);
  });

  it("openapi_endpoint: returns full detail with fullUrl", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    const detail = await handleSwaggerEndpoint(reg, PETSTORE_3, {
      method: "GET",
      path: "/pet/{petId}",
    });
    expect(detail.endpoint.method).toBe("GET");
    expect(detail.endpoint.path).toBe("/pet/{petId}");
    expect(detail.endpoint.parameters.some((p) => p.name === "petId")).toBe(
      true,
    );
    // baseUrl 미선언이라 fullUrl 은 path 자체.
    expect(detail.endpoint.fullUrl).toBe("/pet/{petId}");
  });

  it("openapi_tags: returns tag summaries", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    const r = await handleSwaggerTags(reg, PETSTORE_3);
    expect(r.tags.length).toBeGreaterThan(0);
    expect(r.tags[0]).toHaveProperty("endpointCount");
  });

  it("rejects non-URL non-handle inputs clearly", async () => {
    const reg = createAgentToolkitRegistry({ diskCacheDisabled: true });
    await expect(handleSwaggerGet(reg, "not-a-url")).rejects.toThrow(
      /not a host:env:spec handle or http\(s\)\/file URL/,
    );
  });
});

describe("openapi handlers — registry handles", () => {
  let registry: OpenapiRegistry;

  beforeEach(() => {
    // string leaf (legacy) 와 object leaf (baseUrl 포함) 를 섞어 둔다.
    registry = {
      acme: {
        dev: {
          users: PETSTORE_3,
          // object leaf — baseUrl 합성을 검증.
          orders: { url: PETSTORE_3, baseUrl: "https://api.dev/orders" },
        },
        prod: {
          users: PETSTORE_3,
        },
      },
    };
  });

  it("openapi_get accepts a host:env:spec handle and returns flat spec name", async () => {
    const reg = createAgentToolkitRegistry({
      registry,
      diskCacheDisabled: true,
    });
    const r = await handleSwaggerGet(reg, "acme:dev:users", registry);
    expect(r.spec).toBe("acme:dev:users");
    expect(r.environment).toBe("default");
  });

  it("openapi_endpoint with a baseUrl-bearing leaf returns a synthesized fullUrl", async () => {
    const reg = createAgentToolkitRegistry({
      registry,
      diskCacheDisabled: true,
    });
    const detail = await handleSwaggerEndpoint(
      reg,
      "acme:dev:orders",
      { method: "GET", path: "/pet/{petId}" },
      registry,
    );
    expect(detail.endpoint.fullUrl).toBe("https://api.dev/orders/pet/{petId}");
  });

  it("openapi_get throws on unregistered handle", async () => {
    const reg = createAgentToolkitRegistry({
      registry,
      diskCacheDisabled: true,
    });
    await expect(
      handleSwaggerGet(reg, "acme:dev:missing", registry),
    ).rejects.toThrow(/acme:dev:missing/);
  });

  it("openapi_envs returns the flat registry list with baseUrl when present", () => {
    const flat = handleSwaggerEnvs({ openapi: { registry } });
    expect(flat.length).toBe(3);
    const orders = flat.find((r) => r.spec === "orders");
    expect(orders?.baseUrl).toBe("https://api.dev/orders");
    const users = flat.find((r) => r.spec === "users" && r.env === "dev");
    expect(users?.baseUrl).toBeUndefined();
  });

  it("openapi_envs returns [] for empty config", () => {
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
    "openapi_get",
    "openapi_refresh",
    "openapi_status",
    "openapi_search",
    "openapi_envs",
    "openapi_endpoint",
    "openapi_tags",
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
  ];

  it("registers skills path and concrete agents idempotently", async () => {
    const plugin = await agentToolkitPlugin({});
    const cfg: any = {};
    plugin.config(cfg);
    plugin.config(cfg);

    // basename 비교로 cross-platform (Windows `\\` 도 안전).
    expect(cfg.skills).toBeDefined();
    expect(Array.isArray(cfg.skills.paths)).toBe(true);
    const skillMatches = cfg.skills.paths.filter(
      (p: string) => basename(p) === "skills",
    );
    expect(skillMatches.length).toBe(1);

    expect(cfg.agent.rocky.mode).toBe("all");
    expect(cfg.agent.grace.mode).toBe("subagent");
    expect(cfg.agent.mindy.mode).toBe("subagent");
    expect(cfg.agent.rocky.description).toContain("Primary conductor");
    expect(cfg.agent.grace.prompt).toContain("# grace");
    expect(cfg.agent.mindy.prompt).toContain("# mindy");
  });

  it("registers exactly the 27 expected tools", async () => {
    const plugin = await agentToolkitPlugin({});
    const actualToolNames = Object.keys(plugin.tool).sort();
    expect(actualToolNames).toHaveLength(27);
    expect(actualToolNames).toEqual([...expectedToolNames].sort());
  });

  it("registers openapi_* tool names without legacy swagger_* aliases", async () => {
    const plugin = await agentToolkitPlugin({});
    expect(plugin.tool.openapi_get.description).toContain("OpenAPI");
    expect(plugin.tool.openapi_search).toBeDefined();
    expect((plugin.tool as any).swagger_get).toBeUndefined();
    expect((plugin.tool as any).swagger_search).toBeUndefined();
  });

  it("preserves existing paths in config", async () => {
    const plugin = await agentToolkitPlugin({});
    const cfg: any = {
      skills: { paths: ["/pre-existing/skills"] },
      agent: {
        build: { mode: "primary", description: "existing build" },
        rocky: { model: "openai/gpt-5", permission: { bash: "ask" } },
      },
    };
    plugin.config(cfg);
    expect(cfg.skills.paths).toContain("/pre-existing/skills");
    expect(cfg.agent.build.description).toBe("existing build");
    expect(cfg.agent.rocky.description).toContain("Primary conductor");
    expect(cfg.agent.rocky.model).toBe("openai/gpt-5");
    expect(cfg.agent.rocky.permission.edit).toBe("deny");
    expect(cfg.agent.rocky.permission.bash).toBe("ask");
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

  it("rejects writes before resolving connection secrets", async () => {
    const registry = new MysqlExecutorRegistry({});
    await expect(
      handleMysqlQuery(
        registry,
        mysqlConfig,
        "acme:prod:users",
        "DELETE FROM users",
      ),
    ).rejects.toThrow(/MySQL read-only guard/);
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
