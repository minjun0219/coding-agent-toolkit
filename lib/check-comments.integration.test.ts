import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMENT_LINT_TARGET_DIRS,
  checkSource,
  type Violation,
} from "./check-comments";

/**
 * 통합 테스트: repo 의 검사 대상 디렉터리에 있는 `.ts` 파일이 전부 통과해야 한다.
 *
 * 단위 테스트 (`check-comments.test.ts`) 가 규칙 자체의 정확성을 보증한다면, 이
 * 테스트는 "기존 코드는 정책 위반 없이 통과" 를 회귀 테스트 단에서 강제한다 —
 * `bun test` 만 돌려도 lint 가 자동으로 따라온다. 검사 대상 디렉터리 목록은
 * CLI 와 같은 `COMMENT_LINT_TARGET_DIRS` 를 import 해 두 진입점이 갈라지지
 * 않도록 한다.
 */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SELF_DIR, "..");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name as string;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("repo 의 모든 검사 대상 .ts 파일이 코드 주석 정책을 통과한다", () => {
  const files: string[] = [];
  for (const d of COMMENT_LINT_TARGET_DIRS) {
    collectTsFiles(resolve(ROOT, d), files);
  }
  files.sort();
  expect(files.length).toBeGreaterThan(0);

  const violations: Violation[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    violations.push(...checkSource(relative(ROOT, file), source));
  }
  // 실패 시 어떤 파일/라인이 잘못됐는지 메시지에 노출되도록.
  expect(
    violations.map(
      (v) => `${v.file}:${v.line}: [${v.rule}] ${v.message}`,
    ),
  ).toEqual([]);
});
