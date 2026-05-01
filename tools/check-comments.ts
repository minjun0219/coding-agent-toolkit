#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  COMMENT_LINT_TARGET_DIRS,
  checkSource,
  type Violation,
} from "../lib/check-comments";

/**
 * `bun run lint:comments` 진입점.
 *
 * 정책 검증 자체는 `lib/check-comments.ts` 의 순수 함수에 모여 있고, 이 파일은
 * 디스크 walking + 보고 + exit code 만 담당한다 (단위 테스트는 lib 쪽에서 본다).
 *
 * 검사 대상 디렉터리는 `COMMENT_LINT_TARGET_DIRS` 한 곳에서만 정의 — 통합
 * 테스트와 같은 소스를 공유한다. 위반 0 건이면 exit 0, 그 외에는 라인 단위
 * 보고 후 exit 1.
 */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SELF_DIR, "..");

function collectFiles(rootDir: string, out: string[] = []): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(rootDir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function main(): number {
  const files: string[] = [];
  for (const d of COMMENT_LINT_TARGET_DIRS) {
    collectFiles(resolve(ROOT, d), files);
  }
  files.sort();

  const violations: Violation[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    violations.push(...checkSource(rel, source));
  }

  if (violations.length === 0) {
    console.log(
      `[check-comments] OK — ${files.length} 파일, 위반 0 건`,
    );
    return 0;
  }

  for (const v of violations) {
    console.error(`${v.file}:${v.line}: [${v.rule}] ${v.message}`);
  }
  const jsdoc = violations.filter((v) => v.rule === "jsdoc-missing").length;
  const hangul = violations.filter((v) => v.rule === "hangul-required").length;
  console.error(
    `\n[check-comments] 위반 ${violations.length} 건 — jsdoc-missing=${jsdoc}, hangul-required=${hangul}`,
  );
  return 1;
}

process.exit(main());
