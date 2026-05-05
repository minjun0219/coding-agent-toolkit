import { diffLines } from "diff";
import { contentHash } from "./notion-context";

const MAX_PREVIEW_CHARS = 1200;
const MAX_SECTIONS = 40;

export type NotionDiffSectionStatus = "added" | "removed" | "modified";

export interface NotionDiffSection {
  path: string;
  status: NotionDiffSectionStatus;
  previousHash?: string;
  currentHash?: string;
  previousLineCount: number;
  currentLineCount: number;
  lineDelta: number;
  preview: string;
}

export interface NotionMarkdownDiff {
  changed: boolean;
  previousHash: string;
  currentHash: string;
  sections: NotionDiffSection[];
  truncated: boolean;
}

interface MarkdownSection {
  path: string;
  content: string;
  lineCount: number;
  hash: string;
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function trimPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PREVIEW_CHARS).trimEnd()}\n…`;
}

function makeUniquePath(path: string, counts: Map<string, number>): string {
  const next = (counts.get(path) ?? 0) + 1;
  counts.set(path, next);
  return next === 1 ? path : `${path} #${next}`;
}

export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const headingStack: string[] = [];
  const pathCounts = new Map<string, number>();
  let currentPath = "(preamble)";
  let currentLines: string[] = [];

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (!content) return;
    const path = makeUniquePath(currentPath, pathCounts);
    sections.push({
      path,
      content,
      lineCount: lineCount(content),
      hash: contentHash(content),
    });
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      const level = match[1]!.length;
      const title = match[2]!.trim();
      headingStack.length = level - 1;
      headingStack[level - 1] = title;
      currentPath = headingStack.filter(Boolean).join(" > ");
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return sections;
}

function sectionPreview(
  previousContent: string,
  currentContent: string,
): string {
  const parts = diffLines(previousContent, currentContent);
  const rendered = parts
    .filter((part) => part.added || part.removed)
    .map((part) => {
      const prefix = part.added ? "+" : "-";
      return part.value
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => `${prefix} ${line}`)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
  return trimPreview(rendered || currentContent || previousContent);
}

export function diffMarkdownBySection(
  previousMarkdown: string,
  currentMarkdown: string,
): NotionMarkdownDiff {
  const previousHash = contentHash(previousMarkdown);
  const currentHash = contentHash(currentMarkdown);
  if (previousHash === currentHash) {
    return {
      changed: false,
      previousHash,
      currentHash,
      sections: [],
      truncated: false,
    };
  }

  const previous = new Map(
    splitMarkdownSections(previousMarkdown).map((section) => [
      section.path,
      section,
    ]),
  );
  const current = new Map(
    splitMarkdownSections(currentMarkdown).map((section) => [
      section.path,
      section,
    ]),
  );
  const paths = [...new Set([...previous.keys(), ...current.keys()])];
  const sections: NotionDiffSection[] = [];

  for (const path of paths) {
    const before = previous.get(path);
    const after = current.get(path);
    if (before?.hash === after?.hash) continue;

    const status: NotionDiffSectionStatus = before
      ? after
        ? "modified"
        : "removed"
      : "added";
    sections.push({
      path,
      status,
      previousHash: before?.hash,
      currentHash: after?.hash,
      previousLineCount: before?.lineCount ?? 0,
      currentLineCount: after?.lineCount ?? 0,
      lineDelta: (after?.lineCount ?? 0) - (before?.lineCount ?? 0),
      preview: sectionPreview(before?.content ?? "", after?.content ?? ""),
    });
  }

  return {
    changed: true,
    previousHash,
    currentHash,
    sections: sections.slice(0, MAX_SECTIONS),
    truncated: sections.length > MAX_SECTIONS,
  };
}
