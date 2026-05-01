import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";

/**
 * Locked SPEC body → GitHub Issue 시리즈 동기화.
 *
 * Phase 2 의 ROADMAP 합의: issue body 의 source-of-truth 는 노션 본문이 아니라
 * grace 가 잠근 SPEC body 다 — drift / 양방향 sync 를 단순하게 유지하기 위해서.
 *
 * 매핑 규약 (issue #4 의 In-scope):
 *   - 한 SPEC = 한 epic issue
 *   - SPEC 의 `# 합의 TODO` 섹션 bullet 1 개 = 한 sub-issue
 *
 * 동등성 (idempotency):
 *   - 동일 SPEC 을 다시 동기화하면 issue 를 중복 생성하지 않는다.
 *   - 식별 단서는 issue body 에 박은 마커 (`<!-- spec-pact:slug=<slug>:kind=epic -->`
 *     / `<!-- spec-pact:slug=<slug>:kind=sub:index=<n> -->`) + 라벨 (`spec-pact`) 결합.
 *   - 닫힌 issue 도 매칭 — 자동 재오픈 / 본문 갱신은 out-of-scope (이번 phase 에서는 X).
 *
 * 외부 의존성 0:
 *   - GitHub REST API 를 `fetch` 로 직접 호출. octokit / @octokit/rest 를 끌어오지 않는다.
 *   - YAML frontmatter 도 우리가 쓰는 키 (slug, source_page_id, source_url, status,
 *     spec_pact_version) 만 직접 파싱 — 외부 YAML 라이브러리 의존성을 만들지 않는다.
 */

/**
 * SPEC frontmatter / 본문에서 issue 동기화에 필요한 필드만 뽑는다.
 * `spec-pact` 가 frontmatter 에 박는 키 중 동기화 단계에서 쓰는 것만 모았다 — 나머지는
 * 같은 파싱 단을 깨지 않고 그대로 통과시킨다 (forward compatibility).
 */
export interface ParsedSpec {
  /** SPEC frontmatter 의 `slug` — 마커 / 라벨의 핵심 키. 누락 시 throw. */
  slug: string;
  /** Notion page id (8-4-4-4-12 정규화 형식). 누락 가능 (외부 SPEC). */
  sourcePageId?: string;
  /** Notion 원본 URL. */
  sourceUrl?: string;
  /** SPEC 버전 — `spec_pact_version`, default 1. */
  specPactVersion: number;
  /** SPEC 의 `status` (locked / drifted / verified). 누락 가능. */
  status?: string;
  /** SPEC 의 `# 요약` 단락 (epic body 헤더로 인용). 누락 시 빈 문자열. */
  summary: string;
  /** SPEC 의 `# 합의 TODO` 섹션의 1 단계 bullet 들. 빈 배열 = epic only. */
  todos: string[];
}

/** GitHub REST API 가 돌려주는 issue 의 우리가 실제로 읽는 부분. */
export interface IssueRef {
  number: number;
  htmlUrl: string;
  state: string;
  title: string;
  /** 마커 dedupe 에 쓰는 raw body. */
  body: string;
}

/**
 * 동기화 한 단위 — epic 또는 sub-issue 한 개의 plan + 매칭 결과.
 *
 * `existing` 이 있으면 이미 만들어진 issue 를 그대로 반환 (idempotent), 없으면 새로
 * 생성하면서 그 결과로 채운다.
 */
export interface IssuePlanItem {
  kind: "epic" | "sub";
  /** sub 의 0-based index. epic 일 때는 undefined. */
  index?: number;
  /** 생성 시 사용할 title. */
  title: string;
  /** 생성 시 사용할 body (마커 포함). */
  body: string;
  /** 동기화 시도 전에 발견된 기존 issue (idempotency). */
  existing?: IssueRef;
  /** 새로 만들어진 issue (apply 단계에서만 채워진다). */
  created?: IssueRef;
}

export interface IssueSyncPlan {
  slug: string;
  /** "owner/repo" 형식. */
  repo: string;
  epic: IssuePlanItem;
  subs: IssuePlanItem[];
}

export interface IssueSyncResult extends IssueSyncPlan {
  /** dryRun 이면 false — remote 호출이 없었다는 뜻. */
  applied: boolean;
}

/** SPEC frontmatter 에서 우리가 직접 파싱하는 키 — `validateSpec` 와 lockstep. */
const FRONTMATTER_KEYS = [
  "slug",
  "source_page_id",
  "source_url",
  "spec_pact_version",
  "status",
] as const;

