import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const AGENTS_DIR = join(ROOT, "agents");

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    main?: string;
    exports?: {
      [key: string]: {
        import?: string;
      };
    };
    scripts?: Record<string, string>;
  };
}

describe("agent-toolkit install metadata", () => {
  it("keeps the published entrypoint and fallback files aligned", () => {
    const pkg = readPackageJson();
    const main = pkg.main ?? "";
    const serverImport = pkg.exports?.["./server"]?.import ?? "";

    expect(main).toBe("./.opencode/plugins/agent-toolkit-server.ts");
    expect(serverImport).toBe(main);
    expect(main.startsWith("./")).toBe(true);
    expect(main.includes("dist")).toBe(false);
    expect(existsSync(resolve(ROOT, main))).toBe(true);
    expect(
      existsSync(resolve(ROOT, "./.opencode/plugins/agent-toolkit.ts")),
    ).toBe(true);
    expect(existsSync(join(AGENTS_DIR, "rocky.md"))).toBe(true);
    expect(existsSync(join(AGENTS_DIR, "grace.md"))).toBe(true);

    const scripts = pkg.scripts ?? {};
    expect("build" in scripts).toBe(false);
    expect("prepare" in scripts).toBe(false);
    expect("prepublishOnly" in scripts).toBe(false);
  });

  it("loads the server plugin through the package subpath export", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agent-toolkit-install-"));

    try {
      const packageDir = join(tempDir, "node_modules", "agent-toolkit");
      mkdirSync(join(tempDir, "node_modules"), { recursive: true });
      symlinkSync(ROOT, packageDir, "dir");
      writeFileSync(
        join(tempDir, "import-server.ts"),
        'import plugin from "agent-toolkit/server";\nconsole.log(typeof plugin);\n',
      );

      const result = Bun.spawnSync(["bun", "import-server.ts"], {
        cwd: tempDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("function");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
