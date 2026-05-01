import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubIssueClient,
  buildIssuePlan,
  epicMarker,
  flattenSyncResult,
  matchPlanToExisting,
  parseRepoHandle,
  parseSpecBody,
  readAndParseSpec,
  resolveSpecPath,
  subMarker,
  syncSpecToIssues,
  type IssueRef,
} from "./github-issue-sync";

const SPEC_FRONTMATTER = `---
source_page_id: "1234abcd-1234-abcd-1234-abcd1234abcd"
source_url: "https://www.notion.so/team/Auth-1234abcd1234abcd1234abcd1234abcd"
source_content_hash: "9f3a1b2c4d5e6f70"
agreed_at: "2026-05-01T10:42:00Z"
agreed_sections: ["요구사항", "화면", "API", "TODO"]
negotiator_agent: "grace"
spec_pact_version: 1
slug: "user-auth"
status: "locked"
---

# 요약
사용자 인증 (이메일/비밀번호 + 소셜 로그인) 합의안.

# 합의 요구사항
- 이메일 + 비밀번호 로그인 지원
- 구글 / 깃허브 소셜 로그인

# 합의 화면
- 로그인 화면 — 이메일/비번 + 소셜 버튼

# API 의존성
- POST /auth/login — 이메일 / 비밀번호 검증
- GET /me — 토큰 검증

# 합의 TODO
- 로그인 폼 컴포넌트 작성
- POST /auth/login 호출 클라이언트
  - 토큰 저장은 localStorage 가 아니라 httpOnly 쿠키 (들여쓰기 — 부연이라 무시)
- /me 호출로 세션 확인 hook
- 로그아웃 버튼 + 토큰 삭제

# 보류된 이슈
- 비밀번호 reset 흐름 (다음 합의)

# 변경 이력
- 2026-05-01 v1 anchored — 노션 hash 9f3a1b2c 기준
`;

describe("parseSpecBody", () => {
  it("extracts frontmatter, summary, and top-level TODO bullets", () => {
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    expect(parsed.slug).toBe("user-auth");
    expect(parsed.sourcePageId).toBe(
      "1234abcd-1234-abcd-1234-abcd1234abcd",
    );
    expect(parsed.sourceUrl).toContain("https://www.notion.so/");
    expect(parsed.specPactVersion).toBe(1);
    expect(parsed.status).toBe("locked");
    expect(parsed.summary.startsWith("사용자 인증")).toBe(true);
    // 들여쓰기 bullet (`  - 토큰 저장은…`) 은 부연으로 무시.
    expect(parsed.todos).toEqual([
      "로그인 폼 컴포넌트 작성",
      "POST /auth/login 호출 클라이언트",
      "/me 호출로 세션 확인 hook",
      "로그아웃 버튼 + 토큰 삭제",
    ]);
  });

  it("throws when slug is missing in frontmatter", () => {
    const noSlug = SPEC_FRONTMATTER.replace(/slug: "user-auth"\n/, "");
    expect(() => parseSpecBody(noSlug)).toThrow(/slug/);
  });

  it("returns empty todos when `# 합의 TODO` is absent", () => {
    const trimmed = `---
slug: "ghost"
spec_pact_version: 1
---

# 요약
빈 SPEC.
`;
    const p = parseSpecBody(trimmed);
    expect(p.todos).toEqual([]);
    expect(p.summary).toBe("빈 SPEC.");
  });

  it("treats version absence as 1", () => {
    const v = parseSpecBody(`---
slug: "x"
---
`);
    expect(v.specPactVersion).toBe(1);
  });
});

describe("resolveSpecPath", () => {
  it("resolves slug under specDir", () => {
    const r = resolveSpecPath({
      slug: "user-auth",
      specDir: "specs",
      projectRoot: "/tmp/proj",
    });
    expect(r.path).toBe("/tmp/proj/specs/user-auth.md");
    expect(r.slug).toBe("user-auth");
  });
  it("uses path as-is when path is given", () => {
    const r = resolveSpecPath({
      path: "apps/web/orders/SPEC.md",
      projectRoot: "/tmp/proj",
    });
    expect(r.path).toBe("/tmp/proj/apps/web/orders/SPEC.md");
  });
  it("throws when both slug and path are passed", () => {
    expect(() => resolveSpecPath({ slug: "a", path: "b" })).toThrow(/both/);
  });
  it("throws when neither slug nor path is passed", () => {
    expect(() => resolveSpecPath({})).toThrow(/either/);
  });
});

describe("readAndParseSpec", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issue-sync-spec-"));
  });
  it("reads a SPEC file from disk and parses it", async () => {
    const path = join(dir, "user-auth.md");
    writeFileSync(path, SPEC_FRONTMATTER, "utf8");
    const p = await readAndParseSpec(path);
    expect(p.slug).toBe("user-auth");
    expect(p.todos.length).toBeGreaterThan(0);
  });
  it("throws when file is missing", async () => {
    await expect(readAndParseSpec(join(dir, "missing.md"))).rejects.toThrow(
      /not found/,
    );
  });
});

