import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import agentToolkitPlugin from "./agent-toolkit";

const ROOT = join(import.meta.dir, "..", "..");

const SKILL_FILES = [
  "skills/notion-context/SKILL.md",
  "skills/openapi-client/SKILL.md",
  "skills/mysql-query/SKILL.md",
  "skills/spec-pact/SKILL.md",
  "skills/spec-to-issues/SKILL.md",
  "skills/pr-review-watch/SKILL.md",
  "skills/gh-passthrough/SKILL.md",
] as const;

const NATIVE_ALLOWED_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

function readRepoFile(relPath: string) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function parseAllowedTools(md: string) {
  const match = md.match(/allowed-tools:\s*\[([^\]]+)\]/);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("skill/agent contract inventory", () => {
  it("skill markdown only references registered plugin tools or native tools", async () => {
    const plugin = await agentToolkitPlugin({});
    const registeredTools = new Set(Object.keys(plugin.tool));

    for (const relPath of SKILL_FILES) {
      const md = readRepoFile(relPath);
      const referenced = new Set(parseAllowedTools(md));

      for (const tool of referenced) {
        if (NATIVE_ALLOWED_TOOLS.has(tool)) continue;
        expect(registeredTools.has(tool)).toBe(true);
      }
    }
  });

  it("agent markdown preserves required forbidden-policy text", () => {
    const rocky = readRepoFile("agents/rocky.md");
    const grace = readRepoFile("agents/grace.md");
    const mindy = readRepoFile("agents/mindy.md");
    const prSkill = readRepoFile("skills/pr-review-watch/SKILL.md");

    expect(rocky).toContain("Rocky never accepts a write / DDL");
    expect(rocky).toContain(
      "does not directly run multi-step implementation work",
    );

    expect(mindy).toContain("The toolkit never calls the GitHub API itself");
    expect(mindy).toContain("permission.edit: deny");
    expect(mindy).toContain("permission.bash: deny");

    expect(prSkill).toContain("The toolkit never calls the GitHub API itself");
    expect(prSkill).toContain("mindy");

    expect(grace).toContain("GitHub Issue 동기화");
    expect(grace).toContain("gh-passthrough");
    expect(grace).toContain("finalize/lock authority");
    expect(grace).toContain("SPEC 까지");
  });
});
