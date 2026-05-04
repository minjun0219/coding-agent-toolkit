import { describe, expect, it } from "bun:test";

import {
  GhAuthError,
  GhCommandError,
  GhDeniedCommandError,
  type GhExecResult,
  type GhExecutor,
  type GhIssueListItem,
  assertGhAuthed,
  classifyGhCommand,
  detectRepo,
  ghApiGet,
  ghIssueCreate,
  ghIssueEdit,
  ghIssueListByLabel,
  runGhCommand,
} from "./gh-cli";

interface QueuedResponse {
  expectArgsPrefix?: readonly string[];
  result: GhExecResult;
}

const fakeExec = (
  queue: QueuedResponse[],
): {
  exec: GhExecutor;
  calls: Array<{ args: readonly string[]; stdin?: string }>;
} => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const exec: GhExecutor = {
    async run(args, stdin) {
      calls.push({ args, stdin });
      const next = queue.shift();
      if (!next)
        throw new Error(`fakeExec: no response queued for ${args.join(" ")}`);
      if (next.expectArgsPrefix) {
        for (let i = 0; i < next.expectArgsPrefix.length; i++) {
          if (args[i] !== next.expectArgsPrefix[i]) {
            throw new Error(
              `fakeExec: arg[${i}] expected ${next.expectArgsPrefix[i]} got ${args[i]}`,
            );
          }
        }
      }
      return next.result;
    },
  };
  return { exec, calls };
};

describe("assertGhAuthed", () => {
  it("returns silently on exit 0", async () => {
    const { exec } = fakeExec([
      {
        expectArgsPrefix: ["auth", "status"],
        result: { stdout: "Logged in to github.com", stderr: "", exitCode: 0 },
      },
    ]);
    await expect(assertGhAuthed(exec)).resolves.toBeUndefined();
  });

  it("throws GhAuthError with one-line login guide on non-zero exit", async () => {
    const { exec } = fakeExec([
      {
        result: { stdout: "", stderr: "You are not logged in", exitCode: 1 },
      },
    ]);
    await expect(assertGhAuthed(exec)).rejects.toBeInstanceOf(GhAuthError);
    await expect(assertGhAuthed.bind(null, exec)).toThrow; // sanity
  });
});