/** 마커 prefix / suffix — issue body 어디에 박혀 있어도 substring 매칭으로 발견. */
const MARKER_PREFIX = "<!-- spec-pact:";
const MARKER_SUFFIX = " -->";

/**
 * SPEC 본문 한 덩어리에서 frontmatter + 필요한 섹션을 뽑는다.
 *
 * - frontmatter 는 `---\n…\n---` 사이의 `key: value` (큰따옴표 / 작은따옴표 제거).
 *   배열 / 객체 값은 우리가 안 쓰므로 무시한다.
 * - `# 요약` 다음 ~ 다음 `# ` 까지를 summary 로 모은다 (한 단락).
 * - `# 합의 TODO` 다음 ~ 다음 `# ` 까지를 훑어 1 단계 bullet (`-` 또는 `*`) 만 수집.
 *   2 단계 이상 (들여쓰기 bullet) 은 epic 의 task list 가 너무 잘게 쪼개지지 않도록
 *   같은 항목의 부연으로 보고 무시한다.
 *
 * 누락 / 손상에 graceful — slug 만 mandatory, 나머지는 default. slug 가 없으면 throw.
 */
export function parseSpecBody(text: string): ParsedSpec {
  if (typeof text !== "string") {
    throw new Error("parseSpecBody: input must be a string");
  }
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const rawSlug = (fm.slug ?? "").trim();
  if (!rawSlug) {
    throw new Error(
      "parseSpecBody: frontmatter is missing `slug` — only locked SPECs (grace finalize 후) 가 동기화 대상이다",
    );
  }
  const versionRaw = (fm.spec_pact_version ?? "").toString().trim();
  const versionParsed = Number.parseInt(versionRaw, 10);
  const specPactVersion =
    Number.isFinite(versionParsed) && versionParsed > 0 ? versionParsed : 1;
  return {
    slug: rawSlug,
    sourcePageId: nonEmpty(fm.source_page_id),
    sourceUrl: nonEmpty(fm.source_url),
    specPactVersion,
    status: nonEmpty(fm.status),
    summary: extractSection(body, "요약").trim(),
    todos: extractTopLevelBullets(extractSection(body, "합의 TODO")),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `---\n…\n---\n` 사이의 frontmatter 와 그 뒤의 본문을 분리.
 * frontmatter 가 없으면 frontmatter="" / body=text.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith("---")) return { frontmatter: "", body: text };
  // 첫 `---` 이후 다음 `---` 까지를 frontmatter 로 잡는다.
  const after = text.slice(3);
  const newlineAfterFirst = after.indexOf("\n");
  if (newlineAfterFirst === -1) return { frontmatter: "", body: text };
  const rest = after.slice(newlineAfterFirst + 1);
  // 닫는 `---` 는 줄 단독으로 나타나야 한다 (앞뒤 공백 허용).
  const closeMatch = rest.match(/^\s*---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: "", body: text };
  }
  const frontmatter = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, "");
  return { frontmatter, body };
}

/**
 * frontmatter 의 우리가 쓰는 key 만 한 줄씩 추출한다.
 * 값은 양끝 따옴표 / whitespace 만 제거 — 배열 / 객체 / multi-line 은 무시 (해당
 * 키만 처리). 키 충돌 시 마지막 값이 이긴다.
 */
function parseFrontmatter(text: string): Partial<Record<typeof FRONTMATTER_KEYS[number], string>> {
  const out: Partial<Record<typeof FRONTMATTER_KEYS[number], string>> = {};
  if (!text) return out;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!FRONTMATTER_KEYS.includes(key as typeof FRONTMATTER_KEYS[number])) continue;
    let value = trimmed.slice(colon + 1).trim();
    // 양끝 따옴표 한 쌍 제거 (큰따옴표 / 작은따옴표).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key as typeof FRONTMATTER_KEYS[number]] = value;
  }
  return out;
}

/**
 * `# <heading>` 섹션 본문을 그 다음 `# ` 헤딩 직전까지 잘라 반환.
 * 한국어 섹션 헤딩이 정확히 일치할 때만 매칭 (앞뒤 공백 허용). 없으면 빈 문자열.
 */
