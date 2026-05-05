import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJournal, type JournalEntry } from "./agent-journal";
import { isMergeMode, MERGE_MODES } from "./toolkit-config";
import {
  buildAppend,
  eventTag,
  formatPrHandle,
  handleTag,
  hasInboundFor,
  isStopReason,
  normalizeEventRef,
  parsePrHandle,
  PR_EVENT_TYPES,
  PR_WATCH_TAG,
  reduceActiveWatches,
  reducePendingEvents,
  selectByHandle,
  STOP_REASONS,
  type PrEventRef,
  type PrHandle,
} from "./pr-watch";

let dir: string;
let journal: AgentJournal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-toolkit-pr-watch-"));
  journal = new AgentJournal({ baseDir: dir });
});

const HANDLE_A: PrHandle = {
  repo: "minjun0219/agent-toolkit",
  number: 42,
  canonical: "minjun0219/agent-toolkit#42",
};
const HANDLE_B: PrHandle = {
  repo: "minjun0219/agent-toolkit",
  number: 7,
  canonical: "minjun0219/agent-toolkit#7",
};

const tagsForHandle = (h: PrHandle) => [
  "pr-watch",
  "inbound",
  `pr:${h.canonical}`,
];

describe("parsePrHandle", () => {
  it("parses owner/repo#NUMBER", () => {
    const h = parsePrHandle("minjun0219/agent-toolkit#42");
    expect(h.repo).toBe("minjun0219/agent-toolkit");
    expect(h.number).toBe(42);
    expect(h.canonical).toBe("minjun0219/agent-toolkit#42");
  });

  it("parses https URL", () => {
    const h = parsePrHandle(
      "https://github.com/minjun0219/agent-toolkit/pull/9",
    );
    expect(h.canonical).toBe("minjun0219/agent-toolkit#9");
  });

  it("parses URL with trailing slash / fragment / query", () => {
    expect(parsePrHandle("https://github.com/o/r/pull/1/").canonical).toBe(
      "o/r#1",
    );
    expect(
      parsePrHandle("https://github.com/o/r/pull/1#issuecomment-99").canonical,
    ).toBe("o/r#1");
    expect(
      parsePrHandle("https://github.com/o/r/pull/1?diff=split").canonical,
    ).toBe("o/r#1");
  });

  it("parses scheme-less github.com URL", () => {
    expect(parsePrHandle("github.com/o/r/pull/12").canonical).toBe("o/r#12");
  });

  it("trims whitespace", () => {
    expect(parsePrHandle("  o/r#1  ").canonical).toBe("o/r#1");
  });

  it("rejects empty / non-string", () => {
    expect(() => parsePrHandle("")).toThrow(/non-empty/);
    expect(() => parsePrHandle("   ")).toThrow(/non-empty/);
    // @ts-expect-error: 의도적으로 잘못된 타입 — 런타임 가드 검증.
    expect(() => parsePrHandle(undefined)).toThrow(/must be a string/);
  });

  it("rejects PR number 0 / negative / non-integer", () => {
    expect(() => parsePrHandle("o/r#0")).toThrow(/positive integer/);
    expect(() => parsePrHandle("o/r#-1")).toThrow(/cannot parse/);
    expect(() => parsePrHandle("o/r#1.5")).toThrow(/cannot parse/);
  });

  it("rejects malformed shapes", () => {
    expect(() => parsePrHandle("not-a-handle")).toThrow(/cannot parse/);
    expect(() => parsePrHandle("o#1")).toThrow(/cannot parse/);
    expect(() => parsePrHandle("o/r/x#1")).toThrow();
  });

  it("formatPrHandle / handleTag round-trip", () => {
    const h = parsePrHandle("o/r#1");
    expect(formatPrHandle(h)).toBe("o/r#1");
    expect(handleTag(h)).toBe("pr:o/r#1");
  });
});