describe("detectRepo", () => {
  it("returns the override when shape is owner/name", async () => {
    const { exec, calls } = fakeExec([]);
    const repo = await detectRepo(exec, "minjun0219/agent-toolkit");
    expect(repo).toBe("minjun0219/agent-toolkit");
    expect(calls.length).toBe(0); // no gh call when override is used
  });

  it("rejects malformed override before calling gh", async () => {
    const { exec, calls } = fakeExec([]);
    await expect(detectRepo(exec, "not-a-repo")).rejects.toThrow(
      /repo override must be `owner\/name`/,
    );
    expect(calls.length).toBe(0);
  });

  it("auto-detects via `gh repo view` when no override is given", async () => {
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["repo", "view"],
        result: {
          stdout: "minjun0219/agent-toolkit\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ]);
    const repo = await detectRepo(exec);
    expect(repo).toBe("minjun0219/agent-toolkit");
    expect(calls[0]?.args).toContain("nameWithOwner");
  });

  it("throws GhCommandError when gh repo view fails", async () => {
    const { exec } = fakeExec([
      {
        result: { stdout: "", stderr: "not in a git repo", exitCode: 1 },
      },
    ]);
    await expect(detectRepo(exec)).rejects.toBeInstanceOf(GhCommandError);
  });
});

describe("ghIssueCreate", () => {
  it("calls `gh issue create` with --body-file - and parses the issue url", async () => {
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["issue", "create", "--repo", "x/y"],
        result: {
          stdout: "https://github.com/x/y/issues/42\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ]);
    const ref = await ghIssueCreate(exec, {
      repo: "x/y",
      title: "epic",
      body: "<!-- spec-pact:slug=foo:kind=epic -->\nbody",
      labels: ["spec-pact"],
    });
    expect(ref).toEqual({
      number: 42,
      url: "https://github.com/x/y/issues/42",
    });
    expect(calls[0]?.args).toContain("--body-file");
    expect(calls[0]?.args).toContain("--label");
    expect(calls[0]?.stdin).toContain("spec-pact:slug=foo:kind=epic");
  });

  it("throws GhCommandError on non-zero exit", async () => {
    const { exec } = fakeExec([
      { result: { stdout: "", stderr: "label not found", exitCode: 1 } },
    ]);
    await expect(
      ghIssueCreate(exec, { repo: "x/y", title: "t", body: "b" }),
    ).rejects.toBeInstanceOf(GhCommandError);
  });
});

describe("ghIssueEdit", () => {
  it("passes new body via stdin and add-label flags", async () => {
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["issue", "edit", "42", "--repo", "x/y"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    await ghIssueEdit(exec, {
      repo: "x/y",
      number: 42,
      body: "patched",
      addLabels: ["spec-pact"],
    });
    expect(calls[0]?.stdin).toBe("patched");
    expect(calls[0]?.args).toContain("--add-label");
  });
});

describe("ghIssueListByLabel", () => {
  it("requests --json with the right fields and normalizes string labels", async () => {
    const payload: GhIssueListItem[] = [
      {
        number: 1,
        title: "epic",
        body: "<!-- spec-pact:slug=foo:kind=epic -->",
        url: "https://github.com/x/y/issues/1",
        labels: ["spec-pact"],
      },
    ];
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["issue", "list", "--repo", "x/y"],
        result: { stdout: JSON.stringify(payload), stderr: "", exitCode: 0 },
      },
    ]);
    const items = await ghIssueListByLabel(exec, "x/y", "spec-pact");
    expect(items).toEqual(payload);
    expect(calls[0]?.args).toContain("number,title,body,url,labels");
    expect(calls[0]?.args).toContain("--state");
    // default limit 1000 (Codex P2 — 500 hard cap removed)
    expect(calls[0]?.args).toContain("1000");
    // search not passed → no --search flag in args
    expect(calls[0]?.args).not.toContain("--search");
  });

  it("appends --search when options.search is given (marker-prefix dedupe)", async () => {
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["issue", "list", "--repo", "x/y"],
        result: { stdout: "[]", stderr: "", exitCode: 0 },
      },
    ]);
    await ghIssueListByLabel(exec, "x/y", "spec-pact", {
      search: "<!-- spec-pact:slug=foo:",
    });
    const args = calls[0]?.args ?? [];
    expect(args).toContain("--search");
    expect(args).toContain("<!-- spec-pact:slug=foo:");
  });

  it("honors caller-provided limit", async () => {
    const { exec, calls } = fakeExec([
      { result: { stdout: "[]", stderr: "", exitCode: 0 } },
    ]);
    await ghIssueListByLabel(exec, "x/y", "spec-pact", { limit: 50 });
    expect(calls[0]?.args).toContain("50");
  });

  it("normalizes object-shaped labels (older/newer gh)", async () => {
    const stdout = JSON.stringify([
      {
        number: 7,
        title: "t",
        body: "b",
        url: "u",
        labels: [{ name: "spec-pact" }, { name: "extra" }],
      },
    ]);
    const { exec } = fakeExec([
      { result: { stdout, stderr: "", exitCode: 0 } },
    ]);
    const items = await ghIssueListByLabel(exec, "x/y", "spec-pact");
    expect(items[0]?.labels).toEqual(["spec-pact", "extra"]);
  });

  it("returns [] for empty stdout", async () => {
    const { exec } = fakeExec([
      { result: { stdout: "", stderr: "", exitCode: 0 } },
    ]);
    const items = await ghIssueListByLabel(exec, "x/y", "spec-pact");
    expect(items).toEqual([]);
  });

  it("includes stdout head in the JSON parse error", async () => {
    const { exec } = fakeExec([
      {
        result: { stdout: "not-json oops", stderr: "", exitCode: 0 },
      },
    ]);
    await expect(ghIssueListByLabel(exec, "x/y", "spec-pact")).rejects.toThrow(
      /stdout head: not-json oops/,
    );
  });
});

describe("ghApiGet", () => {
  it("parses JSON stdout from `gh api <path>`", async () => {
    const { exec, calls } = fakeExec([
      {
        expectArgsPrefix: ["api", "repos/x/y"],
        result: { stdout: '{"id":1}', stderr: "", exitCode: 0 },
      },
    ]);
    const result = await ghApiGet<{ id: number }>(exec, "repos/x/y");
    expect(result).toEqual({ id: 1 });
    expect(calls[0]?.args).toEqual(["api", "repos/x/y"]);
  });

  it("returns undefined on empty stdout", async () => {
    const { exec } = fakeExec([
      { result: { stdout: "", stderr: "", exitCode: 0 } },
    ]);
    const result = await ghApiGet(exec, "repos/x/y");
    expect(result).toBeUndefined();
  });
});

