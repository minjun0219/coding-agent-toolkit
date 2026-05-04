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
    expect(() => validateConfig({ spec: { dir: "" } } as any, "p")).toThrow(
      /spec\.dir/,
    );
    expect(() => validateConfig({ spec: { dir: "  " } } as any, "p")).toThrow(
      /spec\.dir/,
    );
    expect(() => validateConfig({ spec: { dir: 42 } } as any, "p")).toThrow(
      /spec\.dir/,
    );
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
      validateConfig({ spec: { scanDirectorySpecs: true } } as any, "p"),
    ).toThrow(/unsupported key "scanDirectorySpecs"/);
    // 알지 못하는 미래 키도 거부 — 단, top-level 미지원 키는 forward-compat 으로 통과해야.
    expect(() => validateConfig({ spec: { unknown: 1 } } as any, "p")).toThrow(
      /unsupported key "unknown"/,
    );
  });

  it("accepts mysql.connections with passwordEnv profile", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: {
                    host: "db.example.com",
                    port: 3306,
                    user: "readonly",
                    database: "app",
                    passwordEnv: "MYSQL_ACME_PROD_USERS_PASSWORD",
                  },
                },
              },
            },
          },
        },
        "p",
      ),
    ).not.toThrow();
  });

  it("accepts mysql.connections with dsnEnv profile (decomposed fields omitted)", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: { users: { dsnEnv: "MYSQL_ACME_PROD_USERS_DSN" } },
              },
            },
          },
        },
        "p",
      ),
    ).not.toThrow();
  });

  it("rejects mysql profile that declares both passwordEnv and dsnEnv", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: {
                    host: "db.example.com",
                    user: "u",
                    database: "app",
                    passwordEnv: "P",
                    dsnEnv: "D",
                  },
                },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/exactly one of "passwordEnv" or "dsnEnv".*both/);
  });

  it("rejects mysql profile that declares neither passwordEnv nor dsnEnv", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: { host: "db.example.com", user: "u", database: "app" },
                },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/exactly one of "passwordEnv" or "dsnEnv".*neither/);
  });

  it("rejects mysql profile with dsnEnv plus a decomposed field", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: { users: { dsnEnv: "D", host: "db.example.com" } },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/dsnEnv.*host/);
  });

  it("rejects mysql profile missing host / user / database when passwordEnv is used", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: { passwordEnv: "P", user: "u", database: "app" },
                },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/\.host must be a non-empty string/);
  });

  it("rejects mysql.port outside 1..65535", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: {
                    host: "h",
                    port: 0,
                    user: "u",
                    database: "d",
                    passwordEnv: "P",
                  },
                },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/port must be an integer in 1\.\.65535/);
  });

  it("rejects mysql host name with colon (handle separator reserved)", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              "ac:me": {
                prod: { users: { dsnEnv: "D" } },
              },
            },
          },
        },
        "p",
      ),
    ).toThrow(/mysql host name/);
  });

  it("rejects unsupported mysql profile keys (typo guard, schema lockstep)", () => {
    expect(() =>
      validateConfig(
        {
          mysql: {
            connections: {
              acme: {
                prod: {
                  users: { dsnEnv: "D", typo: "x" },
                },
              },
            },
          },
        } as any,
        "p",
      ),
    ).toThrow(/unsupported key "typo"/);
  });

  it("accepts a github.repositories block with all known fields", () => {
    expect(() =>
      validateConfig(
        {
          github: {
            repositories: {
              "minjun0219/agent-toolkit": {
                alias: "toolkit",
                labels: ["bug", "review"],
                defaultBranch: "main",
                mergeMode: "squash",
              },
            },
          },
        },
        "p",
      ),
    ).not.toThrow();
  });

  it("accepts an empty github.repositories profile object", () => {
    // 등록만으로도 의미가 있다 — allow-list 역할.
    expect(() =>
      validateConfig({ github: { repositories: { "o/r": {} } } }, "p"),
    ).not.toThrow();
  });

  it("rejects github repo key without slash", () => {
    expect(() =>
      validateConfig({ github: { repositories: { "no-slash": {} } } }, "p"),
    ).toThrow(/github repository key/);
  });

  it("rejects github repo key with too many slashes", () => {
    expect(() =>
      validateConfig({ github: { repositories: { "a/b/c": {} } } }, "p"),
    ).toThrow(/github repository key/);
  });

  it("rejects github profile alias that violates ID_PATTERN", () => {
    expect(() =>
      validateConfig(
        { github: { repositories: { "o/r": { alias: "bad alias" } } } },
        "p",
      ),
    ).toThrow(/alias/);
  });

  it("rejects github profile mergeMode outside enum", () => {
    expect(() =>
      validateConfig(
        {
          github: { repositories: { "o/r": { mergeMode: "fast-forward" } } },
        } as any,
        "p",
      ),
    ).toThrow(/mergeMode/);
  });

  it("rejects github profile labels with empty string", () => {
    expect(() =>
      validateConfig(
        { github: { repositories: { "o/r": { labels: ["bug", ""] } } } },
        "p",
      ),
    ).toThrow(/labels\[1\]/);
  });

  it("rejects unsupported github profile keys (typo / token leakage guard)", () => {
    // token / passwordEnv 같은 키가 들어오면 reject — 외부 MCP 책임 영역과 명확히 분리.
    expect(() =>
      validateConfig(
        {
          github: {
            repositories: { "o/r": { token: "ghp_xxx" } },
          },
        } as any,
        "p",
      ),
    ).toThrow(/unsupported key "token"/);
    expect(() =>
      validateConfig(
        {
          github: {
            repositories: { "o/r": { typo: 1 } },
          },
        } as any,
        "p",
      ),
    ).toThrow(/unsupported key "typo"/);
  });
});