describe("normalizeEventRef", () => {
  it("synthesizes prefixed toolkitKey for each known type", () => {
    expect(normalizeEventRef("issue_comment", "42").toolkitKey).toBe("c:42");
    expect(normalizeEventRef("pr_review", "100").toolkitKey).toBe("r:100");
    expect(normalizeEventRef("pr_review_comment", "55").toolkitKey).toBe(
      "rc:55",
    );
    expect(normalizeEventRef("check_run", "abc").toolkitKey).toBe("chk:abc");
    expect(normalizeEventRef("status", "abc").toolkitKey).toBe("st:abc");
    expect(normalizeEventRef("merge", "deadbeef").toolkitKey).toBe(
      "m:deadbeef",
    );
    expect(normalizeEventRef("close", "2026-05-03T10:00:00Z").toolkitKey).toBe(
      "cl:2026-05-03T10:00:00Z",
    );
  });

  it("trims externalId", () => {
    expect(normalizeEventRef("issue_comment", "  77  ").externalId).toBe("77");
  });

  it("rejects unknown type", () => {
    expect(() => normalizeEventRef("workflow_run", "1")).toThrow(
      /unsupported type/,
    );
  });

  it("rejects empty type / externalId", () => {
    expect(() => normalizeEventRef("", "1")).toThrow(/non-empty string/);
    expect(() => normalizeEventRef("issue_comment", "")).toThrow(
      /non-empty string/,
    );
    expect(() => normalizeEventRef("issue_comment", "   ")).toThrow(
      /non-empty string/,
    );
  });

  it("eventTag wraps the toolkitKey", () => {
    const ref = normalizeEventRef("issue_comment", "42");
    expect(eventTag(ref)).toBe("evt:c:42");
  });

  it("PR_EVENT_TYPES is exhaustive", () => {
    expect(PR_EVENT_TYPES.length).toBe(7);
  });
});

describe("buildAppend", () => {
  it("pr_watch_start: tag order is [pr-watch, start, pr:handle, ...]", () => {
    const input = buildAppend({
      kind: "pr_watch_start",
      data: { handle: HANDLE_A, note: "review 1차" },
    });
    expect(input.kind).toBe("pr_watch_start");
    expect(input.tags?.[0]).toBe("pr-watch");
    expect(input.tags?.[1]).toBe("start");
    expect(input.tags?.[2]).toBe("pr:minjun0219/agent-toolkit#42");
    expect(input.content).toBe(
      "minjun0219/agent-toolkit#42 watch started — review 1차",
    );
  });

  it("pr_watch_start: labels and mergeMode added as tags", () => {
    const input = buildAppend({
      kind: "pr_watch_start",
      data: {
        handle: HANDLE_A,
        labels: ["bug", "review"],
        mergeMode: "squash",
      },
    });
    expect(input.tags).toContain("label:bug");
    expect(input.tags).toContain("label:review");
    expect(input.tags).toContain("mergeMode:squash");
    expect(input.content).toBe("minjun0219/agent-toolkit#42 watch started");
  });

  it("pr_watch_stop: reason in tag and content", () => {
    const input = buildAppend({
      kind: "pr_watch_stop",
      data: { handle: HANDLE_A, reason: "merged" },
    });
    expect(input.kind).toBe("pr_watch_stop");
    expect(input.tags).toContain("reason:merged");
    expect(input.content).toContain("watch stopped — merged");
  });

  it("pr_event_inbound: handle / evt / type tags + summary in content", () => {
    const ref = normalizeEventRef("issue_comment", "42");
    const input = buildAppend({
      kind: "pr_event_inbound",
      data: { handle: HANDLE_A, ref, summary: "user bob: typo on /api/orders" },
    });
    expect(input.tags).toEqual([
      "pr-watch",
      "inbound",
      "pr:minjun0219/agent-toolkit#42",
      "evt:c:42",
      "type:issue_comment",
    ]);
    expect(input.content).toContain("issue_comment received");
    expect(input.content).toContain("typo on /api/orders");
  });

  it("pr_event_resolved: decision and reply tag + reasoning in content", () => {
    const ref = normalizeEventRef("pr_review_comment", "99");
    const input = buildAppend({
      kind: "pr_event_resolved",
      data: {
        handle: HANDLE_A,
        ref,
        decision: "accepted",
        reasoning: "fixed missing await",
        replyExternalId: "555",
      },
    });
    expect(input.tags).toContain("decision:accepted");
    expect(input.tags).toContain("reply:555");
    expect(input.tags).toContain("type:pr_review_comment");
    expect(input.content).toContain("accepted");
    expect(input.content).toContain("fixed missing await");
  });

  it("pr_event_resolved: rejects unknown decision", () => {
    const ref = normalizeEventRef("issue_comment", "1");
    expect(() =>
      buildAppend({
        kind: "pr_event_resolved",
        data: {
          handle: HANDLE_A,
          ref,
          // @ts-expect-error 잘못된 decision 런타임 가드.
          decision: "yes",
          reasoning: "x",
        },
      }),
    ).toThrow(/decision/);
  });

  it("never sets pageId — handle lives in tags only", () => {
    const input = buildAppend({
      kind: "pr_watch_start",
      data: { handle: HANDLE_A },
    });
    expect(input.pageId).toBeUndefined();
  });
});

