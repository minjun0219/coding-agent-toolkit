import { describe, it, expect, beforeEach } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJournal, JOURNAL_FILE } from "./agent-journal";

const PAGE = "1234abcd1234abcd1234abcd1234abcd";
const PAGE_DASHED = "1234abcd-1234-abcd-1234-abcd1234abcd";
const OTHER_PAGE = "abcd1234abcd1234abcd1234abcd1234";
const OTHER_PAGE_DASHED = "abcd1234-abcd-1234-abcd-1234abcd1234";

let dir: string;
let journal: AgentJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-toolkit-journal-"));
  journal = new AgentJournal({ baseDir: dir });
});

describe("AgentJournal.append", () => {
  it("writes a JSONL line with normalized fields", async () => {
    const entry = await journal.append({
      content: "  decided to use Bun  ",
      kind: "decision",
      tags: [" notion ", "", "infra"],
      pageId: PAGE,
    });
    expect(entry.content).toBe("decided to use Bun");
    expect(entry.kind).toBe("decision");
    expect(entry.tags).toEqual(["notion", "infra"]);
    expect(entry.pageId).toBe(PAGE_DASHED);
    expect(entry.id).toMatch(/^\d+-[0-9a-f]{6}$/);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults kind to 'note' and tags to []", async () => {
    const entry = await journal.append({ content: "blocker" });
    expect(entry.kind).toBe("note");
    expect(entry.tags).toEqual([]);
    expect(entry.pageId).toBeUndefined();
  });

  it("rejects empty / whitespace content", async () => {
    await expect(journal.append({ content: "" })).rejects.toThrow(/non-empty/i);
    await expect(journal.append({ content: "   " })).rejects.toThrow(/non-empty/i);
  });

  it("rejects an invalid pageId string via resolveCacheKey", async () => {
    // 입력은 string 이지만 Notion page id 형식이 아닌 값 — resolveCacheKey 가 거부.
    await expect(
      journal.append({ content: "x", pageId: "not-a-page" }),
    ).rejects.toThrow(/Notion page id/);
  });
});

describe("AgentJournal.read", () => {
  it("returns most recent first up to limit (default 20)", async () => {
    for (let i = 0; i < 25; i += 1) {
      await journal.append({ content: `entry ${i}` });
    }
    const recent = await journal.read();
    expect(recent.length).toBe(20);
    expect(recent[0]?.content).toBe("entry 24");
    expect(recent[19]?.content).toBe("entry 5");
  });

  it("filters by kind", async () => {
    await journal.append({ content: "a", kind: "decision" });
    await journal.append({ content: "b", kind: "blocker" });
    await journal.append({ content: "c", kind: "decision" });
    const r = await journal.read({ kind: "decision" });
    expect(r.map((e) => e.content)).toEqual(["c", "a"]);
  });

  it("filters by tag (exact membership)", async () => {
    await journal.append({ content: "a", tags: ["api", "review"] });
    await journal.append({ content: "b", tags: ["review"] });
    await journal.append({ content: "c", tags: ["api"] });
    const r = await journal.read({ tag: "api" });
    expect(r.map((e) => e.content)).toEqual(["c", "a"]);
  });

  it("filters by pageId after normalization", async () => {
    await journal.append({ content: "a", pageId: PAGE });
    await journal.append({ content: "b", pageId: OTHER_PAGE });
    await journal.append({ content: "c", pageId: PAGE_DASHED });
    // URL 형태로 줘도 같은 키로 묶여야.
    const r = await journal.read({
      pageId: `https://www.notion.so/team/Title-${PAGE}`,
    });
    expect(r.map((e) => e.content)).toEqual(["c", "a"]);
    expect(r.every((e) => e.pageId === PAGE_DASHED)).toBe(true);
  });

  it("filters by since (strictly after)", async () => {
    const a = await journal.append({ content: "before" });
    // 1ms 차이는 시스템에 따라 동일 timestamp 가 나올 수 있어 명시적으로 sleep.
    await new Promise((r) => setTimeout(r, 5));
    const after = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await journal.append({ content: "after-1" });
    await journal.append({ content: "after-2" });
    const r = await journal.read({ since: after });
    expect(r.map((e) => e.content)).toEqual(["after-2", "after-1"]);
    expect(r.every((e) => e.id !== a.id)).toBe(true);
  });

  it("returns [] when journal does not exist yet", async () => {
    expect(await journal.read()).toEqual([]);
  });
});