describe("buildIssuePlan", () => {
  it("creates one epic + one sub per TODO with embedded markers", () => {
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    const plan = buildIssuePlan(parsed, ".agent/specs/user-auth.md");
    expect(plan.epic.kind).toBe("epic");
    expect(plan.epic.title).toBe("[spec] user-auth v1");
    expect(plan.epic.body).toContain(epicMarker("user-auth"));
    expect(plan.subs.length).toBe(parsed.todos.length);
    plan.subs.forEach((s, i) => {
      expect(s.kind).toBe("sub");
      expect(s.index).toBe(i);
      expect(s.body).toContain(subMarker("user-auth", i));
      // 첫 단어가 SPEC bullet 의 시작과 같아야 함 (clamp 으로 잘렸을 수 있음).
      expect(s.title.startsWith(`[user-auth] `)).toBe(true);
    });
  });
});

describe("matchPlanToExisting", () => {
  it("matches epic / sub by marker substring; misses leave existing undefined", () => {
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    const plan = buildIssuePlan(parsed, ".agent/specs/user-auth.md");
    const existing: IssueRef[] = [
      {
        number: 11,
        htmlUrl: "https://github.com/o/r/issues/11",
        state: "open",
        title: "[spec] user-auth v1",
        body: `header\n${epicMarker("user-auth")}\n`,
      },
      {
        number: 12,
        htmlUrl: "https://github.com/o/r/issues/12",
        state: "closed",
        title: "[user-auth] 로그인 폼 컴포넌트 작성",
        body: `whatever\n${subMarker("user-auth", 0)}\n`,
      },
    ];
    const matched = matchPlanToExisting(plan, existing, "user-auth");
    expect(matched.epic.existing?.number).toBe(11);
    expect(matched.subs[0]?.existing?.number).toBe(12);
    // 다른 sub 들은 매칭이 없어야 (없는 마커이므로 undefined).
    expect(matched.subs.slice(1).every((s) => !s.existing)).toBe(true);
  });

  it("prefers the smallest issue number when the same marker is duplicated", () => {
    const plan = buildIssuePlan(
      parseSpecBody(SPEC_FRONTMATTER),
      ".agent/specs/user-auth.md",
    );
    const m = subMarker("user-auth", 0);
    const existing: IssueRef[] = [
      { number: 50, htmlUrl: "", state: "closed", title: "x", body: m },
      { number: 5, htmlUrl: "", state: "open", title: "x", body: m },
    ];
    const matched = matchPlanToExisting(plan, existing, "user-auth");
    expect(matched.subs[0]?.existing?.number).toBe(5);
  });
});

