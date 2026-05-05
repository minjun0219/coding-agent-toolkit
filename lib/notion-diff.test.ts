import { describe, expect, it } from "bun:test";
import { diffMarkdownBySection, splitMarkdownSections } from "./notion-diff";

describe("splitMarkdownSections", () => {
  it("splits markdown by heading path", () => {
    const sections = splitMarkdownSections("# A\n\none\n\n## B\n\ntwo");
    expect(sections.map((section) => section.path)).toEqual(["A", "A > B"]);
  });
});

describe("diffMarkdownBySection", () => {
  it("returns changed heading sections with compact previews", () => {
    const before =
      "# 기획서\n\nintro\n\n## API\n\n- GET /orders\n\n## TODO\n\n- [ ] old";
    const after =
      "# 기획서\n\nintro changed\n\n## API\n\n- GET /orders\n- POST /orders\n\n## 새 섹션\n\n추가됨";

    const diff = diffMarkdownBySection(before, after);

    expect(diff.changed).toBe(true);
    expect(
      diff.sections.map((section) => [section.path, section.status]),
    ).toEqual([
      ["기획서", "modified"],
      ["기획서 > API", "modified"],
      ["기획서 > TODO", "removed"],
      ["기획서 > 새 섹션", "added"],
    ]);
    expect(diff.sections[1]?.preview).toContain("+ - POST /orders");
  });

  it("returns unchanged when content hashes match", () => {
    const diff = diffMarkdownBySection("# A\n\none", "# A\n\none");
    expect(diff.changed).toBe(false);
    expect(diff.sections).toEqual([]);
  });
});