describe("AgentJournal.search", () => {
  beforeEach(async () => {
    await journal.append({ content: "Decided to use Bun", kind: "decision" });
    await journal.append({ content: "Blocked on auth", kind: "blocker" });
    await journal.append({ content: "User confirmed PRD", kind: "answer", tags: ["prd"] });
    await journal.append({ content: "linked page", pageId: PAGE });
  });

  it("matches content substring case-insensitively", async () => {
    const r = await journal.search("BUN");
    expect(r.length).toBe(1);
    expect(r[0]?.content).toBe("Decided to use Bun");
  });

  it("matches by tag", async () => {
    const r = await journal.search("prd");
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("answer");
  });

  it("matches by pageId substring", async () => {
    const r = await journal.search(PAGE_DASHED.slice(0, 8));
    expect(r.length).toBe(1);
    expect(r[0]?.pageId).toBe(PAGE_DASHED);
  });

  it("kind filter scopes the pool before substring match", async () => {
    const r = await journal.search("", { kind: "blocker" });
    expect(r.length).toBe(1);
    expect(r[0]?.content).toBe("Blocked on auth");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 30; i += 1) {
      await journal.append({ content: `noise ${i}` });
    }
    const r = await journal.search("noise", { limit: 3 });
    expect(r.length).toBe(3);
  });
});

describe("AgentJournal.status", () => {
  it("reports exists=false before any writes", async () => {
    const s = await journal.status();
    expect(s.exists).toBe(false);
    expect(s.totalEntries).toBe(0);
    expect(s.sizeBytes).toBe(0);
    expect(s.lastEntryAt).toBeUndefined();
  });

  it("reports totalEntries / lastEntryAt after writes", async () => {
    await journal.append({ content: "a" });
    const last = await journal.append({ content: "b" });
    const s = await journal.status();
    expect(s.exists).toBe(true);
    expect(s.totalEntries).toBe(2);
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(s.lastEntryAt).toBe(last.timestamp);
  });
});

describe("graceful degradation", () => {
  it("skips corrupt JSON lines but keeps valid ones", async () => {
    await journal.append({ content: "first" });
    appendFileSync(
      join(dir, JOURNAL_FILE),
      "{ this is not json\n",
      "utf8",
    );
    await journal.append({ content: "second" });
    const r = await journal.read();
    expect(r.map((e) => e.content)).toEqual(["second", "first"]);
  });

  it("skips entries missing required fields", async () => {
    await journal.append({ content: "valid" });
    appendFileSync(
      join(dir, JOURNAL_FILE),
      `${JSON.stringify({ id: "x", timestamp: "now" })}\n`,
      "utf8",
    );
    const r = await journal.read();
    expect(r.map((e) => e.content)).toEqual(["valid"]);
  });

  it("tolerates a trailing partial line (no newline)", async () => {
    await journal.append({ content: "first" });
    appendFileSync(
      join(dir, JOURNAL_FILE),
      `${JSON.stringify({ id: "p", timestamp: "now", kind: "note", content: "partial" }).slice(0, 20)}`,
      "utf8",
    );
    const r = await journal.read();
    expect(r.map((e) => e.content)).toEqual(["first"]);
  });

  it("does not concatenate a new entry onto an unterminated last line (Codex P1)", async () => {
    // 직전 프로세스가 mid-write 로 죽어 마지막 줄이 `\n` 없이 끝난 시뮬레이션.
    appendFileSync(
      join(dir, JOURNAL_FILE),
      '{"id":"crashed","timestamp":"',
      "utf8",
    );
    // 새 entry append — leading `\n` 으로 라인 경계가 강제되어야 새 항목이 살아남는다.
    const fresh = await journal.append({ content: "after-restart" });
    const r = await journal.read();
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe(fresh.id);
    expect(r[0]?.content).toBe("after-restart");
  });

  it("returns [] on entirely garbage file without throwing", async () => {
    writeFileSync(join(dir, JOURNAL_FILE), "garbage\n}{also garbage\n", "utf8");
    expect(await journal.read()).toEqual([]);
    const s = await journal.status();
    expect(s.exists).toBe(true);
    expect(s.totalEntries).toBe(0);
  });
});