describe("reduceActiveWatches", () => {
  it("returns active watches when start has no matching stop", async () => {
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_B } }),
    );
    const all = await readEverything(journal);
    const states = reduceActiveWatches(all);
    expect(states.length).toBe(2);
    expect(states.map((s) => s.handle.canonical).sort()).toEqual(
      [HANDLE_B.canonical, HANDLE_A.canonical].sort(),
    );
  });

  it("treats stop as final when start is older", async () => {
    await journal.append(
      buildAppend({
        kind: "pr_watch_start",
        data: { handle: HANDLE_A, note: "first" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_watch_stop",
        data: { handle: HANDLE_A, reason: "merged" },
      }),
    );
    const states = reduceActiveWatches(await readEverything(journal));
    expect(states.length).toBe(0);
  });

  it("treats re-start (start → stop → start) as active", async () => {
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_watch_stop",
        data: { handle: HANDLE_A, reason: "manual" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_watch_start",
        data: { handle: HANDLE_A, note: "재개" },
      }),
    );
    const states = reduceActiveWatches(await readEverything(journal));
    expect(states.length).toBe(1);
    expect(states[0]?.active).toBe(true);
    expect(states[0]?.note).toBe("재개");
    expect(states[0]?.stoppedAt).toBeUndefined();
  });

  it("isolates handles", async () => {
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_B } }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_watch_stop",
        data: { handle: HANDLE_B, reason: "manual" },
      }),
    );
    const states = reduceActiveWatches(await readEverything(journal));
    expect(states.length).toBe(1);
    expect(states[0]?.handle.canonical).toBe(HANDLE_A.canonical);
  });

  it("ignores non-pr-watch entries", () => {
    const fake: JournalEntry[] = [
      {
        id: "x",
        timestamp: new Date().toISOString(),
        kind: "decision",
        content: "no pr tag here",
        tags: ["other"],
      },
    ];
    expect(reduceActiveWatches(fake)).toEqual([]);
  });
});

describe("reducePendingEvents", () => {
  const refs = {
    a: normalizeEventRef("issue_comment", "1"),
    b: normalizeEventRef("issue_comment", "2"),
    c: normalizeEventRef("pr_review", "3"),
  } satisfies Record<string, PrEventRef>;

  it("returns inbound minus matched resolved (per-handle)", async () => {
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref: refs.a, summary: "comment 1" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref: refs.b, summary: "comment 2" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref: refs.c, summary: "review" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_resolved",
        data: {
          handle: HANDLE_A,
          ref: refs.a,
          decision: "accepted",
          reasoning: "ok",
        },
      }),
    );
    const pending = reducePendingEvents(
      HANDLE_A,
      await readEverything(journal),
    );
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.ref.toolkitKey).sort()).toEqual(["c:2", "r:3"]);
    expect(pending[0]?.summary.length).toBeGreaterThan(0);
    expect(pending[0]?.inboundEntryId.length).toBeGreaterThan(0);
  });

  it("dedupes duplicate inbound (same toolkitKey twice)", async () => {
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref: refs.a, summary: "first poll" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref: refs.a, summary: "second poll" },
      }),
    );
    const pending = reducePendingEvents(
      HANDLE_A,
      await readEverything(journal),
    );
    expect(pending.length).toBe(1);
    // 첫 번째 inbound 가 유지된다.
    expect(pending[0]?.summary).toBe("first poll");
  });

  it("ignores other PR's events", async () => {
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_B, ref: refs.a, summary: "PR B comment" },
      }),
    );
    const pending = reducePendingEvents(
      HANDLE_A,
      await readEverything(journal),
    );
    expect(pending).toEqual([]);
  });
});

