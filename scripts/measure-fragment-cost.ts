#!/usr/bin/env bun
/**
 * Phase 6.A 토대 — `spec-pact` mode fragment 분리의 token cost 측정.
 *
 * 출력: SKILL.md 코어와 4 모드 fragment 의 라인 / 바이트 / `bytes/4` 근사 토큰,
 * 그리고 모드별 loaded set (코어 + fragment 1 개) 의 합과 분리 전 monolith 대비 절감.
 *
 * 호스트(opencode) 가 SKILL.md 만 auto-load 하는지, fragments 디렉터리까지
 * auto-load 하는지에 따라 실제 절감이 갈린다 — 이 스크립트는 두 시나리오를 모두 표로 보여준다.
 *
 * 사용: `bun run scripts/measure-fragment-cost.ts`
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(REPO_ROOT, "skills/spec-pact/SKILL.md");
const FRAGMENT_DIR = join(REPO_ROOT, "skills/spec-pact/fragments");
const MODES = ["draft", "verify", "drift-check", "amend"] as const;

type Stat = { label: string; lines: number; bytes: number; tokens: number };

const stat = (label: string, path: string): Stat => {
  const buf = readFileSync(path);
  const lines = buf.toString("utf8").split(/\r?\n/).length;
  const bytes = buf.byteLength;
  // Rough approximation; not a tokenizer. Useful for relative comparison only.
  const tokens = Math.round(bytes / 4);
  return { label, lines, bytes, tokens };
};

const fmtRow = (s: Stat) =>
  `${s.label.padEnd(34)} ${String(s.lines).padStart(6)} ${String(s.bytes).padStart(7)} ${String(s.tokens).padStart(8)}`;

const header = `${"component".padEnd(34)} ${"lines".padStart(6)} ${"bytes".padStart(7)} ${"~tokens".padStart(8)}`;

const core = stat("SKILL.md (core / router)", SKILL_PATH);
const fragments: Stat[] = MODES.map((mode) =>
  stat(`fragments/${mode}.md`, join(FRAGMENT_DIR, `${mode}.md`)),
);

// Synthetic baseline: what the file would weigh if all four mode bodies were
// still inline (i.e. core + every fragment summed). This is the "old monolith"
// equivalent — mirrors the pre-split SKILL.md.
const monolith: Stat = {
  label: "old monolith (core + all 4 modes)",
  lines: core.lines + fragments.reduce((a, f) => a + f.lines, 0),
  bytes: core.bytes + fragments.reduce((a, f) => a + f.bytes, 0),
  tokens: core.tokens + fragments.reduce((a, f) => a + f.tokens, 0),
};

const perMode = MODES.map((mode, i) => {
  const frag = fragments[i];
  if (!frag) throw new Error(`missing fragment for mode ${mode}`);
  return {
    label: `loaded set: ${mode} (core + 1 fragment)`,
    lines: core.lines + frag.lines,
    bytes: core.bytes + frag.bytes,
    tokens: core.tokens + frag.tokens,
  } satisfies Stat;
});

const savingsVsMonolith = (s: Stat): Stat => ({
  label: `↳ savings vs monolith (${s.label.replace("loaded set: ", "")})`,
  lines: monolith.lines - s.lines,
  bytes: monolith.bytes - s.bytes,
  tokens: monolith.tokens - s.tokens,
});

console.log("# spec-pact fragment cost — Phase 6.A measurement\n");
console.log(header);
console.log("-".repeat(header.length));
console.log(fmtRow(core));
for (const frag of fragments) console.log(fmtRow(frag));
console.log("-".repeat(header.length));
console.log(fmtRow(monolith));
console.log("");
console.log("# Per-mode loaded set (assumes host auto-loads SKILL.md only)");
console.log(header);
console.log("-".repeat(header.length));
for (const m of perMode) {
  console.log(fmtRow(m));
  const savings = savingsVsMonolith(m);
  const pct = ((savings.bytes / monolith.bytes) * 100).toFixed(1);
  console.log(`${fmtRow(savings)}  (${pct}% smaller)`);
}
console.log("");
console.log(
  "Note: tokens 칸은 bytes/4 근사. 실제 LLM tokenizer 결과와 다를 수 있으나 상대 비교 목적엔 충분.",
);
console.log(
  "Host가 fragments/ 디렉터리도 auto-load 하면 절감은 0 — 다음 PR 에서 fragments 위치 재배치 검토.",
);
