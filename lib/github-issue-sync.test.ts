import { describe, expect, it } from "bun:test";

import type { GhExecResult, GhExecutor, GhIssueListItem } from "./gh-cli";
import {
  MARKER_RE,
  applySyncPlan,
  buildSyncPlan,
  epicMarker,
  extractAgreedTodoBullets,
  parseSpecFile,
  renderEpicBody,
  renderSubBody,
  subMarker,
  syncSpecToIssues,
  type ParsedSpec,
  type SpecFrontmatter,
} from "./github-issue-sync";

// ── helpers ──────────────────────────────────────────────────────────────────

const makeSpec = (overrides: Partial<ParsedSpec> = {}): ParsedSpec => {
  const frontmatter: SpecFrontmatter = {
    slug: "user-auth",
    status: "locked",
    source_url: "https://www.notion.so/abc",
    source_page_id: "abc",
    agreed_at: "2026-05-03T10:00:00Z",
    spec_pact_version: 1,
  };
  return {
    path: ".agent/specs/user-auth.md",
    body: "",
    bullets: [
      "로그인 화면 구현",
      "비밀번호 재설정 플로우",
      "세션 만료 후 재인증",
    ],
    frontmatter,
    ...overrides,
  };
};

const issue = (
  number: number,
  body: string,
  overrides: Partial<GhIssueListItem> = {},
): GhIssueListItem => ({
  number,
  title: "x",
  url: `https://github.com/x/y/issues/${number}`,
  labels: ["spec-pact"],
  body,
  ...overrides,
});

interface FakeGhCall {
  args: readonly string[];
  stdin?: string;
}

const fakeGh = (
  responses: Array<(call: FakeGhCall) => GhExecResult>,
): { exec: GhExecutor; calls: FakeGhCall[] } => {
  const calls: FakeGhCall[] = [];
  let i = 0;
  const exec: GhExecutor = {
    async run(args, stdin) {
      const call = { args, stdin };
      calls.push(call);
      const fn = responses[i++];
      if (!fn) {
        throw new Error(
          `fakeGh: no response for call #${i} args=${args.join(" ")}`,
        );
      }
      return fn(call);
    },
  };
  return { exec, calls };
};

const okJson = (payload: unknown): GhExecResult => ({
  stdout: JSON.stringify(payload),
  stderr: "",
  exitCode: 0,
});

const okIssueCreate = (number: number): GhExecResult => ({
  stdout: `https://github.com/x/y/issues/${number}\n`,
  stderr: "",
  exitCode: 0,
});

const okEdit = (): GhExecResult => ({ stdout: "", stderr: "", exitCode: 0 });

// ── parseSpecFile ────────────────────────────────────────────────────────────

describe("parseSpecFile", () => {
  const valid = `---
slug: "user-auth"
status: locked
source_url: "https://www.notion.so/abc"
spec_pact_version: 1
---

# 요약
한 문단.

# 합의 TODO
- 로그인 화면 구현
- 비밀번호 재설정 플로우
  - 이건 nested — 무시되어야 한다
- 세션 만료 후 재인증

# 변경 이력
- v1 anchored
`;

  it("returns frontmatter + bullets for a valid locked SPEC", () => {
    const spec = parseSpecFile(".agent/specs/user-auth.md", valid);
    expect(spec.frontmatter.slug).toBe("user-auth");
    expect(spec.frontmatter.status).toBe("locked");
    expect(spec.frontmatter.spec_pact_version).toBe(1);
    expect(spec.bullets).toEqual([
      "로그인 화면 구현",
      "비밀번호 재설정 플로우",
      "세션 만료 후 재인증",
    ]);
  });

  it("rejects SPEC with no frontmatter", () => {
    expect(() => parseSpecFile("p", "no frontmatter")).toThrow(
      /no YAML frontmatter/,
    );
  });

  it("rejects SPEC with status=drifted", () => {
    const drifted = valid.replace("status: locked", 'status: "drifted"');
    expect(() => parseSpecFile("p", drifted)).toThrow(/refusing to sync/);
  });

  it("rejects SPEC with no `# 합의 TODO` bullets", () => {
    const empty = `---
slug: "x"
status: locked
---

# 요약
empty
`;
    expect(() => parseSpecFile("p", empty)).toThrow(/no flat bullets/);
  });
});

describe("extractAgreedTodoBullets", () => {
  it("returns flat top-level bullets only and stops at the next H1", () => {
    const body = `# 요약\n\n파라\n\n# 합의 TODO\n- a\n- b\n  - nested\n- c\n\n# 변경 이력\n- v1\n`;
    expect(extractAgreedTodoBullets(body)).toEqual(["a", "b", "c"]);
  });

  it("returns [] when no `# 합의 TODO` section is present", () => {
    expect(extractAgreedTodoBullets("# 요약\nparagraph\n")).toEqual([]);
  });
});

// ── markers ──────────────────────────────────────────────────────────────────

