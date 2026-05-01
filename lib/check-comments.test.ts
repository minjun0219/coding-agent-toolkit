import { describe, expect, test } from "bun:test";
import { checkSource } from "./check-comments";

describe("checkSource — jsdoc-missing", () => {
  test("export function 직전에 JSDoc 이 없으면 위반", () => {
    const src = `export function foo(): number {\n  return 1;\n}\n`;
    const v = checkSource("a.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("jsdoc-missing");
    expect(v[0]?.line).toBe(1);
    expect(v[0]?.message).toContain("foo");
  });

  test("export function 위에 JSDoc 이 있으면 통과", () => {
    const src =
      `/** 더할 나위 없는 함수. */\nexport function foo(): number {\n  return 1;\n}\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("export async function / export class 도 동일하게 본다", () => {
    const src =
      `export async function bar(): Promise<void> {}\n` +
      `export class Baz {}\n`;
    const v = checkSource("a.ts", src);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.rule)).toEqual([
      "jsdoc-missing",
      "jsdoc-missing",
    ]);
    expect(v[0]?.message).toContain("bar");
    expect(v[1]?.message).toContain("Baz");
  });

  test("export default function 도 검사 대상", () => {
    const src = `export default function entry() {}\n`;
    const v = checkSource("a.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("jsdoc-missing");
  });

  test("일반 // 주석은 JSDoc 으로 인정하지 않는다", () => {
    const src = `// 그냥 주석.\nexport function f() {}\n`;
    const v = checkSource("a.ts", src);
    expect(v.some((x) => x.rule === "jsdoc-missing")).toBe(true);
  });

  test("`/* ... */` 일반 블록 주석도 JSDoc 으로 인정하지 않는다", () => {
    const src = `/* 일반 블록 주석. */\nexport function f() {}\n`;
    expect(checkSource("a.ts", src).some((x) => x.rule === "jsdoc-missing")).toBe(true);
  });

  test("export 가 아닌 function / class 는 검사하지 않는다", () => {
    const src = `function priv() {}\nclass Priv {}\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("export interface / type / const 는 정책 대상이 아니다", () => {
    const src =
      `export interface I { x: number }\n` +
      `export type T = number;\n` +
      `export const C = 1;\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("빈 JSDoc(`/**/`) 은 통과로 인정하지 않는다", () => {
    const src = `/**/\nexport function f() {}\n`;
    expect(checkSource("a.ts", src).some((x) => x.rule === "jsdoc-missing")).toBe(true);
  });

  test("JSDoc 과 함수 사이에 빈 줄이 있어도 leading comment 로 인정", () => {
    const src =
      `/** 위에 있는 JSDoc. */\n\nexport function f() {}\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });
});

describe("checkSource — hangul-required", () => {
  test("영어 단어만 있는 // 주석은 위반", () => {
    const src = `// status now reports miss.\nconst x = 1;\n`;
    const v = checkSource("a.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("hangul-required");
    expect(v[0]?.line).toBe(1);
  });

  test("한글이 단 한 글자라도 있으면 통과", () => {
    const src = `// status 를 갱신.\nconst x = 1;\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("Latin 단어가 4자 미만이면 검사하지 않는다 (URL fragment / 짧은 식별자 보호)", () => {
    const src = `// id ok\nconst x = 1;\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("pragma directive 는 면제", () => {
    const cases = [
      `// @ts-ignore\n`,
      `// @ts-expect-error reason\n`,
      `// eslint-disable-next-line no-console\n`,
      `// biome-ignore lint/style/useTemplate: explanation\n`,
      `// TODO refactor later\n`,
      `// FIXME unstable\n`,
    ];
    for (const c of cases) {
      const v = checkSource("a.ts", `${c}const x = 1;\n`);
      expect(v.filter((x) => x.rule === "hangul-required")).toHaveLength(0);
    }
  });

  test("영어로만 작성된 블록 주석도 위반", () => {
    const src =
      `/* status now reports miss. */\nconst x = 1;\n`;
    const v = checkSource("a.ts", src);
    expect(v.some((x) => x.rule === "hangul-required")).toBe(true);
  });

  test("JSDoc 본문에 한글이 있으면 통과", () => {
    const src =
      `/**\n * status 를 다시 계산한다.\n */\nexport function f() {}\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });

  test("JSDoc 본문이 영어뿐이면 hangul-required 위반", () => {
    const src =
      `/**\n * Recompute the status field.\n */\nexport function f() {}\n`;
    const v = checkSource("a.ts", src);
    expect(v.some((x) => x.rule === "hangul-required")).toBe(true);
    expect(v.some((x) => x.rule === "jsdoc-missing")).toBe(false);
  });

  test("쉼표 / 숫자만 있는 짧은 주석은 통과", () => {
    const src = `// 1, 2, 3\nconst x = 1;\n`;
    expect(checkSource("a.ts", src)).toHaveLength(0);
  });
});

describe("checkSource — 위치 / 보고", () => {
  test("위반 line 은 1-based", () => {
    const src = `\n\nexport function f() {}\n`;
    const v = checkSource("path/to/a.ts", src);
    expect(v[0]?.file).toBe("path/to/a.ts");
    expect(v[0]?.line).toBe(3);
  });

  test("문법 오류가 있어도 throw 하지 않고 가능한 한 위반을 모은다", () => {
    const src = `// english only comment here\nexport function f( {\n`;
    const v = checkSource("a.ts", src);
    expect(v.some((x) => x.rule === "hangul-required")).toBe(true);
  });
});