function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === `# ${heading}`);
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    if (t.startsWith("# ")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

/**
 * 1 단계 bullet 만 추출. `- ` 또는 `* ` 로 시작하는 (들여쓰기 없는) 줄만.
 * 들여쓰기 (` -`, `\t-`) 가 있는 줄 / 빈 줄 / 일반 텍스트는 무시.
 * 결과 문자열은 marker `- ` 만 떼고 trim.
 */
function extractTopLevelBullets(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const text = line.slice(2).trim();
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/** SPEC 파일 경로 해석 — slug 또는 명시 path. 둘 다 없으면 throw. */
export interface ResolveSpecPathOptions {
  slug?: string;
  path?: string;
  /** project-relative SPEC 디렉터리 (default `.agent/specs`). */
  specDir?: string;
  /** project root (default `process.cwd()`). */
  projectRoot?: string;
}

export interface ResolvedSpecPath {
  /** 절대 경로. */
  path: string;
  /** 해석에 쓴 slug (path 입력이면 frontmatter 에서 채워진 후 caller 가 setter). */
  slug?: string;
}

/**
 * slug 또는 path 를 받아 SPEC 파일 절대 경로를 돌려준다.
 *
 * - path 가 주어지면 그대로 사용 (절대 / 상대 모두 OK; 상대는 projectRoot 기준).
 * - slug 만 주어지면 `<projectRoot>/<specDir>/<slug>.md` 로 해석.
 * - 둘 다 없거나 둘 다 있으면 throw — 호출자 의도 모호.
 *
 * 파일 존재 여부는 검사하지 않는다 (read 단계가 한다).
 */
export function resolveSpecPath(opts: ResolveSpecPathOptions): ResolvedSpecPath {
  const slug = (opts.slug ?? "").trim();
  const path = (opts.path ?? "").trim();
  if (!slug && !path) {
    throw new Error(
      "resolveSpecPath: must pass either `slug` or `path` (둘 중 하나만)",
    );
  }
  if (slug && path) {
    throw new Error(
      "resolveSpecPath: cannot pass both `slug` and `path` — pick one (slug 모드 또는 directory 모드)",
    );
  }
  const projectRoot = opts.projectRoot ?? process.cwd();
  const specDir = opts.specDir ?? ".agent/specs";
  if (path) {
    return { path: pathResolve(projectRoot, path) };
  }
  return {
    slug,
    path: pathResolve(projectRoot, specDir, `${slug}.md`),
  };
}

/** SPEC 파일 한 개를 읽어 `parseSpecBody` 까지 통과시킨다. */
export async function readAndParseSpec(specPath: string): Promise<ParsedSpec> {
  if (!existsSync(specPath)) {
    throw new Error(`readAndParseSpec: SPEC file not found at ${specPath}`);
  }
  const text = await readFile(specPath, "utf8");
  return parseSpecBody(text);
}

/** SPEC slug + 항목 종류로 dedupe 마커 문자열 생성. */
export function epicMarker(slug: string): string {
  return `${MARKER_PREFIX}slug=${slug}:kind=epic${MARKER_SUFFIX}`;
}

export function subMarker(slug: string, index: number): string {
  return `${MARKER_PREFIX}slug=${slug}:kind=sub:index=${index}${MARKER_SUFFIX}`;
}

/** issue title 의 길이 안전치 — GitHub 자체 한도(256) 보다 보수적으로 자른다. */
const TITLE_MAX = 200;

function clampTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX - 1)}…`;
}

export interface BuildIssuePlanOptions {
  /** epic / sub 모두에 붙는 기본 라벨. default `["spec-pact"]`. */
  defaultLabels?: string[];
}

/**
 * SPEC 한 개 → epic + sub plan 생성. remote 호출 없음 — 순수 함수.
 *
 * epic body:
 *   - `# 요약` 발췌 → epic body 헤더
 *   - SPEC source URL / Notion page id 한 줄
 *   - sub-issue 체크리스트 (`- [ ] #<n> <title>`) — 매칭된 기존 issue 가 있으면 그
 *     번호로, 없으면 placeholder (`- [ ] (will-create) <title>`) 로 채운다.
 *   - epic 마커 한 줄
 *
 * sub-issue body:
 *   - bullet 본문 한 단락
 *   - SPEC source / slug 한 줄
 *   - sub 마커 한 줄
 */
