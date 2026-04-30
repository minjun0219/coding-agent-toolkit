import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotionCache,
  resolveCacheKey,
  notionToMarkdown,
  contentHash,
} from "../src";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-toolkit-cache-"));
});

describe("resolveCacheKey", () => {
  it("extracts page id from raw 32-char hex", () => {
    const { pageId } = resolveCacheKey("1234abcd1234abcd1234abcd1234abcd");
    expect(pageId).toBe("1234abcd-1234-abcd-1234-abcd1234abcd");
  });

  it("extracts page id from notion url", () => {
    const url =
      "https://www.notion.so/team/Some-Title-1234abcd1234abcd1234abcd1234abcd?pvs=4";
    const { pageId } = resolveCacheKey(url);
    expect(pageId).toBe("1234abcd-1234-abcd-1234-abcd1234abcd");
  });

  it("rejects garbage input", () => {
    expect(() => resolveCacheKey("not-a-page")).toThrow();
  });
});

describe("notionToMarkdown", () => {
  it("uses markdown field when present", () => {
    expect(
      notionToMarkdown({ id: "x", title: "t", markdown: "# Hello" }),
    ).toBe("# Hello");
  });

  it("renders blocks", () => {
    const md = notionToMarkdown({
      id: "x",
      title: "t",
      blocks: [
        { type: "heading_1", text: "Title" },
        { type: "paragraph", text: "Hello" },
        { type: "bulleted_list_item", text: "a" },
      ],
    });
    expect(md).toContain("# Title");
    expect(md).toContain("Hello");
    expect(md).toContain("- a");
  });
});

describe("NotionCache", () => {
  it("returns null for missing pages", async () => {
    const cache = new NotionCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const r = await cache.read("1234abcd1234abcd1234abcd1234abcd");
    expect(r).toBeNull();
  });

  it("writes and reads back", async () => {
    const cache = new NotionCache({ baseDir: dir, defaultTtlSeconds: 60 });
    const written = await cache.write(
      "1234abcd1234abcd1234abcd1234abcd",
      { id: "1234abcd1234abcd1234abcd1234abcd", title: "T", markdown: "# T" },
    );
    expect(written.entry.title).toBe("T");
    const read = await cache.read("1234abcd1234abcd1234abcd1234abcd");
    expect(read?.markdown).toBe("# T");
    expect(read?.entry.contentHash).toBe(contentHash("# T"));
  });

  it("treats expired entries as miss", async () => {
    const cache = new NotionCache({ baseDir: dir, defaultTtlSeconds: 60 });
    await cache.write("1234abcd1234abcd1234abcd1234abcd", {
      id: "x",
      title: "T",
      markdown: "# T",
    });
    await cache.invalidate("1234abcd1234abcd1234abcd1234abcd");
    const read = await cache.read("1234abcd1234abcd1234abcd1234abcd");
    expect(read).toBeNull();
    const status = await cache.status(
      "1234abcd1234abcd1234abcd1234abcd",
    );
    expect(status.exists).toBe(true);
    expect(status.expired).toBe(true);
  });
});

