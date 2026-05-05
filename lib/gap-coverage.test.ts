/**
 * T10: tool-by-tool 자동화 gap 테스트
 *
 * 다음 gap 영역을 커버한다:
 *  1. fake GhExecutor integration — FakeGhExecutor 패턴 검증
 *  2. tool handler smoke — 각 tool category별 최소 1개
 *  3. OpenAPI timeout/error 케이스 — 서버 에러 / 연결 거부
 *  4. journal high-volume — 대량 append 후 read/search 정확성
 *  5. MySQL multipleStatements:false guard — POOL_FIXED_OPTIONS 검증
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
import type { GhExecResult, GhExecutor } from "./gh-cli";
import {
  GhNotInstalledError,
  GhAuthError,
  GhCommandError,
  GhDeniedCommandError,
  classifyGhCommand,
} from "./gh-cli";
import { handleSwaggerGet } from "../.opencode/plugins/agent-toolkit";

// ── 1. fake GhExecutor integration ──────────────────────────────────────────

/**
 * FakeGhExecutor: GhExecutor 인터페이스를 구현하는 fake.
 * 미리 큐에 넣은 응답을 순서대로 반환한다.
 */
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

describe("fake GhExecutor integration", () => {
  it("records all calls in seen array in order", async () => {
    const exec = new FakeGhExecutor([
      { stdout: "ok", stderr: "", exitCode: 0 },
      { stdout: "result", stderr: "", exitCode: 0 },
    ]);
    await exec.run(["auth", "status"]);
    await exec.run(["repo", "view"]);
    expect(exec.seen).toHaveLength(2);
    expect(exec.seen[0]?.args).toEqual(["auth", "status"]);
    expect(exec.seen[1]?.args).toEqual(["repo", "view"]);
  });

  it("throws when queue is exhausted", async () => {
    const exec = new FakeGhExecutor([]);
    await expect(exec.run(["auth", "status"])).rejects.toThrow(
      /no response queued/,
    );
  });

  it("passes stdin through to seen", async () => {
    const exec = new FakeGhExecutor([{ stdout: "", stderr: "", exitCode: 0 }]);
    await exec.run(["issue", "create"], "body text");
    expect(exec.seen[0]?.stdin).toBe("body text");
  });

  it("returns non-zero exitCode without throwing", async () => {
    const exec = new FakeGhExecutor([
      { stdout: "", stderr: "permission denied", exitCode: 1 },
    ]);
    const result = await exec.run(["issue", "create"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("permission denied");
  });
});

// ── 2. gh-cli error classes smoke ────────────────────────────────────────────

describe("gh-cli error classes smoke", () => {
  it("GhNotInstalledError has correct name and message", () => {
    const err = new GhNotInstalledError();
    expect(err.name).toBe("GhNotInstalledError");
    expect(err.message).toContain("gh CLI not found");
  });

  it("GhAuthError includes stderr tail in message", () => {
    const err = new GhAuthError("token expired\nplease re-auth");
    expect(err.name).toBe("GhAuthError");
    expect(err.message).toContain("token expired");
  });

  it("GhAuthError works without stderr", () => {
    const err = new GhAuthError();
    expect(err.name).toBe("GhAuthError");
    expect(err.message).toContain("gh auth login");
  });

  it("GhCommandError exposes args and exitCode", () => {
    const err = new GhCommandError(["issue", "create"], 1, "bad request");
    expect(err.name).toBe("GhCommandError");
    expect(err.args).toEqual(["issue", "create"]);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain("failed with exit");
  });

  it("GhDeniedCommandError exposes the denied command", () => {
    const err = new GhDeniedCommandError(
      ["auth", "login"],
      "environment-affecting command",
    );
    expect(err.name).toBe("GhDeniedCommandError");
    expect(err.message).toContain("is denied");
  });
});

// ── 3. classifyGhCommand smoke ────────────────────────────────────────────────

describe("classifyGhCommand", () => {
  it("classifies read commands correctly", () => {
    expect(classifyGhCommand(["auth", "status"])).toBe("read");
    expect(classifyGhCommand(["repo", "view"])).toBe("read");
    expect(classifyGhCommand(["issue", "list"])).toBe("read");
    expect(classifyGhCommand(["pr", "view", "42"])).toBe("read");
    expect(classifyGhCommand(["gist", "list"])).toBe("read");
    expect(classifyGhCommand(["gist", "view", "abc"])).toBe("read");
  });

  it("classifies write commands correctly", () => {
    expect(classifyGhCommand(["issue", "create"])).toBe("write");
    expect(classifyGhCommand(["issue", "edit", "1"])).toBe("write");
    expect(classifyGhCommand(["pr", "create"])).toBe("write");
    expect(classifyGhCommand(["label", "create"])).toBe("write");
  });

  it("classifies deny commands correctly", () => {
    expect(classifyGhCommand(["auth", "login"])).toBe("deny");
    expect(classifyGhCommand(["auth", "logout"])).toBe("deny");
    expect(classifyGhCommand(["pr", "merge", "42"])).toBe("deny");
    expect(classifyGhCommand(["extension", "install", "x"])).toBe("deny");
    expect(classifyGhCommand(["alias", "set", "x", "y"])).toBe("deny");
    expect(classifyGhCommand(["config", "set", "x", "y"])).toBe("deny");
    expect(classifyGhCommand(["gist", "create"])).toBe("deny");
    expect(classifyGhCommand(["gist", "delete", "abc"])).toBe("deny");
  });

  it("classifies unknown subcommand as deny (conservative)", () => {
    expect(classifyGhCommand(["unknown-subcommand"])).toBe("deny");
  });
});

// ── 4. OpenAPI timeout/error 케이스 ──────────────────────────────────────────

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

// ── 5. journal high-volume ────────────────────────────────────────────────────

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

// ── 6. MySQL POOL_FIXED_OPTIONS guard ────────────────────────────────────────

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