describe("markers", () => {
  it("epicMarker / subMarker emit the documented format", () => {
    expect(epicMarker("user-auth")).toBe(
      "<!-- spec-pact:slug=user-auth:kind=epic -->",
    );
    expect(subMarker("user-auth", 3)).toBe(
      "<!-- spec-pact:slug=user-auth:kind=sub:index=3 -->",
    );
  });

  it("MARKER_RE captures slug / kind / index", () => {
    const m = "<!-- spec-pact:slug=foo:kind=sub:index=12 -->".match(MARKER_RE);
    expect(m?.[1]).toBe("foo");
    expect(m?.[2]).toBe("sub");
    expect(m?.[3]).toBe("12");
  });
});

// ── buildSyncPlan ────────────────────────────────────────────────────────────

describe("buildSyncPlan", () => {
  it("creates everything when nothing exists yet", () => {
    const plan = buildSyncPlan(
      makeSpec(),
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [],
    );
    expect(plan.toCreate.epic).toBe(true);
    expect(plan.toCreate.subs).toEqual([1, 2, 3]);
    expect(plan.toPatchEpicBody).toBe(false);
    expect(plan.orphans).toEqual([]);
    expect(plan.epic.body).toContain(epicMarker("user-auth"));
    expect(plan.subs[0]?.body).toContain(subMarker("user-auth", 1));
  });

  it("matches existing epic + subs by marker (re-apply is no-op)", () => {
    const spec = makeSpec();
    const subs = spec.bullets.map((b, i) =>
      issue(10 + i, renderSubBody(spec, i + 1, b)),
    );
    const epicIssue = issue(
      9,
      renderEpicBody(spec, [
        {
          index: 1,
          title: "[user-auth] 로그인 화면 구현",
          body: "",
          existing: { number: 10, url: "u" },
        },
        {
          index: 2,
          title: "[user-auth] 비밀번호 재설정 플로우",
          body: "",
          existing: { number: 11, url: "u" },
        },
        {
          index: 3,
          title: "[user-auth] 세션 만료 후 재인증",
          body: "",
          existing: { number: 12, url: "u" },
        },
      ]),
    );
    const plan = buildSyncPlan(
      spec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [epicIssue, ...subs],
    );
    expect(plan.toCreate.epic).toBe(false);
    expect(plan.toCreate.subs).toEqual([]);
    expect(plan.toPatchEpicBody).toBe(false);
    expect(plan.epic.existing).toEqual({
      number: 9,
      url: "https://github.com/x/y/issues/9",
    });
  });

  it("adds only the new bullet when SPEC gains one", () => {
    const oldSpec = makeSpec();
    const subs = oldSpec.bullets.map((b, i) =>
      issue(10 + i, renderSubBody(oldSpec, i + 1, b)),
    );
    const epicIssue = issue(
      9,
      renderEpicBody(oldSpec, [
        { index: 1, title: "x", body: "", existing: { number: 10, url: "u" } },
        { index: 2, title: "x", body: "", existing: { number: 11, url: "u" } },
        { index: 3, title: "x", body: "", existing: { number: 12, url: "u" } },
      ]),
    );
    const newSpec = makeSpec({
      bullets: [...oldSpec.bullets, "프로필 화면"],
    });
    const plan = buildSyncPlan(
      newSpec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [epicIssue, ...subs],
    );
    expect(plan.toCreate.epic).toBe(false);
    expect(plan.toCreate.subs).toEqual([4]);
    expect(plan.toPatchEpicBody).toBe(true);
  });

  it("surfaces orphans (subs whose bullet was removed) without acting on them", () => {
    const oldSpec = makeSpec();
    const subs = oldSpec.bullets.map((b, i) =>
      issue(10 + i, renderSubBody(oldSpec, i + 1, b)),
    );
    // newSpec keeps only 1 bullet — index 2/3 disappeared, index 1's bullet text
    // changed but its marker stayed (sub 1 marker still matches).
    const newSpec = makeSpec({ bullets: ["오직 한 줄만 남음"] });
    const plan = buildSyncPlan(
      newSpec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      subs,
    );
    expect(plan.orphans).toEqual([2, 3]);
    // sub 1 reuses existing issue 10 (marker match — bullet text mutation is
    // out of scope for this PR; sub body patching is a future PR).
    expect(plan.toCreate.subs).toEqual([]);
    expect(plan.subs[0]?.existing).toEqual({
      number: 10,
      url: "https://github.com/x/y/issues/10",
    });
  });

  it("picks the smallest issue number when duplicates share a marker", () => {
    const spec = makeSpec();
    const dup1 = issue(20, renderSubBody(spec, 1, spec.bullets[0] ?? ""));
    const dup2 = issue(15, renderSubBody(spec, 1, spec.bullets[0] ?? ""));
    const plan = buildSyncPlan(
      spec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [dup1, dup2],
    );
    expect(plan.subs[0]?.existing).toEqual({
      number: 15,
      url: "https://github.com/x/y/issues/15",
    });
  });
});

// ── applySyncPlan ────────────────────────────────────────────────────────────

