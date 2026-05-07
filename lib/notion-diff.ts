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
  basePath: string;
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

function isFenceBoundary(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function assignStableDuplicatePaths(
  sections: MarkdownSection[],
): MarkdownSection[] {
  const groups = new Map<string, MarkdownSection[]>();
  for (const section of sections) {
    const existing = groups.get(section.basePath) ?? [];
    existing.push(section);
    groups.set(section.basePath, existing);
  }

  const pathCounts = new Map<string, number>();
  return sections.map((section) => {
    const group = groups.get(section.basePath) ?? [];
    const path =
      group.length === 1
        ? section.basePath
        : `${section.basePath} [${section.hash.slice(0, 8)}]`;
    const next = (pathCounts.get(path) ?? 0) + 1;
    pathCounts.set(path, next);
    return {
      ...section,
      path: next === 1 ? path : `${path} #${next}`,
    };
  });
}

export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const headingStack: string[] = [];
  let currentPath = "(preamble)";
  let currentLines: string[] = [];
  let inFence = false;

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (!content) return;
    sections.push({
      path: currentPath,
      basePath: currentPath,
      content,
      lineCount: lineCount(content),
      hash: contentHash(content),
    });
  };

  for (const line of lines) {
    if (isFenceBoundary(line)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    const match = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
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

  return assignStableDuplicatePaths(sections);
}

function lineDiffPreview(
  previousContent: string,
  currentContent: string,
): string {
  const previousLines = previousContent.split(/\r?\n/);
  const currentLines = currentContent.split(/\r?\n/);
  const rows = previousLines.length + 1;
  const cols = currentLines.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array<number>(cols).fill(0),
  );

  for (let i = previousLines.length - 1; i >= 0; i--) {
    for (let j = currentLines.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        previousLines[i] === currentLines[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const changed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < previousLines.length && j < currentLines.length) {
    if (previousLines[i] === currentLines[j]) {
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      if (previousLines[i]!.trim()) changed.push(`- ${previousLines[i]}`);
      i++;
    } else {
      if (currentLines[j]!.trim()) changed.push(`+ ${currentLines[j]}`);
      j++;
    }
  }
  while (i < previousLines.length) {
    if (previousLines[i]!.trim()) changed.push(`- ${previousLines[i]}`);
    i++;
  }
  while (j < currentLines.length) {
    if (currentLines[j]!.trim()) changed.push(`+ ${currentLines[j]}`);
    j++;
  }

  return changed.join("\n");
}

function sectionPreview(
  previousContent: string,
  currentContent: string,
): string {
  const rendered = lineDiffPreview(previousContent, currentContent);
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
