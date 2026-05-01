import * as ts from "typescript";

/**
 * 코드 주석 정책 검증기.
 *
 * `AGENTS.md` 의 두 정책을 lint 단으로 끌어올려, 새 위반이 들어오면 `bun test` /
 * `bun run lint:comments` 가 실패하도록 한다.
 *
 * - **jsdoc-missing**: top-level `export function` / `export class` (default export 포함)
 *   직전에 `/** ... *\/` 블록이 없으면 위반. interface / type / const 는 정책 대상이
 *   아니므로 검사하지 않는다.
 * - **hangul-required**: 한 줄(`//`) / 블록(`/* *\/`) 주석 본문에 영어 단어 (Latin 4자
 *   이상 연속) 가 들어 있는데 한글이 한 글자도 없으면 위반. URL 만 있는 주석, pragma
 *   directive (`@ts-ignore`, `eslint-disable*`, `biome-ignore` 등) 는 통과.
 *
 * "검증 규칙은 정책과 1:1 매칭" 을 유지하기 위해, 추가 규칙 (라이센스 헤더,
 * 상세도 평가 등) 은 별도 phase 로 분리하고 이 모듈은 두 규칙만 다룬다.
 */

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const ENGLISH_WORD_RE = /[A-Za-z]{4,}/;

/**
 * pragma 성격이 강해 의미적으로 한글로 옮길 수 없는 주석 prefix.
 * 첫 비공백 라인이 이 패턴이면 hangul-required 검사를 면제한다.
 */
const PRAGMA_RE =
  /^(?:@ts-|eslint-|biome-ignore|prettier-ignore|c8 ignore|istanbul ignore|tslint:|TODO\b|FIXME\b)/;

export type ViolationRule = "jsdoc-missing" | "hangul-required";

export interface Violation {
  /** 보고용 파일 경로 (호출자가 넘긴 그대로). */
  file: string;
  /** 1부터 시작하는 라인 번호. */
  line: number;
  rule: ViolationRule;
  message: string;
}

/**
 * lint 가 훑는 디렉터리 단일 소스 — CLI (`tools/check-comments.ts`) 와 통합
 * 테스트 (`check-comments.integration.test.ts`) 가 이 상수를 import 해 같은
 * 검사 대상을 공유한다. 둘이 갈라지면 `bun test` 와 `bun run lint:comments`
 * 결과가 어긋날 수 있어 하나로 모은다.
 */
export const COMMENT_LINT_TARGET_DIRS = [
  "lib",
  ".opencode/plugins",
  "tools",
] as const;

/**
 * 단일 TypeScript 소스를 검사한다.
 *
 * `file` 은 메시지에 그대로 들어가며 — 절대 / 상대 경로 결정은 호출자 책임이다.
 * 파싱 실패시에도 throw 하지 않고 가능한 만큼 위반을 모은다.
 */
export function checkSource(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes 인자*/ true,
  );
  return [...checkJSDoc(file, sf, source), ...checkHangul(file, sf, source)];
}

function checkJSDoc(
  file: string,
  sf: ts.SourceFile,
  source: string,
): Violation[] {
  const out: Violation[] = [];
  ts.forEachChild(sf, (node) => {
    if (!isExportedFunctionOrClass(node)) return;
    const start = node.getStart(sf, /*includeJsDocComment 인자*/ false);
    if (hasJSDocAbove(source, node.pos)) return;
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    const kind = ts.isClassDeclaration(node) ? "class" : "function";
    const name =
      (node as ts.FunctionDeclaration | ts.ClassDeclaration).name?.text ??
      "(anonymous)";
    out.push({
      file,
      line,
      rule: "jsdoc-missing",
      message: `export ${kind} \`${name}\` 직전에 JSDoc(/** ... */)이 없습니다.`,
    });
  });
  return out;
}

