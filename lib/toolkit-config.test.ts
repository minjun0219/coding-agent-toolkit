import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  mergeConfigs,
  validateConfig,
  type ToolkitConfig,
} from "./toolkit-config";

let userDir: string;
let userPath: string;
let projectRoot: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agent-toolkit-config-"));
  userDir = join(root, "user");
  mkdirSync(userDir, { recursive: true });
  userPath = join(userDir, "agent-toolkit.json");
  projectRoot = mkdtempSync(join(tmpdir(), "agent-toolkit-project-"));
});

const writeUser = (config: ToolkitConfig) => {
  writeFileSync(userPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

const writeProject = (config: ToolkitConfig) => {
  const dir = join(projectRoot, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-toolkit.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
};

describe("validateConfig", () => {
  it("accepts an empty object", () => {
    expect(validateConfig({}, "test")).toEqual({});
  });

  it("accepts a registry with valid identifiers", () => {
    const config: ToolkitConfig = {
      openapi: {
        registry: {
          acme: { dev: { users: "https://example.com/users.json" } },
        },
      },
    };
    expect(validateConfig(config, "test")).toEqual(config);
  });

  it("rejects non-object root", () => {
    expect(() => validateConfig(null, "p")).toThrow(/must be a JSON object/);
    expect(() => validateConfig([], "p")).toThrow(/must be a JSON object/);
    expect(() => validateConfig("str", "p")).toThrow(/must be a JSON object/);
  });

  it("rejects host name with colon", () => {
    expect(() =>
      validateConfig(
        { openapi: { registry: { "ac:me": { dev: { users: "u" } } } } },
        "p",
      ),
    ).toThrow(/host name/);
  });

  it("rejects env name with whitespace", () => {
    expect(() =>
      validateConfig(
        { openapi: { registry: { acme: { "de v": { users: "u" } } } } },
        "p",
      ),
    ).toThrow(/env name/);
  });

  it("rejects empty / whitespace-only URL", () => {
    expect(() =>
      validateConfig(
        { openapi: { registry: { acme: { dev: { users: "" } } } } },
        "p",
      ),
    ).toThrow(/non-empty URL/);
    expect(() =>
      validateConfig(
        { openapi: { registry: { acme: { dev: { users: "   " } } } } },
        "p",
      ),
    ).toThrow(/non-empty URL/);
  });

  it("rejects non-string URL", () => {
    expect(() =>
      validateConfig(
        { openapi: { registry: { acme: { dev: { users: 42 } } } } },
        "p",
      ),
    ).toThrow(/non-empty URL/);
  });

  it("rejects unparseable URL string", () => {
    expect(() =>
      validateConfig(
        {
          openapi: { registry: { acme: { dev: { users: "not a url" } } } },
        },
        "p",
      ),
    ).toThrow(/not a valid URL/);
  });

  it("rejects unsupported URL scheme", () => {
    expect(() =>
      validateConfig(
        {
          openapi: {
            registry: {
              acme: { dev: { users: "ftp://example.com/spec.json" } },
            },
          },
        },
        "p",
      ),
    ).toThrow(/unsupported scheme/);
  });

  it("accepts http / https / file URLs", () => {
    for (const url of [
      "http://example.com/spec.json",
      "https://example.com/spec.json",
      "file:///tmp/spec.json",
    ]) {
      expect(() =>
        validateConfig(
          { openapi: { registry: { acme: { dev: { users: url } } } } },
          "p",
        ),
      ).not.toThrow();
    }
  });

  it("allows unknown top-level keys for forward compatibility", () => {
    expect(() =>
      validateConfig({ futureFeature: { foo: "bar" } } as any, "p"),
    ).not.toThrow();
  });

  it("accepts a spec block with all known keys", () => {
    expect(() =>
      validateConfig(
        {
          spec: {
            dir: ".agent/specs",
            scanDirectorySpec: true,
            indexFile: "INDEX.md",
          },
        },
        "p",
      ),
    ).not.toThrow();
  });

  it("rejects spec.dir that is empty / whitespace / non-string", () => {
    expect(() =>
      validateConfig({ spec: { dir: "" } } as any, "p"),
    ).toThrow(/spec\.dir/);
    expect(() =>
      validateConfig({ spec: { dir: "  " } } as any, "p"),
    ).toThrow(/spec\.dir/);
    expect(() =>
      validateConfig({ spec: { dir: 42 } } as any, "p"),
    ).toThrow(/spec\.dir/);
  });

  it("rejects spec.scanDirectorySpec that is not boolean", () => {
    expect(() =>
      validateConfig({ spec: { scanDirectorySpec: "yes" } } as any, "p"),
    ).toThrow(/spec\.scanDirectorySpec/);
  });

  it("rejects spec.indexFile that is empty / non-string", () => {
    expect(() =>
      validateConfig({ spec: { indexFile: "" } } as any, "p"),
    ).toThrow(/spec\.indexFile/);
  });

  it("rejects unsupported spec keys (typo guard, schema lockstep)", () => {
    // 오타 — 'scanDirectorySpec' 가 아닌 'scanDirectorySpecs'
    expect(() =>
      validateConfig(
        { spec: { scanDirectorySpecs: true } } as any,
        "p",
      ),
    ).toThrow(/unsupported key "scanDirectorySpecs"/);
    // 알지 못하는 미래 키도 거부 — 단, top-level 미지원 키는 forward-compat 으로 통과해야.
    expect(() =>
      validateConfig({ spec: { unknown: 1 } } as any, "p"),
    ).toThrow(/unsupported key "unknown"/);
  });
});

describe("mergeConfigs", () => {
  it("project overrides user at the leaf", () => {
    const user: ToolkitConfig = {
      openapi: {
        registry: {
          acme: { dev: { users: "https://user/u.json", orders: "https://user/o.json" } },
        },
      },
    };
    const project: ToolkitConfig = {
      openapi: {
        registry: {
          acme: { dev: { users: "https://project/u.json" } },
        },
      },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.openapi?.registry?.acme?.dev?.users).toBe(
      "https://project/u.json",
    );
    // user-only spec survives.
    expect(merged.openapi?.registry?.acme?.dev?.orders).toBe(
      "https://user/o.json",
    );
  });

  it("project can introduce new host / env / spec", () => {
    const user: ToolkitConfig = {
      openapi: { registry: { acme: { dev: { users: "https://u.example/u.json" } } } },
    };
    const project: ToolkitConfig = {
      openapi: {
        registry: {
          acme: { prod: { users: "https://p.example/u.json" } },
          beta: { dev: { svc: "https://b.example/svc.json" } },
        },
      },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.openapi?.registry?.acme?.prod?.users).toBe(
      "https://p.example/u.json",
    );
    expect(merged.openapi?.registry?.beta?.dev?.svc).toBe(
      "https://b.example/svc.json",
    );
    // user 의 dev.users 도 살아 있어야.
    expect(merged.openapi?.registry?.acme?.dev?.users).toBe(
      "https://u.example/u.json",
    );
  });

  it("returns a deep clone — mutating the result does not touch input", () => {
    const user: ToolkitConfig = {
      openapi: { registry: { acme: { dev: { users: "https://u/u.json" } } } },
    };
    const merged = mergeConfigs(user, {});
    merged.openapi!.registry!.acme!.dev!.users = "MUTATED";
    expect(user.openapi?.registry?.acme?.dev?.users).toBe("https://u/u.json");
  });

  it("project overrides user at the spec leaf (per-key)", () => {
    const user: ToolkitConfig = {
      spec: {
        dir: ".agent/specs",
        scanDirectorySpec: true,
        indexFile: "INDEX.md",
      },
    };
    const project: ToolkitConfig = {
      // project 만 dir 와 scanDirectorySpec 를 바꿈 — indexFile 은 user 값 유지.
      spec: { dir: "docs/specs", scanDirectorySpec: false },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.spec?.dir).toBe("docs/specs");
    expect(merged.spec?.scanDirectorySpec).toBe(false);
    expect(merged.spec?.indexFile).toBe("INDEX.md");
  });

  it("preserves project's `false` for spec.scanDirectorySpec (no truthy override)", () => {
    // 회귀 가드: `if (value)` 패턴을 쓰면 false 가 누락된다 — 명시적 != undefined 검사가 필요.
    const user: ToolkitConfig = { spec: { scanDirectorySpec: true } };
    const project: ToolkitConfig = { spec: { scanDirectorySpec: false } };
    const merged = mergeConfigs(user, project);
    expect(merged.spec?.scanDirectorySpec).toBe(false);
  });

  it("project introduces spec when user has none", () => {
    const user: ToolkitConfig = {};
    const project: ToolkitConfig = {
      spec: { dir: ".specs", indexFile: "TOC.md" },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.spec?.dir).toBe(".specs");
    expect(merged.spec?.indexFile).toBe("TOC.md");
  });

  it("user-only spec survives empty project", () => {
    const user: ToolkitConfig = {
      spec: { dir: ".agent/specs", scanDirectorySpec: false },
    };
    const merged = mergeConfigs(user, {});
    expect(merged.spec?.dir).toBe(".agent/specs");
    expect(merged.spec?.scanDirectorySpec).toBe(false);
  });
});

describe("loadConfig", () => {
  it("returns {} with no errors when neither file exists", async () => {
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.config).toEqual({});
    expect(r.errors).toEqual([]);
  });

  it("loads user-only when project is absent", async () => {
    writeUser({
      openapi: { registry: { acme: { dev: { users: "https://u/u.json" } } } },
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.config.openapi?.registry?.acme?.dev?.users).toBe("https://u/u.json");
    expect(r.errors).toEqual([]);
  });

  it("loads project-only when user is absent", async () => {
    writeProject({
      openapi: { registry: { acme: { prod: { users: "https://p/u.json" } } } },
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.config.openapi?.registry?.acme?.prod?.users).toBe(
      "https://p/u.json",
    );
    expect(r.errors).toEqual([]);
  });

  it("merges with project taking precedence", async () => {
    writeUser({
      openapi: { registry: { acme: { dev: { users: "https://user/u.json" } } } },
    });
    writeProject({
      openapi: {
        registry: { acme: { dev: { users: "https://project/u.json" } } },
      },
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.config.openapi?.registry?.acme?.dev?.users).toBe(
      "https://project/u.json",
    );
  });

  it("reports malformed JSON in errors[] without throwing", async () => {
    writeFileSync(userPath, "{ not json", "utf8");
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.source).toBe(userPath);
    expect(r.errors[0]?.message).toMatch(/Failed to parse/);
    expect(r.config).toEqual({});
  });

  it("reports schema-violating config in errors[] without throwing", async () => {
    writeUser({
      openapi: { registry: { "bad:host": { dev: { users: "u" } } } } as any,
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.message).toMatch(/host name/);
  });

  it("preserves valid project config when user file is malformed (Codex P1)", async () => {
    writeFileSync(userPath, "{ broken", "utf8");
    writeProject({
      openapi: {
        registry: { acme: { prod: { users: "https://api.acme/u.json" } } },
      },
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.source).toBe(userPath);
    // 핵심: project 의 host:env:spec 이 그대로 살아나야.
    expect(r.config.openapi?.registry?.acme?.prod?.users).toBe(
      "https://api.acme/u.json",
    );
  });

  it("preserves valid user config when project file is malformed", async () => {
    writeUser({
      openapi: {
        registry: { acme: { dev: { users: "https://dev.acme/u.json" } } },
      },
    });
    const projectFile = join(projectRoot, ".opencode", "agent-toolkit.json");
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(projectFile, "{ also broken", "utf8");
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.source).toBe(projectFile);
    expect(r.config.openapi?.registry?.acme?.dev?.users).toBe(
      "https://dev.acme/u.json",
    );
  });

  it("collects errors from both files when both are malformed", async () => {
    writeFileSync(userPath, "{ user broken", "utf8");
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".opencode", "agent-toolkit.json"),
      "{ project broken",
      "utf8",
    );
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors.length).toBe(2);
    expect(r.config).toEqual({});
  });

  it("merges spec block with project taking precedence at the leaf", async () => {
    writeUser({
      spec: {
        dir: ".agent/specs",
        scanDirectorySpec: true,
        indexFile: "INDEX.md",
      },
    });
    writeProject({
      spec: { dir: "docs/specs", scanDirectorySpec: false },
    });
    const r = await loadConfig({ userPath, projectRoot });
    expect(r.errors).toEqual([]);
    expect(r.config.spec?.dir).toBe("docs/specs");
    expect(r.config.spec?.scanDirectorySpec).toBe(false);
    // user 값 유지 — project 가 indexFile 을 안 줬으면 user 의 값이 살아남는다.
    expect(r.config.spec?.indexFile).toBe("INDEX.md");
  });
});
