/**
 * T10: tool-by-tool 자동화 gap 테스트
 *
 * 다음 gap 영역을 커버한다:
 *  1. OpenAPI timeout/error 케이스 — 서버 에러 / 연결 거부
 *  2. journal high-volume — 대량 append 후 read/search 정확성
 *  3. MySQL multipleStatements:false guard — POOL_FIXED_OPTIONS 검증
 *
 * 모두 결정론적(deterministic) — live env 없이 통과.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJournal } from "./agent-journal";
import { OpenapiCache } from "./openapi-context";
import { POOL_FIXED_OPTIONS } from "./mysql-context";
import { handleSwaggerGet } from "../.opencode/plugins/agent-toolkit";

// ── 1. OpenAPI timeout/error 케이스 ──────────────────────────────────────────

describe("OpenAPI error cases", () => {
  let dir: string;
  let cache: OpenapiCache;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gap-oa-"));
    cache = new OpenapiCache({ baseDir: dir, defaultTtlSeconds: 60 });
  });

  afterEach(() => {
    server?.stop(true);
  });

  it("rejects 404 response from spec server", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("not found", { status: 404 });
      },
    });
    const url = `http://${server.hostname}:${server.port}/missing.json`;
    await expect(handleSwaggerGet(cache, url)).rejects.toThrow();
  });

  it("rejects 500 response from spec server", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("internal error", { status: 500 });
      },
    });
    const url = `http://${server.hostname}:${server.port}/spec.json`;
    await expect(handleSwaggerGet(cache, url)).rejects.toThrow();
  });

  it("rejects non-JSON (HTML) response body", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("<html><body>error</body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const url = `http://${server.hostname}:${server.port}/spec.json`;
    await expect(handleSwaggerGet(cache, url)).rejects.toThrow(/non-JSON/i);
  });

  it("rejects valid JSON that is not an OpenAPI spec", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ hello: "world" });
      },
    });
    const url = `http://${server.hostname}:${server.port}/spec.json`;
    await expect(handleSwaggerGet(cache, url)).rejects.toThrow(
      /openapi.*swagger/i,
    );
  });

  it("does not cache on fetch error (status remains miss)", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("bad", { status: 503 });
      },
    });
    const url = `http://${server.hostname}:${server.port}/spec.json`;
    try {
      await handleSwaggerGet(cache, url);
    } catch {
      // expected
    }
    const s = await cache.status(url);
    expect(s.exists).toBe(false);
  });
});

// ── 2. journal high-volume ────────────────────────────────────────────────────

describe("journal high-volume", () => {
  let jDir: string;
  let journal: AgentJournal;

  beforeEach(() => {
    jDir = mkdtempSync(join(tmpdir(), "gap-journal-"));
    journal = new AgentJournal({ baseDir: jDir });
  });

  it("appends 200 entries and reads them all back correctly", async () => {
    const N = 200;
    for (let i = 0; i < N; i++) {
      await journal.append({
        content: `entry-${i}`,
        kind: i % 2 === 0 ? "decision" : "note",
        tags: [`batch-${Math.floor(i / 10)}`],
      });
    }
    const all = await journal.read({ limit: N + 10 });
    expect(all.length).toBe(N);
    // 최신 순 — 마지막 append 가 첫 번째
    expect(all[0]?.content).toBe(`entry-${N - 1}`);
    expect(all[N - 1]?.content).toBe("entry-0");
  });

  it("kind filter works correctly on high-volume journal", async () => {
    const N = 100;
    for (let i = 0; i < N; i++) {
      await journal.append({
        content: `item-${i}`,
        kind: i % 3 === 0 ? "blocker" : "note",
      });
    }
    const blockers = await journal.read({ kind: "blocker", limit: N });
    // 0, 3, 6, ..., 99 → ceil(100/3) = 34개
    expect(blockers.length).toBe(34);
    expect(blockers.every((e) => e.kind === "blocker")).toBe(true);
  });

  it("search works correctly on high-volume journal", async () => {
    const N = 150;
    for (let i = 0; i < N; i++) {
      await journal.append({
        content: i % 5 === 0 ? `special-entry-${i}` : `normal-${i}`,
        kind: "note",
      });
    }
    const results = await journal.search("special-entry", { limit: N });
    // 0, 5, 10, ..., 145 → 30개
    expect(results.length).toBe(30);
    expect(results.every((e) => e.content.includes("special-entry"))).toBe(
      true,
    );
  });

  it("journal status reflects correct totalEntries after high-volume append", async () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      await journal.append({ content: `e-${i}`, kind: "note" });
    }
    const status = await journal.status();
    expect(status.exists).toBe(true);
    expect(status.totalEntries).toBe(N);
  });

  it("new instance reads same high-volume journal (turn-spanning simulation)", async () => {
    const N = 80;
    for (let i = 0; i < N; i++) {
      await journal.append({ content: `turn1-${i}`, kind: "decision" });
    }
    // 다음 turn 에서 새 인스턴스로 읽기
    const nextTurn = new AgentJournal({ baseDir: jDir });
    const all = await nextTurn.read({ limit: N + 10 });
    expect(all.length).toBe(N);
  });
});

// ── 3. MySQL POOL_FIXED_OPTIONS guard ────────────────────────────────────────

describe("MySQL POOL_FIXED_OPTIONS guard", () => {
  it("multipleStatements is false", () => {
    expect(POOL_FIXED_OPTIONS.multipleStatements).toBe(false);
  });

  it("namedPlaceholders is false", () => {
    expect(POOL_FIXED_OPTIONS.namedPlaceholders).toBe(false);
  });

  it("dateStrings is true", () => {
    expect(POOL_FIXED_OPTIONS.dateStrings).toBe(true);
  });

  it("connectTimeout is a positive number", () => {
    expect(typeof POOL_FIXED_OPTIONS.connectTimeout).toBe("number");
    expect(POOL_FIXED_OPTIONS.connectTimeout).toBeGreaterThan(0);
  });

  it("timezone is UTC offset string", () => {
    expect(POOL_FIXED_OPTIONS.timezone).toBe("+00:00");
  });

  it("connectionLimit is a small positive number (admin-only pool)", () => {
    expect(typeof POOL_FIXED_OPTIONS.connectionLimit).toBe("number");
    expect(POOL_FIXED_OPTIONS.connectionLimit).toBeGreaterThan(0);
    // admin 조회용 — 과도한 연결 방지
    expect(POOL_FIXED_OPTIONS.connectionLimit).toBeLessThanOrEqual(10);
  });

  it("POOL_FIXED_OPTIONS is a frozen-like const (no extra keys beyond expected)", () => {
    const expectedKeys = new Set([
      "multipleStatements",
      "namedPlaceholders",
      "dateStrings",
      "connectTimeout",
      "timezone",
      "connectionLimit",
    ]);
    for (const key of Object.keys(POOL_FIXED_OPTIONS)) {
      expect(expectedKeys.has(key)).toBe(true);
    }
  });
});