describe("validateConfig — github", () => {
  it("accepts a valid github object", () => {
    const cfg = validateConfig(
      {
        github: {
          repo: "minjun0219/agent-toolkit",
          defaultLabels: ["spec-pact", "extra"],
        },
      },
      "p",
    );
    expect(cfg.github?.repo).toBe("minjun0219/agent-toolkit");
    expect(cfg.github?.defaultLabels).toEqual(["spec-pact", "extra"]);
  });

  it("rejects unsupported github keys (typo guard)", () => {
    expect(() =>
      validateConfig({ github: { token: "x" } } as any, "p"),
    ).toThrow(/unsupported key "token"/);
  });

  it("rejects malformed repo", () => {
    expect(() =>
      validateConfig({ github: { repo: "not-a-repo" } }, "p"),
    ).toThrow(/github\.repo must match/);
  });

  it("rejects empty defaultLabels array", () => {
    expect(() =>
      validateConfig({ github: { defaultLabels: [] } }, "p"),
    ).toThrow(/non-empty string array/);
  });

  it("rejects label with spaces or colons", () => {
    expect(() =>
      validateConfig({ github: { defaultLabels: ["spec pact"] } } as any, "p"),
    ).toThrow(/defaultLabels\[0\] must match/);
    expect(() =>
      validateConfig({ github: { defaultLabels: ["spec:pact"] } } as any, "p"),
    ).toThrow(/defaultLabels\[0\] must match/);
  });
});

describe("mergeConfigs — github", () => {
  it("project overrides user at the github leaf (defaultLabels replaces wholly)", () => {
    const user: ToolkitConfig = {
      github: { repo: "u/u", defaultLabels: ["spec-pact"] },
    };
    const project: ToolkitConfig = {
      github: { repo: "p/p", defaultLabels: ["spec-pact", "phase2"] },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.github?.repo).toBe("p/p");
    expect(merged.github?.defaultLabels).toEqual(["spec-pact", "phase2"]);
  });

  it("project keeps user's keys when project does not set them", () => {
    const user: ToolkitConfig = {
      github: { defaultLabels: ["spec-pact"] },
    };
    const project: ToolkitConfig = { github: { repo: "p/p" } };
    const merged = mergeConfigs(user, project);
    expect(merged.github?.repo).toBe("p/p");
    expect(merged.github?.defaultLabels).toEqual(["spec-pact"]);
  });
});

describe("mergeConfigs — mysql.connections", () => {
  it("project overrides user at the profile leaf", () => {
    const user: ToolkitConfig = {
      mysql: {
        connections: {
          acme: { prod: { users: { dsnEnv: "USER_DSN" } } },
        },
      },
    };
    const project: ToolkitConfig = {
      mysql: {
        connections: {
          acme: { prod: { users: { dsnEnv: "PROJECT_DSN" } } },
        },
      },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.mysql?.connections?.acme?.prod?.users?.dsnEnv).toBe(
      "PROJECT_DSN",
    );
  });

  it("project introduces new mysql host / env / db", () => {
    const user: ToolkitConfig = {
      mysql: {
        connections: {
          acme: { prod: { users: { dsnEnv: "U_DSN" } } },
        },
      },
    };
    const project: ToolkitConfig = {
      mysql: {
        connections: {
          acme: { prod: { orders: { dsnEnv: "O_DSN" } } },
          beta: { dev: { svc: { dsnEnv: "S_DSN" } } },
        },
      },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.mysql?.connections?.acme?.prod?.users?.dsnEnv).toBe("U_DSN");
    expect(merged.mysql?.connections?.acme?.prod?.orders?.dsnEnv).toBe("O_DSN");
    expect(merged.mysql?.connections?.beta?.dev?.svc?.dsnEnv).toBe("S_DSN");
  });
});

describe("mergeConfigs — github.repositories", () => {
  it("project overrides user at the repo profile leaf", () => {
    const user: ToolkitConfig = {
      github: {
        repositories: { "o/r": { alias: "user", mergeMode: "merge" } },
      },
    };
    const project: ToolkitConfig = {
      github: {
        repositories: { "o/r": { alias: "project", mergeMode: "squash" } },
      },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.github?.repositories?.["o/r"]?.alias).toBe("project");
    expect(merged.github?.repositories?.["o/r"]?.mergeMode).toBe("squash");
  });

  it("project introduces new repos while user repos survive", () => {
    const user: ToolkitConfig = {
      github: { repositories: { "o/r": { alias: "u" } } },
    };
    const project: ToolkitConfig = {
      github: { repositories: { "x/y": { alias: "p" } } },
    };
    const merged = mergeConfigs(user, project);
    expect(merged.github?.repositories?.["o/r"]?.alias).toBe("u");
    expect(merged.github?.repositories?.["x/y"]?.alias).toBe("p");
  });
});

describe("mergeConfigs", () => {
  it("project overrides user at the leaf", () => {
    const user: ToolkitConfig = {
      openapi: {
        registry: {
          acme: {
            dev: {
              users: "https://user/u.json",
              orders: "https://user/o.json",
            },
          },
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
      openapi: {
        registry: { acme: { dev: { users: "https://u.example/u.json" } } },
      },
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
    expect(r.config.openapi?.registry?.acme?.dev?.users).toBe(
      "https://u/u.json",
    );
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
      openapi: {
        registry: { acme: { dev: { users: "https://user/u.json" } } },
      },
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