describe("hasInboundFor / isMergeMode / MERGE_MODES", () => {
  it("hasInboundFor: true after the same toolkitKey was once inbound, false otherwise", async () => {
    const ref = normalizeEventRef("issue_comment", "42");
    expect(hasInboundFor(HANDLE_A, ref.toolkitKey, [])).toBe(false);
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "first" },
      }),
    );
    const all = await readEverything(journal);
    expect(hasInboundFor(HANDLE_A, ref.toolkitKey, all)).toBe(true);
    // 다른 PR 의 inbound 는 공유되지 않는다.
    expect(hasInboundFor(HANDLE_B, ref.toolkitKey, all)).toBe(false);
    // 다른 toolkitKey 는 false.
    const other = normalizeEventRef("issue_comment", "99");
    expect(hasInboundFor(HANDLE_A, other.toolkitKey, all)).toBe(false);
  });

  it("hasInboundFor: stays true even after the inbound was resolved (re-poll guard)", async () => {
    const ref = normalizeEventRef("issue_comment", "1");
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "x" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_resolved",
        data: {
          handle: HANDLE_A,
          ref,
          decision: "accepted",
          reasoning: "ok",
        },
      }),
    );
    expect(
      hasInboundFor(HANDLE_A, ref.toolkitKey, await readEverything(journal)),
    ).toBe(true);
  });

  it("isMergeMode / MERGE_MODES exhaustiveness (single source = toolkit-config)", () => {
    expect(MERGE_MODES).toEqual(["merge", "squash", "rebase"]);
    for (const mode of MERGE_MODES) {
      expect(isMergeMode(mode)).toBe(true);
    }
    expect(isMergeMode("fast-forward")).toBe(false);
    expect(isMergeMode("")).toBe(false);
  });

  it("STOP_REASONS / isStopReason: 3종 enum 만 인식", () => {
    expect(STOP_REASONS).toEqual(["merged", "closed", "manual"]);
    for (const r of STOP_REASONS) expect(isStopReason(r)).toBe(true);
    expect(isStopReason("wontfix")).toBe(false);
    expect(isStopReason("")).toBe(false);
  });

  it("PR_WATCH_TAG = 'pr-watch' (메인 태그 단일 소스)", () => {
    expect(PR_WATCH_TAG).toBe("pr-watch");
  });

  it("buildAppend(pr_watch_stop): rejects free-form reason at the lib layer", () => {
    // handler 단의 가드 외에 buildAppend 자체도 enum 만 받는다 (defensive).
    expect(() =>
      buildAppend({
        kind: "pr_watch_stop",
        // @ts-expect-error: 의도적으로 enum 외 값 — 런타임 가드 검증.
        data: { handle: HANDLE_A, reason: "wontfix" },
      }),
    ).toThrow(/reason must be one of/);
  });
});

describe("selectByHandle", () => {
  it("returns time-ordered lifecycle entries for one handle only", async () => {
    const ref = normalizeEventRef("issue_comment", "1");
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_B } }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "x" },
      }),
    );
    await journal.append({ content: "a decision", kind: "decision" });
    const slice = selectByHandle(HANDLE_A, await readEverything(journal));
    expect(slice.length).toBe(2);
    expect(slice[0]?.kind).toBe("pr_watch_start");
    expect(slice[1]?.kind).toBe("pr_event_inbound");
  });

  it("ignores other-handle entries even when tagged with pr:", async () => {
    const ref = normalizeEventRef("issue_comment", "1");
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_B, ref, summary: "B" },
      }),
    );
    expect(selectByHandle(HANDLE_A, await readEverything(journal))).toEqual([]);
  });
});

