import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SPEC_PACT_MODES,
  assertSpecPactMode,
  loadSpecPactFragment,
} from "./spec-pact-fragments";

describe("assertSpecPactMode", () => {
  it("returns the value when it is one of the four modes", () => {
    for (const mode of SPEC_PACT_MODES) {
      expect(assertSpecPactMode(mode)).toBe(mode);
    }
  });

  it("rejects unknown strings with the offending value in the message", () => {
    expect(() => assertSpecPactMode("plan")).toThrow(/got "plan"/);
  });

  it("rejects non-string inputs", () => {
    expect(() => assertSpecPactMode(42)).toThrow(/expected one of/);
    expect(() => assertSpecPactMode(undefined)).toThrow(/expected one of/);
  });

  it("includes the caller-provided context in the error", () => {
    expect(() => assertSpecPactMode("nope", "test.context")).toThrow(
      /test\.context:/,
    );
  });
});

describe("loadSpecPactFragment", () => {
  const makeSkillsDir = () => {
    const root = mkdtempSync(join(tmpdir(), "spec-pact-fragments-"));
    mkdirSync(join(root, "spec-pact", "fragments"), { recursive: true });
    return root;
  };

  it("reads <skillsDir>/spec-pact/fragments/<mode>.md", () => {
    const skills = makeSkillsDir();
    const draftPath = join(skills, "spec-pact", "fragments", "draft.md");
    writeFileSync(draftPath, "# fake draft body");

    const result = loadSpecPactFragment(skills, "draft");

    expect(result.mode).toBe("draft");
    expect(result.path).toBe(draftPath);
    expect(result.content).toBe("# fake draft body");
  });

  it("reports the attempted absolute path when the file is missing", () => {
    const skills = makeSkillsDir();
    expect(() => loadSpecPactFragment(skills, "verify")).toThrow(
      /spec_pact_fragment: failed to read fragment at .*verify\.md/,
    );
  });
});
