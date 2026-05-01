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
    if (!ENGLISH_WORD_RE.test(inner)) continue;
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
 * 하는 작은 lexer 로 대체했다. 정규식 리터럴은 단순화를 위해 division 으로
 * 취급한다 — `// ` 가 정규식 안에 들어가는 건 매우 드물고, 들어가더라도 escape
 * 가 들어가야 하므로 false positive 가능성은 낮다.
 */
function extractComments(source: string): RawComment[] {
  const out: RawComment[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && i + 1 < n) {
      const next = source[i + 1];
      if (next === "/") {
        const start = i;
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        out.push({ start, text: source.slice(start, i) });
        continue;
      }
      if (next === "*") {
        const start = i;
        i += 2;
        while (i < n - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
        if (i < n - 1) i += 2;
        else i = n;
        out.push({ start, text: source.slice(start, i) });
        continue;
      }
    }
    if (c === '"' || c === "'") {
      i = skipQuotedString(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplateLiteral(source, i);
      continue;
    }
    i++;
  }
  return out;
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
 * `\`...\`` 를 건너뛰는데, `${...}` 안에서는 다시 일반 코드 lexer 로 들어가
 * 중첩된 string / template / comment 는 무시하고 brace depth 만 추적한다.
 *
 * 닫는 backtick 다음 위치를 반환한다 — 닫히지 않으면 EOF.
 */
function skipTemplateLiteral(s: string, start: number): number {
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
      i = skipTemplateExpression(s, i + 2);
      continue;
    }
    i++;
  }
  return i;
}

/** template literal 의 `${...}` 본문을 건너뛴다 — brace depth 가 0 이 되면 종료. */
function skipTemplateExpression(s: string, start: number): number {
  let i = start;
  const n = s.length;
  let depth = 1;
  while (i < n && depth > 0) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      i = skipQuotedString(s, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplateLiteral(s, i);
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === "/" && i + 1 < n) {
      const next = s[i + 1];
      if (next === "/") {
        while (i < n && s[i] !== "\n") i++;
        continue;
      }
      if (next === "*") {
        i += 2;
        while (i < n - 1 && !(s[i] === "*" && s[i + 1] === "/")) i++;
        if (i < n - 1) i += 2;
        else i = n;
        continue;
      }
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