describe("applySyncPlan", () => {
  it("creates 1 epic + N subs in order; epic body references new sub numbers", async () => {
    const spec = makeSpec();
    const plan = buildSyncPlan(spec, "x/y", "spec-pact", ["spec-pact"], []);

    const { exec, calls } = fakeGh([
      () => okIssueCreate(101), // sub 1
      () => okIssueCreate(102), // sub 2
      () => okIssueCreate(103), // sub 3
      () => okIssueCreate(100), // epic
    ]);

    const result = await applySyncPlan(exec, plan, spec);
    expect(result.created.subs.map((s) => s.number)).toEqual([101, 102, 103]);
    expect(result.created.epic?.number).toBe(100);
    expect(result.patchedEpic).toBe(false);

    // last call = epic create, body must reference #101 / #102 / #103
    const epicCall = calls[3];
    expect(epicCall?.args).toContain("create");
    expect(epicCall?.stdin).toContain("- [ ] #101");
    expect(epicCall?.stdin).toContain("- [ ] #102");
    expect(epicCall?.stdin).toContain("- [ ] #103");
  });

  it("re-apply is a no-op (no `gh issue create` / `gh issue edit` calls)", async () => {
    const spec = makeSpec();
    const subs = spec.bullets.map((b, i) =>
      issue(101 + i, renderSubBody(spec, i + 1, b)),
    );
    const epicIssue = issue(
      100,
      renderEpicBody(spec, [
        {
          index: 1,
          title: "[user-auth] 로그인 화면 구현",
          body: "",
          existing: { number: 101, url: "u" },
        },
        {
          index: 2,
          title: "[user-auth] 비밀번호 재설정 플로우",
          body: "",
          existing: { number: 102, url: "u" },
        },
        {
          index: 3,
          title: "[user-auth] 세션 만료 후 재인증",
          body: "",
          existing: { number: 103, url: "u" },
        },
      ]),
    );
    const plan = buildSyncPlan(
      spec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [epicIssue, ...subs],
    );

    const { exec, calls } = fakeGh([]); // no responses needed = no calls

    const result = await applySyncPlan(exec, plan, spec);
    expect(calls.length).toBe(0);
    expect(result.created.subs).toEqual([]);
    expect(result.created.epic).toBeUndefined();
    expect(result.patchedEpic).toBe(false);
    expect(result.reused.epic).toBe(100);
    expect(result.reused.subs).toEqual([101, 102, 103]);
  });

  it("on additive bullet, creates only the new sub and patches the epic", async () => {
    const oldSpec = makeSpec();
    const subs = oldSpec.bullets.map((b, i) =>
      issue(101 + i, renderSubBody(oldSpec, i + 1, b)),
    );
    const epicIssue = issue(
      100,
      renderEpicBody(oldSpec, [
        { index: 1, title: "x", body: "", existing: { number: 101, url: "u" } },
        { index: 2, title: "x", body: "", existing: { number: 102, url: "u" } },
        { index: 3, title: "x", body: "", existing: { number: 103, url: "u" } },
      ]),
    );
    const newSpec = makeSpec({ bullets: [...oldSpec.bullets, "프로필 화면"] });
    const plan = buildSyncPlan(
      newSpec,
      "x/y",
      "spec-pact",
      ["spec-pact"],
      [epicIssue, ...subs],
    );

    const { exec, calls } = fakeGh([
      () => okIssueCreate(104), // sub 4
      () => okEdit(), // epic patch
    ]);

    const result = await applySyncPlan(exec, plan, newSpec);
    expect(result.created.subs.map((s) => s.number)).toEqual([104]);
    expect(result.patchedEpic).toBe(true);
    // last call = epic edit with new body containing #101..#104
    const editCall = calls[1];
    expect(editCall?.args).toContain("edit");
    expect(editCall?.stdin).toContain("- [ ] #104");
    expect(editCall?.stdin).toContain("- [ ] #101");
  });
});

// ── syncSpecToIssues ─────────────────────────────────────────────────────────

describe("syncSpecToIssues", () => {
  it("dryRun=true performs only the list call and returns plan only", async () => {
    const spec = makeSpec();
    const { exec, calls } = fakeGh([() => okJson([])]); // list-by-label returns []
    const out = await syncSpecToIssues(exec, {
      spec,
      repo: "x/y",
      dedupeLabel: "spec-pact",
      labels: ["spec-pact"],
      dryRun: true,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.args[0]).toBe("issue");
    expect(calls[0]?.args[1]).toBe("list");
    expect(out.applied).toBeUndefined();
    expect(out.plan.toCreate.epic).toBe(true);
  });

  it("dryRun=false applies and returns both plan + applied", async () => {
    const spec = makeSpec();
    const { exec } = fakeGh([
      () => okJson([]), // list
      () => okIssueCreate(201), // sub 1
      () => okIssueCreate(202), // sub 2
      () => okIssueCreate(203), // sub 3
      () => okIssueCreate(200), // epic
    ]);
    const out = await syncSpecToIssues(exec, {
      spec,
      repo: "x/y",
      dedupeLabel: "spec-pact",
      labels: ["spec-pact"],
      dryRun: false,
    });
    expect(out.applied?.created.epic?.number).toBe(200);
    expect(out.applied?.created.subs.map((s) => s.number)).toEqual([
      201, 202, 203,
    ]);
  });
});
