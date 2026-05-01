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

  it("rejects empty URL", () => {
    expect(() =>
      validateConfig(
        { openapi: { registry: { acme: { dev: { users: "" } } } } },
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
});

describe("loadConfig", () => {
  it("returns {} when neither file exists", async () => {
    const config = await loadConfig({ userPath, projectRoot });
    expect(config).toEqual({});
  });

  it("loads user-only when project is absent", async () => {
    writeUser({
      openapi: { registry: { acme: { dev: { users: "https://u/u.json" } } } },
    });
    const config = await loadConfig({ userPath, projectRoot });
    expect(config.openapi?.registry?.acme?.dev?.users).toBe("https://u/u.json");
  });

  it("loads project-only when user is absent", async () => {
    writeProject({
      openapi: { registry: { acme: { prod: { users: "https://p/u.json" } } } },
    });
    const config = await loadConfig({ userPath, projectRoot });
    expect(config.openapi?.registry?.acme?.prod?.users).toBe(
      "https://p/u.json",
    );
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
    const config = await loadConfig({ userPath, projectRoot });
    expect(config.openapi?.registry?.acme?.dev?.users).toBe(
      "https://project/u.json",
    );
  });

  it("throws on malformed JSON with the path in the message", async () => {
    writeFileSync(userPath, "{ not json", "utf8");
    await expect(loadConfig({ userPath, projectRoot })).rejects.toThrow(
      /Failed to parse/,
    );
  });

  it("throws on schema-violating config with the path in the message", async () => {
    writeUser({
      openapi: { registry: { "bad:host": { dev: { users: "u" } } } } as any,
    });
    await expect(loadConfig({ userPath, projectRoot })).rejects.toThrow(
      /host name/,
    );
  });
});
