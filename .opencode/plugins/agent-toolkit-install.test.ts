import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

    expect(main).toBe("./.opencode/plugins/agent-toolkit.ts");
    expect(serverImport).toBe(main);
    expect(main.startsWith("./")).toBe(true);
    expect(main.includes("dist")).toBe(false);
    expect(existsSync(resolve(ROOT, main))).toBe(true);
    expect(existsSync(join(AGENTS_DIR, "rocky.md"))).toBe(true);
    expect(existsSync(join(AGENTS_DIR, "grace.md"))).toBe(true);

    const scripts = pkg.scripts ?? {};
    expect("build" in scripts).toBe(false);
    expect("prepare" in scripts).toBe(false);
    expect("prepublishOnly" in scripts).toBe(false);
  });
});