function isExportedFunctionOrClass(
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.ClassDeclaration {
  if (!ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasJSDocAbove(source: string, pos: number): boolean {
  const ranges = ts.getLeadingCommentRanges(source, pos) ?? [];
  for (const r of ranges) {
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const text = source.slice(r.pos, r.end);
    // `/**` 로 시작하지만 `/**/` (빈 블록 주석) 는 제외.
    if (text.startsWith("/**") && !text.startsWith("/**/")) return true;
  }
  return false;
}

function checkHangul(
  file: string,
  sf: ts.SourceFile,
  source: string,
): Violation[] {
  const out: Violation[] = [];
  for (const c of extractComments(source)) {
    const inner = stripCommentMarkers(c.text);
    if (!shouldCheckComment(inner)) continue;
    // URL 자체는 영어 단어로 치지 않는다 — 제거 후에도 영어 단어가 남아 있는
    // 경우에만 한글 부재를 위반으로 본다 (예: `// see https://...` 의 "see").
    const withoutUrls = stripUrls(inner);
    if (!ENGLISH_WORD_RE.test(withoutUrls)) continue;
    if (HANGUL_RE.test(inner)) continue;
    const line = sf.getLineAndCharacterOfPosition(c.start).line + 1;
    out.push({
      file,
      line,
      rule: "hangul-required",
      message:
        "주석에 영어 단어가 있지만 한글이 한 글자도 없습니다 (AGENTS.md 한글 주석 정책).",
    });
  }
  return out;
}

/** 흔한 scheme (http/https/ftp/file/git/ssh) URL 토큰을 공백으로 치환. */
function stripUrls(text: string): string {
  return text.replace(/\b(?:https?|ftp|file|git|ssh):\/\/\S+/gi, " ");
}

interface RawComment {
  start: number;
  text: string;
}

/**
 * 소스에서 `//` 와 `/* *\/` 주석을 모두 뽑는다.
 *
 * `ts.createScanner` 는 template literal 의 `${...}` 와 backtick 짝을 자체적으로
 * 추적하지 못해, 큰 파일에서 backtick 안의 `//` 를 single-line comment 로 잘못
 * 잡는 경우가 있어 (`reScanTemplateToken` 호출이 필요하다) 직접 상태를 tracking
 * 하는 작은 lexer 로 대체했다. template expression (`${...}`) 안의 주석도
 * 정책 우회를 막기 위해 똑같이 수집한다 — `scanCode` 가 재귀 호출로 brace
 * 깊이를 추적하며 한 lexer 가 모든 컨텍스트를 처리한다. 정규식 리터럴은
 * 단순화를 위해 division 으로 취급한다 — `// ` 가 정규식 안에 들어가는 건
 * 매우 드물고, 들어가더라도 escape 가 필요하므로 false positive 가능성은 낮다.
 */
function extractComments(source: string): RawComment[] {
  const out: RawComment[] = [];
  scanCode(source, 0, /*tracksClosingBrace 인자*/ false, out);
  return out;
}

/**
 * 코드 본문을 lexing 하면서 만나는 모든 주석을 `out` 에 push 한다.
 *
 * `tracksClosingBrace` 가 true 면 brace depth 가 0 이 되는 닫는 `}` 위치 +1
 * 을 반환해 호출자 (template expression) 가 이어 받게 한다. false 면 EOF
 * 까지 진행 후 `source.length` 반환.
 */
function scanCode(
  s: string,
  start: number,
  tracksClosingBrace: boolean,
  out: RawComment[],
): number {
  const n = s.length;
  let i = start;
  let depth = tracksClosingBrace ? 1 : 0;
  while (i < n) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      i = skipQuotedString(s, i, c);
      continue;
    }
    if (c === "`") {
      i = scanTemplateLiteral(s, i, out);
      continue;
    }
    if (tracksClosingBrace) {
      if (c === "{") {
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        depth--;
        i++;
        if (depth === 0) return i;
        continue;
      }
    }
    if (c === "/" && i + 1 < n) {
      const next = s[i + 1];
      if (next === "/") {
        const cstart = i;
        i += 2;
        while (i < n && s[i] !== "\n") i++;
        out.push({ start: cstart, text: s.slice(cstart, i) });
        continue;
      }
      if (next === "*") {
        const cstart = i;
        i += 2;
        while (i < n - 1 && !(s[i] === "*" && s[i + 1] === "/")) i++;
        if (i < n - 1) i += 2;
        else i = n;
        out.push({ start: cstart, text: s.slice(cstart, i) });
        continue;
      }
    }
    i++;
  }
  return i;
}

/** `'...'` 또는 `"..."` 를 건너뛰고 닫는 quote 다음 위치를 반환한다. */
function skipQuotedString(s: string, start: number, quote: string): number {
  let i = start + 1;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i + 1;
    i++;
  }
  return i;
}

/**
 * `\`...\`` 를 건너뛰며 — `${...}` 본문은 `scanCode` 로 재귀 들어가 그 안의
 * 주석도 동일하게 수집한다. 닫는 backtick 다음 위치를 반환한다.
 */
function scanTemplateLiteral(
  s: string,
  start: number,
  out: RawComment[],
): number {
  let i = start + 1;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") {
      i = scanCode(s, i + 2, /*tracksClosingBrace 인자*/ true, out);
      continue;
    }
    i++;
  }
  return i;
}

function stripCommentMarkers(raw: string): string {
  if (raw.startsWith("//")) return raw.slice(2).trim();
  if (raw.startsWith("/*")) {
    let body = raw.slice(2);
    if (body.endsWith("*/")) body = body.slice(0, -2);
    return body
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .trim();
  }
  return raw.trim();
}

function shouldCheckComment(inner: string): boolean {
  if (!inner) return false;
  for (const line of inner.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    return !PRAGMA_RE.test(t);
  }
  return false;
}
