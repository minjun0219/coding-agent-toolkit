/**
 * 긴 Notion markdown 을 구조 단위로 분해하고, 구현 액션 후보를 추출한다.
 *
 * 목적:
 * - 문서를 통째로 LLM 컨텍스트에 넣지 않고 청크 단위로 근거를 유지
 * - 구현 가능한 TODO / API 의존성 / 확인 필요 사항을 재사용 가능한 JSON으로 고정
 */

export interface NotionChunk {
  id: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  text: string;
  approxTokens: number;
}

export interface ExtractedItem {
  text: string;
  chunkId: string;
}

export interface NotionActionExtraction {
  requirements: ExtractedItem[];
  screens: ExtractedItem[];
  apis: ExtractedItem[];
  todos: ExtractedItem[];
  questions: ExtractedItem[];
}

export interface ChunkOptions {
  maxCharsPerChunk?: number;
}

const DEFAULT_MAX_CHARS = 1400;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function splitLargeText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/g);
  const out: string[] = [];
  let acc = "";
  for (const para of paragraphs) {
    const candidate = acc ? `${acc}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      acc = candidate;
      continue;
    }
    if (acc) out.push(acc);
    if (para.length <= maxChars) {
      acc = para;
      continue;
    }
    // 문단 자체가 너무 길면 줄 단위로 한 번 더 분할.
    const lines = para.split("\n");
    let lineAcc = "";
    for (const line of lines) {
      const lineCandidate = lineAcc ? `${lineAcc}\n${line}` : line;
      if (lineCandidate.length <= maxChars) {
        lineAcc = lineCandidate;
      } else {
        if (lineAcc) out.push(lineAcc);
        lineAcc = line;
      }
    }
    if (lineAcc) out.push(lineAcc);
    acc = "";
  }
  if (acc) out.push(acc);
  return out;
}

/**
 * markdown 을 heading 중심으로 1차 분할 후, 큰 블록은 문단/줄 단위 재분할한다.
 */
export function chunkNotionMarkdown(
  markdown: string,
  options: ChunkOptions = {},
): NotionChunk[] {
  const maxChars = options.maxCharsPerChunk ?? DEFAULT_MAX_CHARS;
  const lines = markdown.split("\n");

  interface Block {
    headingPath: string[];
    startLine: number;
    endLine: number;
    text: string;
  }

  const blocks: Block[] = [];
  let currentStart = 1;
  let currentPath: string[] = [];
  let stack: Array<{ level: number; title: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;

    if (i + 1 > currentStart) {
      blocks.push({
        headingPath: [...currentPath],
        startLine: currentStart,
        endLine: i,
        text: lines.slice(currentStart - 1, i).join("\n").trim(),
      });
    }

    const level = m[1]?.length ?? 1;
    const title = normalizeLine(m[2] ?? "");
    stack = stack.filter((h) => h.level < level);
    stack.push({ level, title });
    currentPath = stack.map((h) => h.title);
    currentStart = i + 1;
  }

  if (currentStart <= lines.length) {
    blocks.push({
      headingPath: [...currentPath],
      startLine: currentStart,
      endLine: lines.length,
      text: lines.slice(currentStart - 1).join("\n").trim(),
    });
  }

  const chunks: NotionChunk[] = [];
  let index = 1;

  for (const block of blocks) {
    if (!block.text) continue;
    const pieces = splitLargeText(block.text, maxChars);
    let cursor = block.startLine;
    for (const piece of pieces) {
      const pieceLines = piece.split("\n").length;
      const chunk: NotionChunk = {
        id: `chunk-${String(index).padStart(3, "0")}`,
        headingPath: block.headingPath,
        startLine: cursor,
        endLine: Math.min(block.endLine, cursor + pieceLines - 1),
        text: piece.trim(),
        approxTokens: approxTokens(piece),
      };
      chunks.push(chunk);
      index += 1;
      cursor = chunk.endLine + 1;
    }
  }

  return chunks;
}

function dedupe(items: ExtractedItem[]): ExtractedItem[] {
  const seen = new Set<string>();
  const out: ExtractedItem[] = [];
  for (const item of items) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractBullets(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(-|\*|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^(-|\*|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

function isLikelyActionLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("|") || line.startsWith(">")) return false;
  if (/^```/.test(line)) return false;
  return /\bTODO\b|구현|추가|연동|분리|리팩터|작성|반영|수정|지원/i.test(line);
}

/**
 * 청크 텍스트의 규칙 기반 분류로 구현 액션 후보를 뽑는다.
 * LLM 없이도 반복 가능한 최소 추출 파이프라인을 제공한다.
 */
export function extractActionItems(chunks: NotionChunk[]): NotionActionExtraction {
  const requirements: ExtractedItem[] = [];
  const screens: ExtractedItem[] = [];
  const apis: ExtractedItem[] = [];
  const todos: ExtractedItem[] = [];
  const questions: ExtractedItem[] = [];

  const apiRe = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/[\w\-./{}:]+\b/g;

  for (const chunk of chunks) {
    const heading = chunk.headingPath.join(" > ").toLowerCase();
    const lines = chunk.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const bullets = extractBullets(chunk.text);

    for (const match of chunk.text.matchAll(apiRe)) {
      const text = normalizeLine(match[0] ?? "");
      if (text) apis.push({ text, chunkId: chunk.id });
    }

    for (const line of lines) {
      const normalized = normalizeLine(line);
      if (!normalized) continue;

      if (/\?$/.test(normalized) || /확인 필요|미정|논의 필요/i.test(normalized)) {
        questions.push({ text: normalized, chunkId: chunk.id });
      }

      const isCheckbox = /^-\s*\[\s*\]\s+/i.test(line);
      const isBullet = /^(-|\*|\d+\.)\s+/.test(line);
      if (isCheckbox || (isBullet && isLikelyActionLine(normalized))) {
        todos.push({
          text: normalized.replace(/^-\s*\[\s*\]\s+/i, "").replace(/^(-|\*|\d+\.)\s+/, ""),
          chunkId: chunk.id,
        });
      }

      if (/필수|반드시|지원해야|요구사항|제약/i.test(normalized) || heading.includes("요구사항")) {
        requirements.push({ text: normalized, chunkId: chunk.id });
      }

      if (/화면|페이지|모달|컴포넌트|폼|버튼/i.test(normalized) || heading.includes("화면")) {
        screens.push({ text: normalized, chunkId: chunk.id });
      }
    }

    if (heading.includes("todo") || heading.includes("합의 todo")) {
      for (const bullet of bullets) {
        const text = normalizeLine(bullet);
        if (isLikelyActionLine(text) || /\bapi\b/i.test(text)) {
          todos.push({ text, chunkId: chunk.id });
        }
      }
    }
  }

  return {
    requirements: dedupe(requirements),
    screens: dedupe(screens),
    apis: dedupe(apis),
    todos: dedupe(todos),
    questions: dedupe(questions),
  };
}
