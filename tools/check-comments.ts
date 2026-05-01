import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * JSDoc + 한글 주석 정책 검증 스크립트.
 *
 * AGENTS.md 의 두 규칙을 자동 검증한다:
 * 1. export 함수 / 클래스에 JSDoc 이 있는지
 * 2. 주석 본문에 한글이 포함되어 있는지 (Hangul 비율 휴리스틱)
 *
 * 사용법:
 *   bun run tools/check-comments.ts [파일 또는 디렉터리 경로...]
 *   예: bun run tools/check-comments.ts lib
 *
 * 종료 코드:
 *   0 = 위반 없음 또는 warning 만 존재
 *   1 = error 수준 위반 발견
 */

/** 검증 위반 수준 */
export type ViolationLevel = "error" | "warning";

/** 검증 위반 항목 */
export interface Violation {
  file: string;
  line: number;
  level: ViolationLevel;
  rule: "missing-jsdoc" | "non-korean-comment";
  message: string;
}

/** 파일별 검증 결과 */
export interface FileResult {
  file: string;
  violations: Violation[];
}

/** 전체 검증 결과 */
export interface CheckResult {
  files: FileResult[];
  totalViolations: number;
  errors: number;
  warnings: number;
}

/**
 * 주어진 텍스트에서 한글 문자 비율을 계산한다.
 * 한글 음절 범위: U+AC00 ~ U+D7A3 (가 ~ 힣)
 */
export function getHangulRatio(text: string): number {
  if (text.length === 0) return 0;
  const hangulCount = Array.from(text).filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 0xac00 && code <= 0xd7a3;
  }).length;
  return hangulCount / text.length;
}

/**
 * 주석 텍스트가 한글을 포함하는지 검증한다.
 * 임계치: 한글 비율이 10% 이상이면 한글 주석으로 판정.
 * 단, 영어 식별자 / URL / 코드 스니펫 등이 섞여 있을 수 있으므로 관대한 임계치 사용.
 */
export function hasKoreanContent(text: string): boolean {
  const ratio = getHangulRatio(text);
  return ratio >= 0.1;
}

/**
 * JSDoc 주석 블록을 추출한다.
 * 형식: 여러 줄 또는 한 줄 JSDoc 블록
 */
function extractJSDocBlocks(content: string): Array<{ line: number; text: string }> {
  const blocks: Array<{ line: number; text: string }> = [];
  const lines = content.split("\n");
  let inBlock = false;
  let blockStart = 0;
  let blockText = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inBlock && trimmed.startsWith("/**")) {
      inBlock = true;
      blockStart = i + 1;
      blockText = line;
      if (trimmed.endsWith("*/")) {
        // 한 줄 JSDoc
        blocks.push({ line: blockStart, text: blockText });
        inBlock = false;
        blockText = "";
      }
    } else if (inBlock) {
      blockText += "\n" + line;
      if (trimmed.endsWith("*/")) {
        blocks.push({ line: blockStart, text: blockText });
        inBlock = false;
        blockText = "";
      }
    }
  }

  return blocks;
}

/**
 * 일반 주석을 추출한다. 슬래시 두 개 또는 블록 주석.
 * JSDoc 은 제외.
 */
function extractNonJSDocComments(content: string): Array<{ line: number; text: string }> {
  const comments: Array<{ line: number; text: string }> = [];
  const lines = content.split("\n");
  let inBlock = false;
  let blockStart = 0;
  let blockText = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 한 줄 주석 //
    if (trimmed.startsWith("//") && !trimmed.startsWith("///")) {
      comments.push({ line: i + 1, text: line });
    }
    // 블록 주석 (단, JSDoc 는 제외)
    else if (!inBlock && trimmed.startsWith("/*") && !trimmed.startsWith("/**")) {
      inBlock = true;
      blockStart = i + 1;
      blockText = line;
      if (trimmed.endsWith("*/")) {
        comments.push({ line: blockStart, text: blockText });
        inBlock = false;
        blockText = "";
      }
    } else if (inBlock) {
      blockText += "\n" + line;
      if (trimmed.endsWith("*/")) {
        comments.push({ line: blockStart, text: blockText });
        inBlock = false;
        blockText = "";
      }
    }
  }

  return comments;
}

/**
 * export 된 함수 / 클래스 선언을 찾는다.
 * 간단한 정규식 기반 휴리스틱 — AST parser 를 쓰지 않고 가벼운 검증.
 */