export function buildIssuePlan(
  spec: ParsedSpec,
  specPath: string,
  options: BuildIssuePlanOptions = {},
): { epic: IssuePlanItem; subs: IssuePlanItem[] } {
  const epicTitle = clampTitle(`[spec] ${spec.slug} v${spec.specPactVersion}`);
  const epicBody = renderEpicBody(spec, specPath);
  const epic: IssuePlanItem = {
    kind: "epic",
    title: epicTitle,
    body: `${epicBody}\n\n${epicMarker(spec.slug)}\n`,
  };
  const subs: IssuePlanItem[] = spec.todos.map((todo, i) => {
    const title = clampTitle(`[${spec.slug}] ${todo}`);
    const body = renderSubBody(spec, specPath, todo, i);
    return {
      kind: "sub",
      index: i,
      title,
      body: `${body}\n\n${subMarker(spec.slug, i)}\n`,
    };
  });
  // defaultLabels 는 client 측에서 createIssue 의 labels 로 바로 쓰지만, plan 단에서
  // 노출할 필요는 없다 — caller (apply) 가 들고 있으면 충분. 이 함수는 plan body / title
  // 만 책임진다.
  return { epic, subs };
}

function renderEpicBody(spec: ParsedSpec, specPath: string): string {
  const lines: string[] = [];
  lines.push(`# ${spec.slug} v${spec.specPactVersion}`);
  lines.push("");
  if (spec.summary) {
    lines.push(spec.summary);
    lines.push("");
  }
  lines.push("> source-of-truth");
  lines.push(`> SPEC: \`${specPath}\``);
  if (spec.sourceUrl) lines.push(`> Notion: ${spec.sourceUrl}`);
  if (spec.sourcePageId) lines.push(`> page id: \`${spec.sourcePageId}\``);
  lines.push("");
  if (spec.todos.length === 0) {
    lines.push("## 합의 TODO");
    lines.push("- (없음 — SPEC 의 `# 합의 TODO` 가 비어 있다)");
    return lines.join("\n");
  }
  lines.push("## 합의 TODO");
  for (let i = 0; i < spec.todos.length; i += 1) {
    // sub-issue 번호는 apply 시점에 채워지므로 plan 단에선 placeholder 만.
    lines.push(`- [ ] ${spec.todos[i]} <!-- sub:${i} -->`);
  }
  return lines.join("\n");
}

function renderSubBody(
  spec: ParsedSpec,
  specPath: string,
  todo: string,
  index: number,
): string {
  const lines: string[] = [];
  lines.push(`# ${todo}`);
  lines.push("");
  lines.push("> source-of-truth");
  lines.push(`> SPEC: \`${specPath}\` (\`# 합의 TODO\` 항목 ${index + 1})`);
  if (spec.sourceUrl) lines.push(`> Notion: ${spec.sourceUrl}`);
  return lines.join("\n");
}

/**
 * GitHub REST API 호출에 필요한 최소 옵션.
 *
 * `apiBaseUrl` 은 GHE 또는 테스트 mock 서버용 — default 는 공식 endpoint.
 * `userAgent` 는 GitHub 가 요구한다 — 빈 값이면 기본 식별자.
 */
export interface GithubClientOptions {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  userAgent?: string;
  /** 한 번에 가져올 issue 페이지 크기 (default 100, max 100). */
  pageSize?: number;
  /** 최대 페이지 수 (default 5 → 최대 500 issue 까지 dedupe 검색). */
  maxPages?: number;
}

/**
 * 작은 GitHub REST 래퍼.
 *
 * 노출 메서드는 두 가지:
 *   - `listSpecPactIssues(label)`: dedupe 용 — 라벨로 좁힌 issue 들의 body / title / number.
 *   - `createIssue({title, body, labels})`: 신규 생성.
 *
 * 외부 라이브러리 의존성 없이 fetch 만 사용한다. 테스트는 apiBaseUrl 을 로컬 Bun.serve
 * 로 가리켜 끝낸다.
 */
export class GithubIssueClient {
  private readonly token: string;
  readonly owner: string;
  readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(opts: GithubClientOptions) {
    if (!opts.token) {
      throw new Error("GithubIssueClient: token is required");
    }
    if (!opts.owner || !opts.repo) {
      throw new Error("GithubIssueClient: owner/repo are required");
    }
    this.token = opts.token;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.userAgent = opts.userAgent ?? "agent-toolkit-issue-sync";
    this.pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
    this.maxPages = Math.max(opts.maxPages ?? 5, 1);
  }