describe("classifyGhCommand", () => {
  it("classifies read commands as read", () => {
    expect(classifyGhCommand(["auth", "status"])).toBe("read");
    expect(classifyGhCommand(["repo", "view", "x/y"])).toBe("read");
    expect(classifyGhCommand(["issue", "list", "--repo", "x/y"])).toBe("read");
    expect(classifyGhCommand(["pr", "view", "42"])).toBe("read");
    expect(classifyGhCommand(["search", "issues", "marker"])).toBe("read");
  });

  it("classifies write commands as write", () => {
    expect(classifyGhCommand(["issue", "create", "--title", "x"])).toBe(
      "write",
    );
    expect(classifyGhCommand(["pr", "merge", "42"])).toBe("write");
    expect(classifyGhCommand(["label", "create", "spec-pact"])).toBe("write");
    expect(classifyGhCommand(["repo", "delete", "x/y"])).toBe("write");
  });

  it("classifies environment-affecting commands as deny", () => {
    expect(classifyGhCommand(["auth", "login"])).toBe("deny");
    expect(classifyGhCommand(["auth", "logout"])).toBe("deny");
    expect(classifyGhCommand(["extension", "install", "owner/repo"])).toBe(
      "deny",
    );
    expect(classifyGhCommand(["alias", "set", "co", "pr checkout"])).toBe(
      "deny",
    );
    expect(classifyGhCommand(["config", "set", "git_protocol", "ssh"])).toBe(
      "deny",
    );
    expect(classifyGhCommand(["gist", "create", "file.txt"])).toBe("deny");
  });

  it("classifies unknown / empty commands as deny (allow-list policy)", () => {
    expect(classifyGhCommand([])).toBe("deny");
    expect(classifyGhCommand(["unknown-noun", "verb"])).toBe("deny");
    expect(classifyGhCommand(["issue"])).toBe("deny"); // no verb
    expect(classifyGhCommand(["issue", "frobnicate"])).toBe("deny");
  });

  it("splits `gh api` by --method (GET/HEAD = read, POST/PUT/PATCH/DELETE = write)", () => {
    expect(classifyGhCommand(["api", "repos/x/y"])).toBe("read"); // default GET
    expect(classifyGhCommand(["api", "repos/x/y", "--method", "GET"])).toBe(
      "read",
    );
    expect(classifyGhCommand(["api", "repos/x/y", "-X", "HEAD"])).toBe("read");
    expect(classifyGhCommand(["api", "repos/x/y", "--method", "POST"])).toBe(
      "write",
    );
    expect(classifyGhCommand(["api", "repos/x/y", "--method=DELETE"])).toBe(
      "write",
    );
    expect(classifyGhCommand(["api", "repos/x/y", "--method", "PATCH"])).toBe(
      "write",
    );
  });

  it("treats `gh api` with body-bearing flags as write (default POST per gh manual — Codex P1)", () => {
    // -f / -F / --field / --raw-field / --input / -b / --body-file → default POST
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "-f", "title=hi"]),
    ).toBe("write");
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "-F", "labels[]=bug"]),
    ).toBe("write");
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "--field", "title=hi"]),
    ).toBe("write");
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "--field=title=hi"]),
    ).toBe("write");
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "--input", "body.json"]),
    ).toBe("write");
    expect(
      classifyGhCommand(["api", "repos/x/y/issues", "-b", "body.json"]),
    ).toBe("write");
    expect(
      classifyGhCommand([
        "api",
        "repos/x/y/issues",
        "--body-file",
        "body.json",
      ]),
    ).toBe("write");
  });

  it("explicit `--method GET` wins over body flags", () => {
    expect(
      classifyGhCommand(["api", "repos/x/y", "--method", "GET", "-f", "key=v"]),
    ).toBe("read");
  });
});

describe("runGhCommand", () => {
  it("read: executes immediately, ignores dryRun", async () => {
    const { exec, calls } = fakeExec([
      { result: { stdout: "x/y\n", stderr: "", exitCode: 0 } },
    ]);
    const result = await runGhCommand(exec, ["repo", "view"], {
      dryRun: true,
    });
    expect(result.kind).toBe("read");
    expect(result.executed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.stdout).toBe("x/y\n");
    expect(calls.length).toBe(1);
  });

  it("write + dryRun=true (default): plans only, no exec call", async () => {
    const { exec, calls } = fakeExec([]);
    const result = await runGhCommand(exec, [
      "issue",
      "create",
      "--repo",
      "x/y",
      "--title",
      "t",
    ]);
    expect(result.kind).toBe("write");
    expect(result.executed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.stdout).toContain("(dry-run, not executed)");
    expect(calls.length).toBe(0);
  });

  it("write + dryRun=false: executes", async () => {
    const { exec, calls } = fakeExec([
      {
        result: {
          stdout: "https://github.com/x/y/issues/9\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ]);
    const result = await runGhCommand(
      exec,
      ["issue", "create", "--repo", "x/y", "--title", "t"],
      { dryRun: false },
    );
    expect(result.executed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("deny: throws GhDeniedCommandError without calling exec", async () => {
    const { exec, calls } = fakeExec([]);
    await expect(runGhCommand(exec, ["auth", "login"])).rejects.toBeInstanceOf(
      GhDeniedCommandError,
    );
    expect(calls.length).toBe(0);
  });

  it("read: throws GhCommandError on non-zero exitCode (Codex P2 — consistency with wrappers)", async () => {
    const { exec } = fakeExec([
      {
        result: {
          stdout: "",
          stderr: "could not resolve repo",
          exitCode: 1,
        },
      },
    ]);
    await expect(runGhCommand(exec, ["repo", "view"])).rejects.toBeInstanceOf(
      GhCommandError,
    );
  });

  it("write apply: throws GhCommandError on non-zero exitCode", async () => {
    const { exec } = fakeExec([
      {
        result: { stdout: "", stderr: "permission denied", exitCode: 1 },
      },
    ]);
    await expect(
      runGhCommand(exec, ["issue", "create", "--repo", "x/y", "--title", "t"], {
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(GhCommandError);
  });
});
