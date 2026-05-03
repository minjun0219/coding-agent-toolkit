import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `spec-pact` 의 4 모드 — DRAFT / VERIFY / DRIFT-CHECK / AMEND.
 *
 * Phase 6.A 토대 — 모드 본문이 더 이상 SKILL.md 안에 인라인으로 들어가지 않고
 * `skills/spec-pact/fragments/<mode>.md` 파일로 분리된다. plugin tool
 * `spec_pact_fragment(mode)` 가 이 모듈로 위임하여 plugin 절대경로 기준으로
 * fragment 를 읽는다 — 외부 설치 (`agent-toolkit@git+...`) 환경에서도 사용자
 * cwd 와 무관하게 정확히 발견된다.
 */
export const SPEC_PACT_MODES = [
  "draft",
  "verify",
  "drift-check",
  "amend",
] as const;

export type SpecPactMode = (typeof SPEC_PACT_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set(SPEC_PACT_MODES);

/**
 * 임의 입력을 `SpecPactMode` 로 검증한다. 정확히 4 개 슬러그만 허용 (`draft` /
 * `verify` / `drift-check` / `amend`). 그 외엔 어디서 들어왔는지 + 어떤 값이
 * 들어왔는지를 메시지에 박는다.
 */
export const assertSpecPactMode = (
  value: unknown,
  context = "spec_pact_fragment.mode",
): SpecPactMode => {
  if (typeof value !== "string" || !MODE_SET.has(value)) {
    throw new Error(
      `${context}: expected one of ${SPEC_PACT_MODES.join(" / ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as SpecPactMode;
};

export interface SpecPactFragment {
  mode: SpecPactMode;
  path: string;
  content: string;
}

/**
 * Plugin 절대경로 (`<plugin>/skills/spec-pact/fragments/<mode>.md`) 에서 모드별
 * fragment 본문을 읽어 반환한다.
 *
 * @param skillsDir Plugin 의 `skills/` 절대경로 (`SKILLS_DIR` from the plugin
 *   entrypoint). 외부 설치 시에도 plugin 의 `import.meta.url` 기반으로 잡혀서
 *   사용자 cwd 와 무관.
 * @param mode 모드 슬러그. 검증된 `SpecPactMode` 만 받는다.
 * @throws fragment 파일을 읽을 수 없을 때 — 메시지에 시도한 절대경로를 박아서
 *   설치 / 패키징 문제를 즉시 식별 가능하게 한다.
 */
export const loadSpecPactFragment = (
  skillsDir: string,
  mode: SpecPactMode,
): SpecPactFragment => {
  const path = resolve(skillsDir, "spec-pact", "fragments", `${mode}.md`);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `spec_pact_fragment: failed to read fragment at ${path} — ${reason}`,
    );
  }
  return { mode, path, content };
};
