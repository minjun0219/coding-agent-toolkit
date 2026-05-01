import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHangulRatio,
  hasKoreanContent,
  checkFile,
  findTsFiles,
  check,
} from "./check-comments";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-comments-test-"));
});

describe("getHangulRatio", () => {
  it("빈 문자열은 0 을 반환", () => {
    expect(getHangulRatio("")).toBe(0);
  });

  it("순수 한글 문자열은 1.0 을 반환", () => {
    expect(getHangulRatio("안녕하세요")).toBe(1.0);
  });

  it("영어만 있으면 0 을 반환", () => {
    expect(getHangulRatio("hello world")).toBe(0);
  });

  it("한글 + 영어 혼합 문자열은 비율을 반환", () => {
    const ratio = getHangulRatio("한글 hello");
    expect(ratio).toBeCloseTo(2 / 8, 2); // "한글" = 2자, 전체 8자
  });
});

describe("hasKoreanContent", () => {
  it("한글 비율 10% 이상이면 true", () => {
    expect(hasKoreanContent("한글이 포함된 주석입니다.")).toBe(true);
  });

  it("한글 비율 10% 미만이면 false", () => {
    expect(hasKoreanContent("This is a comment in English only")).toBe(false);
  });

  it("빈 문자열은 false", () => {
    expect(hasKoreanContent("")).toBe(false);
  });

  it("한글 1자 + 영어 많이 섞이면 임계치에 따라 판정", () => {
    // "한" = 1자, 전체 40자 → 2.5% < 10%
    expect(hasKoreanContent("한 This is a very long English comment here")).toBe(false);
    // "한글주석" = 4자, 전체 10자 → 40% >= 10%
    expect(hasKoreanContent("한글주석 hello")).toBe(true);
  });
});

describe("checkFile", () => {
  it("JSDoc 이 있는 export 함수는 통과", async () => {
    const file = join(dir, "valid.ts");
    writeFileSync(
      file,
      `
/**
 * 한글 주석이 있는 함수입니다.
 */
export function validFunc() {}
`,
    );
    const result = await checkFile(file);
    const errors = result.violations.filter((v) => v.level === "error");
    expect(errors.length).toBe(0);
  });

  it("JSDoc 없는 export 함수는 error", async () => {
    const file = join(dir, "missing-jsdoc.ts");
    writeFileSync(
      file,
      `
export function noJsDoc() {}
`,
    );
    const result = await checkFile(file);
    const errors = result.violations.filter((v) => v.rule === "missing-jsdoc");
    expect(errors.length).toBe(1);
    expect(errors[0].level).toBe("error");
  });

  it("한글 없는 JSDoc 은 warning", async () => {
    const file = join(dir, "no-korean.ts");
    writeFileSync(
      file,
      `
/**
 * This is an English comment only.
 */
export function englishOnly() {}
`,
    );
    const result = await checkFile(file);
    const warnings = result.violations.filter((v) => v.rule === "non-korean-comment");
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe("warning");
  });

  it("export class 도 검증", async () => {
    const file = join(dir, "class.ts");
    writeFileSync(
      file,
      `
export class NoJsDocClass {}
`,
    );
    const result = await checkFile(file);
    const errors = result.violations.filter((v) => v.rule === "missing-jsdoc");
    expect(errors.length).toBe(1);
  });

  it("export const 함수 할당도 검증", async () => {
    const file = join(dir, "const.ts");
    writeFileSync(
      file,
      `
export const arrowFunc = () => {};
`,
    );
    const result = await checkFile(file);
    const errors = result.violations.filter((v) => v.rule === "missing-jsdoc");
    expect(errors.length).toBe(1);
  });

  it("일반 주석도 한글 검증 (warning)", async () => {
    const file = join(dir, "inline.ts");
    writeFileSync(
      file,
      `
// This is an inline comment in English
const x = 1;
`,
    );
    const result = await checkFile(file);
    const warnings = result.violations.filter((v) => v.rule === "non-korean-comment");
    expect(warnings.length).toBe(1);
  });

  it("한글이 포함된 일반 주석은 통과", async () => {
    const file = join(dir, "korean-inline.ts");
    writeFileSync(
      file,
      `
// 한글이 포함된 인라인 주석
const x = 1;
`,
    );
    const result = await checkFile(file);
    const warnings = result.violations.filter((v) => v.rule === "non-korean-comment");
    expect(warnings.length).toBe(0);
  });

  it("JSDoc 과 export 사이에 빈 줄이 있어도 연결 인정", async () => {
    const file = join(dir, "blank-line.ts");
    writeFileSync(
      file,
      `
/**
 * 한글 주석이 있는 함수.
 */

export function withBlankLine() {}
`,
    );
    const result = await checkFile(file);
    const errors = result.violations.filter((v) => v.rule === "missing-jsdoc");
    expect(errors.length).toBe(0);
  });

  it("블록 주석 /* ... */ 도 한글 검증", async () => {
    const file = join(dir, "block.ts");
    writeFileSync(
      file,
      `
/* This is a block comment in English */
const y = 2;
`,
    );
    const result = await checkFile(file);
    const warnings = result.violations.filter((v) => v.rule === "non-korean-comment");
    expect(warnings.length).toBe(1);
  });
});

describe("findTsFiles", () => {
  it("디렉터리 안의 .ts 파일을 재귀적으로 찾음", async () => {
    const subdir = join(dir, "src");
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.ts"), "");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "c.ts"), "");

    const files = await findTsFiles(dir);
    expect(files.length).toBe(3);
    expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("c.ts"))).toBe(true);
  });

  it(".test.ts 파일은 제외", async () => {
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "a.test.ts"), "");

    const files = await findTsFiles(dir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith("a.ts")).toBe(true);
  });

  it("node_modules 는 제외", async () => {
    const nm = join(dir, "node_modules");
    mkdirSync(nm);
    writeFileSync(join(nm, "lib.ts"), "");
    writeFileSync(join(dir, "a.ts"), "");

    const files = await findTsFiles(dir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith("a.ts")).toBe(true);
  });
});

describe("check", () => {
  it("여러 파일을 검증하고 결과를 집계", async () => {
    const file1 = join(dir, "file1.ts");
    const file2 = join(dir, "file2.ts");

    writeFileSync(
      file1,
      `
export function noJsDoc1() {}
`,
    );
    writeFileSync(
      file2,
      `
export function noJsDoc2() {}
`,
    );

    const result = await check([file1, file2]);
    expect(result.errors).toBe(2);
    expect(result.totalViolations).toBe(2);
  });

  it("디렉터리 경로를 받아 모든 파일 검증", async () => {
    writeFileSync(
      join(dir, "a.ts"),
      `
export function noJsDoc() {}
`,
    );
    writeFileSync(
      join(dir, "b.ts"),
      `
/**
 * 한글 주석.
 */
export function valid() {}
`,
    );

    const result = await check([dir]);
    expect(result.errors).toBe(1); // a.ts 의 missing-jsdoc
    expect(result.files.length).toBe(2);
  });
});