describe("parseRepoHandle", () => {
  it("parses owner/repo", () => {
    expect(parseRepoHandle("acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });
  it("throws on missing slash", () => {
    expect(() => parseRepoHandle("acme")).toThrow(/owner\/repo/);
  });
  it("throws on extra segments", () => {
    expect(() => parseRepoHandle("acme/widgets/extra")).toThrow(/owner\/repo/);
  });
});

describe("syncSpecToIssues (against mocked GitHub API)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  /** 서버가 보유한 issue 들. 마커 / 라벨 기반 lookup 도 여기서 처리. */
  let issues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: string;
  }>;
  let nextNumber: number;
  let createCalls: number;
  let patchCalls: number;

  beforeEach(() => {
    issues = [];
    nextNumber = 100;
    createCalls = 0;
    patchCalls = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        // GET /repos/o/r/issues
        if (
          url.pathname === "/repos/acme/widgets/issues" &&
          req.method === "GET"
        ) {
          const labels = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
          const filtered = issues.filter((i) =>
            labels.length === 0
              ? true
              : labels.every((l) => i.labels.includes(l)),
          );
          const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
          const perPage = Number.parseInt(
            url.searchParams.get("per_page") ?? "30",
            10,
          );
          const start = (page - 1) * perPage;
          const slice = filtered.slice(start, start + perPage);
          return Response.json(
            slice.map((i) => ({
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              html_url: `${baseUrl}/issue/${i.number}`,
            })),
          );
        }
        // POST /repos/o/r/issues
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
        // PATCH /repos/o/r/issues/:n
        const patchMatch = url.pathname.match(
          /^\/repos\/acme\/widgets\/issues\/(\d+)$/,
        );
        if (patchMatch && req.method === "PATCH") {
          patchCalls += 1;
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

  function client(): GithubIssueClient {
    return new GithubIssueClient({
      token: "ghp_test",
      owner: "acme",
      repo: "widgets",
      apiBaseUrl: baseUrl,
    });
  }

  it("first run: creates one epic + N subs and patches epic body with sub refs", async () => {
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    const result = await syncSpecToIssues({
      parsed,
      specPath: ".agent/specs/user-auth.md",
      client: client(),
    });
    expect(result.applied).toBe(true);
    // sub 4 개 + epic 1 개 = create 5 회
    expect(createCalls).toBe(5);
    expect(patchCalls).toBe(0);
    expect(result.epic.created?.number).toBeDefined();
    expect(result.subs.every((s) => s.created?.number !== undefined)).toBe(
      true,
    );
    const flat = flattenSyncResult(result);
    expect(flat.applied).toBe(true);
    expect(flat.epic.existed).toBe(false);
    expect(flat.subs.length).toBe(4);
    expect(flat.subs.every((s) => !s.existed)).toBe(true);
    // epic body 의 task list 가 sub-issue 번호로 채워졌는지 — 서버에 저장된 body 로 확인.
    const epic = issues.find((i) => i.number === result.epic.created!.number)!;
    expect(epic.body).toContain(`(#${result.subs[0]?.created?.number})`);
    expect(epic.body).not.toContain("<!-- sub:0 -->");
  });

  it("second run: dedupes by marker — no new issues, no patch unless body changes", async () => {
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    await syncSpecToIssues({
      parsed,
      specPath: ".agent/specs/user-auth.md",
      client: client(),
    });
    const initialIssueCount = issues.length;
    const initialCreateCalls = createCalls;
    // 두 번째 호출 — 같은 SPEC, 같은 plan.
    const second = await syncSpecToIssues({
      parsed,
      specPath: ".agent/specs/user-auth.md",
      client: client(),
    });
    expect(second.applied).toBe(true);
    expect(issues.length).toBe(initialIssueCount);
    expect(createCalls).toBe(initialCreateCalls);
    // existing 매칭이 모두 잡혀야.
    expect(second.epic.existing).toBeDefined();
    expect(second.subs.every((s) => s.existing !== undefined)).toBe(true);
    expect(second.subs.every((s) => s.created === undefined)).toBe(true);
    // 이미 같은 epic body 가 박혀 있으므로 patch 도 0 회 (body 동일성 검사).
    expect(patchCalls).toBe(0);
  });

  it("dryRun: builds plan + matches existing but makes no remote write", async () => {
    // 사전 setup — epic 과 sub 0 만 미리 만들어 둔다.
    issues.push({
      number: 1,
      title: "[spec] user-auth v1",
      body: `seeded\n${epicMarker("user-auth")}\n`,
      labels: ["spec-pact"],
      state: "open",
    });
    issues.push({
      number: 2,
      title: "[user-auth] 로그인 폼 컴포넌트 작성",
      body: `seeded\n${subMarker("user-auth", 0)}\n`,
      labels: ["spec-pact"],
      state: "closed",
    });

    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    const r = await syncSpecToIssues({
      parsed,
      specPath: ".agent/specs/user-auth.md",
      client: client(),
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(createCalls).toBe(0);
    expect(patchCalls).toBe(0);
    expect(r.epic.existing?.number).toBe(1);
    expect(r.subs[0]?.existing?.number).toBe(2);
    expect(r.subs[0]?.existing?.state).toBe("closed");
    // 나머지 sub 는 매칭 X — 신규 생성 후보 (apply 시).
    expect(r.subs.slice(1).every((s) => !s.existing)).toBe(true);
  });

  it("partial existing: creates only missing subs, then patches epic body with all refs", async () => {
    issues.push({
      number: 1,
      title: "[spec] user-auth v1",
      body: `seeded\n${epicMarker("user-auth")}\n`,
      labels: ["spec-pact"],
      state: "open",
    });
    issues.push({
      number: 2,
      title: "[user-auth] 로그인 폼 컴포넌트 작성",
      body: `seeded\n${subMarker("user-auth", 0)}\n`,
      labels: ["spec-pact"],
      state: "open",
    });

    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    const r = await syncSpecToIssues({
      parsed,
      specPath: ".agent/specs/user-auth.md",
      client: client(),
    });
    expect(r.applied).toBe(true);
    // sub 3 개만 새로 (인덱스 1,2,3). epic 은 이미 있음.
    expect(createCalls).toBe(3);
    // epic body 갱신 1 회 — 새 sub ref 가 task list 에 박혀야 하므로.
    expect(patchCalls).toBe(1);
    const epic = issues.find((i) => i.number === 1)!;
    // 매칭된 sub (#2) 와 새로 만든 sub 들 모두 task list 에 박혀야.
    expect(epic.body).toContain(`(#2)`);
    for (const s of r.subs.slice(1)) {
      expect(epic.body).toContain(`(#${s.created!.number})`);
    }
  });

  it("returns clear error when API responds with non-2xx", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("forbidden", { status: 403 });
      },
    });
    baseUrl = `http://${server.hostname}:${server.port}`;
    const parsed = parseSpecBody(SPEC_FRONTMATTER);
    await expect(
      syncSpecToIssues({
        parsed,
        specPath: ".agent/specs/user-auth.md",
        client: client(),
      }),
    ).rejects.toThrow(/403/);
  });
});