function findExports(content: string): Array<{ line: number; name: string }> {
  const exports: Array<{ line: number; name: string }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // export function foo(...) 또는 export async function foo(...)
    const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (funcMatch) {
      exports.push({ line: i + 1, name: funcMatch[1] });
      continue;
    }

    // export class Foo
    const classMatch = trimmed.match(/^export\s+class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (classMatch) {
      exports.push({ line: i + 1, name: classMatch[1] });
      continue;
    }

    // export const foo = ... (함수 또는 클래스 할당)
    const constMatch = trimmed.match(/^export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
    if (constMatch) {
      // 함수 또는 클래스 할당인지 간단히 확인 (완벽하지 않음)
      if (trimmed.includes("=>") || trimmed.includes("function") || trimmed.includes("class")) {
        exports.push({ line: i + 1, name: constMatch[1] });
      }
    }
  }

  return exports;
}

/**
 * JSDoc 블록이 주어진 export 선언 바로 위에 있는지 확인한다.
 * JSDoc 과 선언 사이에 빈 줄은 허용.
 */
function hasJSDocBefore(
  exportLine: number,
  jsDocBlocks: Array<{ line: number; text: string }>,
  content: string,
): boolean {
  const lines = content.split("\n");

  // export 바로 위 줄부터 역방향으로 탐색
  for (let i = exportLine - 2; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue; // 빈 줄은 건너뜀
    if (trimmed.endsWith("*/")) {
      // JSDoc 블록 끝인지 확인
      const block = jsDocBlocks.find((b) => {
        const blockLines = b.text.split("\n");
        const blockEndLine = b.line + blockLines.length - 1;
        return blockEndLine === i + 1;
      });
      if (block && block.text.trim().startsWith("/**")) {
        return true;
      }
    }
    break; // 주석이 아닌 다른 코드를 만나면 중단
  }

  return false;
}

/**
 * 주어진 TypeScript 파일을 검증한다.
 */
export async function checkFile(filePath: string): Promise<FileResult> {
  const content = await readFile(filePath, "utf8");
  const violations: Violation[] = [];

  const jsDocBlocks = extractJSDocBlocks(content);
  const nonJSDocComments = extractNonJSDocComments(content);
  const exports = findExports(content);

  // 규칙 1: export 함수 / 클래스에 JSDoc 이 있는지
  for (const exp of exports) {
    if (!hasJSDocBefore(exp.line, jsDocBlocks, content)) {
      violations.push({
        file: filePath,
        line: exp.line,
        level: "error",
        rule: "missing-jsdoc",
        message: `Export '${exp.name}' 에 JSDoc 주석이 없습니다`,
      });
    }
  }

  // 규칙 2: JSDoc + 일반 주석이 한글을 포함하는지
  for (const block of jsDocBlocks) {
    if (!hasKoreanContent(block.text)) {
      violations.push({
        file: filePath,
        line: block.line,
        level: "warning",
        rule: "non-korean-comment",
        message: "JSDoc 주석에 한글이 포함되지 않았습니다 (권장 사항)",
      });
    }
  }

  for (const comment of nonJSDocComments) {
    if (!hasKoreanContent(comment.text)) {
      violations.push({
        file: filePath,
        line: comment.line,
        level: "warning",
        rule: "non-korean-comment",
        message: "주석에 한글이 포함되지 않았습니다 (권장 사항)",
      });
    }
  }

  return { file: filePath, violations };
}

/**
 * 디렉터리를 재귀적으로 순회하며 .ts 파일을 찾는다.
 * .test.ts 파일과 node_modules 는 제외.
 */
export async function findTsFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await findTsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * 주어진 경로 (파일 또는 디렉터리) 를 검증한다.
 */
export async function checkPath(targetPath: string): Promise<FileResult[]> {
  const stats = await stat(targetPath);
  let files: string[] = [];

  if (stats.isDirectory()) {
    files = await findTsFiles(targetPath);
  } else if (stats.isFile() && targetPath.endsWith(".ts") && !targetPath.endsWith(".test.ts")) {
    files = [targetPath];
  }

  const results: FileResult[] = [];
  for (const file of files) {
    results.push(await checkFile(file));
  }

  return results;
}

/**
 * 메인 검증 함수. 주어진 경로들을 모두 검증하고 결과를 반환한다.
 */
export async function check(paths: string[]): Promise<CheckResult> {
  const allResults: FileResult[] = [];

  for (const path of paths) {
    const results = await checkPath(path);
    allResults.push(...results);
  }

  let totalViolations = 0;
  let errors = 0;
  let warnings = 0;

  for (const result of allResults) {
    totalViolations += result.violations.length;
    for (const v of result.violations) {
      if (v.level === "error") errors++;
      else if (v.level === "warning") warnings++;
    }
  }

  return {
    files: allResults,
    totalViolations,
    errors,
    warnings,
  };
}

/**
 * CLI 진입점. 인자로 받은 경로를 검증하고 결과를 출력한다.
 */
export async function main(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("사용법: bun run tools/check-comments.ts [파일 또는 디렉터리...]");
    return 1;
  }

  try {
    const result = await check(args);

    // 위반 항목 출력
    for (const fileResult of result.files) {
      if (fileResult.violations.length === 0) continue;

      for (const v of fileResult.violations) {
        const level = v.level === "error" ? "ERROR" : "WARN";
        console.log(`${v.file}:${v.line} [${level}] ${v.message}`);
      }
    }

    // 요약 출력
    console.log("");
    console.log(`총 ${result.totalViolations}개 위반 발견 (errors: ${result.errors}, warnings: ${result.warnings})`);

    // error 가 있으면 종료 코드 1
    return result.errors > 0 ? 1 : 0;
  } catch (error) {
    console.error("검증 실패:", error);
    return 1;
  }
}

// CLI 실행
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