  /**
   * `labels=<label>&state=all` 로 페이지를 차례로 훑어 모은다.
   * pull request 도 issue endpoint 로 같이 나오므로 PR 응답 (`pull_request` 필드 존재)
   * 은 제외한다.
   */
  async listSpecPactIssues(label: string): Promise<IssueRef[]> {
    const out: IssueRef[] = [];
    for (let page = 1; page <= this.maxPages; page += 1) {
      const path = `/repos/${this.owner}/${this.repo}/issues?state=all&per_page=${this.pageSize}&page=${page}&labels=${encodeURIComponent(label)}`;
      const data = await this.request("GET", path);
      if (!Array.isArray(data)) {
        throw new Error(
          `GithubIssueClient.listSpecPactIssues: unexpected response shape (page=${page})`,
        );
      }
      if (data.length === 0) break;
      for (const item of data as Array<Record<string, unknown>>) {
        if (item.pull_request) continue;
        out.push(toIssueRef(item));
      }
      if (data.length < this.pageSize) break;
    }
    return out;
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<IssueRef> {
    const data = await this.request(
      "POST",
      `/repos/${this.owner}/${this.repo}/issues`,
      {
        title: input.title,
        body: input.body,
        labels: input.labels,
      },
    );
    if (!data || typeof data !== "object") {
      throw new Error("GithubIssueClient.createIssue: unexpected response shape");
    }
    return toIssueRef(data as Record<string, unknown>);
  }

  /**
   * 한 epic issue 의 body 를 통째로 patch 한다 — 새로 만든 sub-issue 의 번호를
   * task list 에 박을 때 사용. 부분 갱신은 안 한다 (idempotent 한 단순 PUT).
   */
  async updateIssueBody(number: number, body: string): Promise<IssueRef> {
    const data = await this.request(
      "PATCH",
      `/repos/${this.owner}/${this.repo}/issues/${number}`,
      { body },
    );
    if (!data || typeof data !== "object") {
      throw new Error("GithubIssueClient.updateIssueBody: unexpected response shape");
    }
    return toIssueRef(data as Record<string, unknown>);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.apiBaseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${this.token}`,
        "user-agent": this.userAgent,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `GitHub API ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

/** raw issue 응답 → 우리 IssueRef 정규화. 누락 필드는 안전 기본값. */
function toIssueRef(raw: Record<string, unknown>): IssueRef {
  const number = typeof raw.number === "number" ? raw.number : Number.NaN;
  if (!Number.isFinite(number)) {
    throw new Error("GitHub issue response missing `number`");
  }
  return {
    number,
    htmlUrl: typeof raw.html_url === "string" ? raw.html_url : "",
    state: typeof raw.state === "string" ? raw.state : "open",
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
  };
}

/**
 * 마커 substring 이 body 에 박혀 있는 issue 를 골라 plan 의 epic / sub 에 매칭한다.
 * 같은 마커가 두 issue 에 박혀 있으면 (사용자가 수동 복제한 경우) 가장 작은 issue 번호를
 * 진실로 본다 — 같은 SPEC 의 두 turn 사이에 닫혔다 다시 열린 케이스를 가장 보수적으로 처리.
 */
export function matchPlanToExisting(
  plan: { epic: IssuePlanItem; subs: IssuePlanItem[] },
  existing: IssueRef[],
  slug: string,
): { epic: IssuePlanItem; subs: IssuePlanItem[] } {
  const sortedExisting = [...existing].sort((a, b) => a.number - b.number);
  const eMarker = epicMarker(slug);
  const epic: IssuePlanItem = {
    ...plan.epic,
    existing: sortedExisting.find((i) => i.body.includes(eMarker)),
  };
  const subs = plan.subs.map((s) => {
    const m = subMarker(slug, s.index!);
    const found = sortedExisting.find((i) => i.body.includes(m));
    return { ...s, existing: found };
  });
  return { epic, subs };
}

export interface SyncSpecToIssuesOptions {
  parsed: ParsedSpec;
  specPath: string;
  client: GithubIssueClient;
  /** epic / sub 양쪽에 붙일 라벨. default `["spec-pact"]`. */
  defaultLabels?: string[];
  /** true 면 plan 만 만들고 remote 호출은 하지 않는다. */
  dryRun?: boolean;
}

/**
 * SPEC → epic + sub-issue 동기화 한 번.
 *
 * 단계:
 *   1. 라벨 `spec-pact` 로 기존 issue 를 페이지별로 모아 dedupe 단서 수집
 *   2. plan build → 마커로 매칭
 *   3. dryRun 이면 여기서 종료 (applied=false)
 *   4. epic 신규면 createIssue, sub 도 동일 — 기존 매치는 skip (idempotent)
 *   5. epic body 의 task list 에 sub-issue 번호를 채워 다시 patch
 */
export async function syncSpecToIssues(
  opts: SyncSpecToIssuesOptions,
): Promise<IssueSyncResult> {
  const labels = (opts.defaultLabels ?? ["spec-pact"]).filter(
    (l) => typeof l === "string" && l.trim().length > 0,
  );
  if (labels.length === 0) {
    throw new Error(
      "syncSpecToIssues: at least one label is required (defaults to ['spec-pact']) — used both as discovery filter and dedupe scope",
    );
  }
  const dedupeLabel = labels[0]!;
  const existing = await opts.client.listSpecPactIssues(dedupeLabel);
  const plan = buildIssuePlan(opts.parsed, opts.specPath, {
    defaultLabels: labels,
  });
  const matched = matchPlanToExisting(plan, existing, opts.parsed.slug);
  const result: IssueSyncResult = {
    slug: opts.parsed.slug,
    repo: `${opts.client.owner}/${opts.client.repo}`,
    epic: matched.epic,
    subs: matched.subs,
    applied: false,
  };
  if (opts.dryRun) return result;

  // 1) sub-issue 들부터 — epic body 의 task list 에 번호를 박으려면 sub 번호가 먼저 필요.
  for (const s of result.subs) {
    if (s.existing) continue;
    const created = await opts.client.createIssue({
      title: s.title,
      body: s.body,
      labels,
    });
    s.created = created;
  }
  // 2) epic 의 task list 갱신용 body 다시 렌더 — placeholder `<!-- sub:i -->` 줄을
  //    `#<n>` 으로 치환한다. 마커 / source line 은 그대로.
  const epicBodyWithRefs = patchEpicBodyWithSubRefs(result);
  if (!result.epic.existing) {
    const created = await opts.client.createIssue({
      title: result.epic.title,
      body: epicBodyWithRefs,
      labels,
    });
    result.epic.created = created;
  } else if (result.epic.existing.body !== epicBodyWithRefs) {
    // 기존 epic 의 body 가 새 plan 과 같지 않으면 한 번 patch — 새 sub 가 추가된 경우.
    const updated = await opts.client.updateIssueBody(
      result.epic.existing.number,
      epicBodyWithRefs,
    );
    result.epic.created = updated;
  }
  result.applied = true;
  return result;
}

/**
 * epic body 의 `<!-- sub:i -->` placeholder 를 실제 sub-issue 번호로 치환.
 * 매칭되는 sub 가 (existing 이든 created 이든) 없으면 그대로 둔다 — 다음 turn 에 메꿔진다.
 */
function patchEpicBodyWithSubRefs(result: IssueSyncResult): string {
  let body = result.epic.body;
  for (const s of result.subs) {
    if (s.index === undefined) continue;
    const ref = s.created ?? s.existing;
    if (!ref) continue;
    const placeholder = `<!-- sub:${s.index} -->`;
    body = body.split(placeholder).join(`(#${ref.number})`);
  }
  return body;
}

/** apply 단계에서 채워진 issue ref 를 평면화 — 호출자 응답에 그대로 surface. */
export function flattenSyncResult(result: IssueSyncResult): {
  slug: string;
  repo: string;
  applied: boolean;
  epic: { number?: number; htmlUrl?: string; title: string; existed: boolean };
  subs: Array<{
    index: number;
    number?: number;
    htmlUrl?: string;
    title: string;
    existed: boolean;
  }>;
} {
  const epicRef = result.epic.created ?? result.epic.existing;
  return {
    slug: result.slug,
    repo: result.repo,
    applied: result.applied,
    epic: {
      number: epicRef?.number,
      htmlUrl: epicRef?.htmlUrl,
      title: result.epic.title,
      existed: !!result.epic.existing,
    },
    subs: result.subs.map((s) => {
      const ref = s.created ?? s.existing;
      return {
        index: s.index!,
        number: ref?.number,
        htmlUrl: ref?.htmlUrl,
        title: s.title,
        existed: !!s.existing,
      };
    }),
  };
}

/** "owner/repo" 검증 + 파싱. 잘못된 형식은 throw. */
export function parseRepoHandle(repo: string): { owner: string; repo: string } {
  if (typeof repo !== "string" || !repo.includes("/")) {
    throw new Error(
      `parseRepoHandle: expected "owner/repo" format, got "${repo}"`,
    );
  }
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(
      `parseRepoHandle: expected "owner/repo" format, got "${repo}"`,
    );
  }
  return { owner: owner.trim(), repo: name.trim() };
}