describe("integration with AgentJournal", () => {
  it("pageId is never written when going through buildAppend", async () => {
    const written = await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    expect(written.pageId).toBeUndefined();
    // tags 0번은 pr-watch (메인 태그).
    expect(written.tags[0]).toBe("pr-watch");
  });

  it("journal_search 'pr-watch' should recover full lifecycle", async () => {
    const ref = normalizeEventRef("issue_comment", "1");
    await journal.append(
      buildAppend({ kind: "pr_watch_start", data: { handle: HANDLE_A } }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "typo on /orders" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_resolved",
        data: {
          handle: HANDLE_A,
          ref,
          decision: "accepted",
          reasoning: "fixed",
        },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_watch_stop",
        data: { handle: HANDLE_A, reason: "merged" },
      }),
    );
    const found = await journal.search("pr-watch");
    expect(found.length).toBe(4);
  });

  it("buildAppend output is a valid JournalAppendInput shape (just sanity)", () => {
    const input = buildAppend({
      kind: "pr_event_inbound",
      data: {
        handle: HANDLE_A,
        ref: normalizeEventRef("issue_comment", "9"),
        summary: "  ",
      },
    });
    expect(typeof input.content).toBe("string");
    expect(input.content.length).toBeGreaterThan(0);
    // 핵심 핸들 태그가 항상 박힘 — 사용자 검색 키.
    expect(input.tags).toContain("pr:minjun0219/agent-toolkit#42");
    // tagsForHandle helper 도 같은 0..2 prefix 를 쓴다.
    expect(input.tags?.slice(0, 3)).toEqual(tagsForHandle(HANDLE_A));
  });
});

describe("golden contract: PR watch lifecycle", () => {
  it("covers start → record → pending → resolve → stop with duplicate record guard", async () => {
    const ref = normalizeEventRef("issue_comment", "101");

    const start = await journal.append(
      buildAppend({
        kind: "pr_watch_start",
        data: { handle: HANDLE_A, note: "review me" },
      }),
    );
    expect(start.kind).toBe("pr_watch_start");

    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "typo in docs" },
      }),
    );
    await journal.append(
      buildAppend({
        kind: "pr_event_inbound",
        data: { handle: HANDLE_A, ref, summary: "duplicate poll" },
      }),
    );

    const afterRecord = await readEverything(journal);
    expect(hasInboundFor(HANDLE_A, ref.toolkitKey, afterRecord)).toBe(true);
    expect(reducePendingEvents(HANDLE_A, afterRecord)).toHaveLength(1);
    expect(reducePendingEvents(HANDLE_A, afterRecord)[0]?.summary).toBe(
      "typo in docs",
    );

    await journal.append(
      buildAppend({
        kind: "pr_event_resolved",
        data: {
          handle: HANDLE_A,
          ref,
          decision: "accepted",
          reasoning: "fixed in source",
          replyExternalId: "r-77",
        },
      }),
    );

    const afterResolve = await readEverything(journal);
    expect(reducePendingEvents(HANDLE_A, afterResolve)).toEqual([]);
    expect(selectByHandle(HANDLE_A, afterResolve).map((e) => e.kind)).toEqual([
      "pr_watch_start",
      "pr_event_inbound",
      "pr_event_inbound",
      "pr_event_resolved",
    ]);

    await journal.append(
      buildAppend({
        kind: "pr_watch_stop",
        data: { handle: HANDLE_A, reason: "merged" },
      }),
    );

    expect(reduceActiveWatches(await readEverything(journal))).toEqual([]);
    expect(await journal.search("pr-watch")).toHaveLength(5);
  });
});

describe("contract checks", () => {
  it("pr-watch stays reducer-only and does not call GitHub APIs directly", () => {
    const source = readFileSync(join(import.meta.dir, "pr-watch.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bgh\b/);
    expect(source).not.toMatch(/mcp__github__/);
  });

  it("mindy.md explicitly denies edit and bash permissions", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "agents", "mindy.md"),
      "utf8",
    );
    expect(source).toContain("permission.edit: deny");
    expect(source).toContain("permission.bash: deny");
    expect(source).toContain("never merges the PR");
  });
});

async function readEverything(j: AgentJournal): Promise<JournalEntry[]> {
  // 시간 오름차순으로 reducer 들이 가정 — `read({ limit: 1000 })` 는 desc 라 reverse.
  const entries = await j.read({ limit: 1000 });
  return [...entries].reverse();
}
