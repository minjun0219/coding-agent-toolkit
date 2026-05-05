/**
 * `gh` CLI 위임 layer — Phase 2 (SPEC → GitHub Issue sync) 전용.
 *
 * agent-toolkit 은 GitHub REST 를 직접 호출하지 않고 사용자 환경의 `gh` CLI 를
 * `Bun.spawn` 으로 위임한다. 그 결과:
 *  - 인증 / repo 자동 감지 / GHE / scope 관리 책임이 모두 `gh` 쪽으로 넘어가고
 *    plugin 은 env 변수를 추가하지 않는다.
 *  - 의존성을 추가하지 않는다 (AGENTS.md "avoid adding deps" 정신).
 *
 * 모든 wrapper 는 `GhExecutor` 인터페이스를 받아서 호출하므로 테스트에서는
 * fake executor 를 주입할 수 있다 (`MysqlExecutor` 와 같은 패턴).
 */

import { spawn } from "node:child_process";

/** `gh` 호출 한 번의 결과. */
export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `gh` 호출 실행자. 테스트에서 fake 를 끼우려고 인터페이스로 분리한다.
 *
 * 구현체는 `gh <args...>` 를 실행하고 결과 / 종료 코드를 그대로 surface 해야 한다.
 * `gh` 자체가 PATH 에 없으면 ENOENT 를 잡아서 `GhNotInstalledError` 로 throw 한다.
 */
export interface GhExecutor {
  run(args: readonly string[], stdin?: string): Promise<GhExecResult>;
}

/** `gh` 가 설치되지 않았을 때. PATH 에 `gh` 가 없거나 ENOENT. */
export class GhNotInstalledError extends Error {
  constructor() {
    super(
      "gh CLI not found on PATH. Install gh from https://cli.github.com (e.g. `brew install gh`).",
    );
    this.name = "GhNotInstalledError";
  }
}

/** `gh auth status` 가 실패했을 때 — 토큰이 없거나 만료. */
export class GhAuthError extends Error {
  constructor(stderr?: string) {
    const tail = stderr
      ? ` — ${stderr.trim().split("\n").slice(0, 2).join(" / ")}`
      : "";
    super(
      `gh CLI is not authenticated. Run: gh auth login --scopes "repo"${tail}`,
    );
    this.name = "GhAuthError";
  }
}

/** `gh` 가 살아 있지만 명령이 실패했을 때 (exit code !== 0, ENOENT 외). */
export class GhCommandError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    const tail = stderr
      ? ` — ${stderr.trim().split("\n").slice(0, 2).join(" / ")}`
      : "";
    super(`gh ${args.join(" ")} failed with exit ${exitCode}${tail}`);
    this.name = "GhCommandError";
  }
}

/**
 * `Bun.spawn` 백엔드 — 실제 `gh` 를 호출한다. 표준 사용 시점에서 한 번만 만들고
 * plugin lifetime 동안 재사용한다.
 *
 * `node:child_process` 의 `spawn` 을 쓰는 이유: Bun.spawn 도 가능하지만 stdin
 * 처리가 stream 기반이라 short-lived call 에서는 child_process 가 더 단순하고
 * Bun 환경에서도 native 로 동작한다.
 */
export const createBunGhExecutor = (): GhExecutor => ({
  async run(args, stdin) {
    return new Promise<GhExecResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("gh", [...args], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GhNotInstalledError());
          return;
        }
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";

      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GhNotInstalledError());
          return;
        }
        reject(err);
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
      });

      if (stdin !== undefined) {
        child.stdin?.write(stdin);
      }
      child.stdin?.end();
    });
  },
});

/**
 * `gh auth status` 가 인증된 상태인지 확인. 비인증 / 토큰 누락 시
 * `GhAuthError` 로 한 줄 가이드를 박아 throw.
 */
export const assertGhAuthed = async (exec: GhExecutor): Promise<void> => {
  const result = await exec.run(["auth", "status"]);
  if (result.exitCode !== 0) {
    throw new GhAuthError(result.stderr);
  }
};

/**
 * 현재 디렉터리의 GitHub repo 를 `owner/name` 형태로 반환. `override` 가 주어지면
 * 그것을 그대로 검증해서 반환한다.
 *
 * precedence: tool param `override` > caller responsibility (예: agent-toolkit.json
 * 의 `github.repo`) > `gh repo view --json nameWithOwner`.
 */
export const detectRepo = async (
  exec: GhExecutor,
  override?: string,
): Promise<string> => {
  if (override) {
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(override)) {
      throw new Error(
        `gh-cli detectRepo: repo override must be \`owner/name\`, got ${JSON.stringify(override)}`,
      );
    }
    return override;
  }
  const result = await exec.run([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (result.exitCode !== 0) {
    throw new GhCommandError(["repo", "view"], result.exitCode, result.stderr);
  }
  const owner = result.stdout.trim();
  if (!owner.includes("/")) {
    throw new Error(
      `gh-cli detectRepo: gh returned ${JSON.stringify(owner)}, expected owner/name`,
    );
  }
  return owner;
};

export interface GhIssueRef {
  number: number;
  url: string;
}

export interface GhIssueCreateInput {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

/**
 * 새 issue 생성. `gh issue create` 가 stdout 에 issue URL 만 한 줄로 반환하므로
 * 그 URL 에서 number 를 파싱한다.
 */
export const ghIssueCreate = async (
  exec: GhExecutor,
  input: GhIssueCreateInput,
): Promise<GhIssueRef> => {
  const args: string[] = [
    "issue",
    "create",
    "--repo",
    input.repo,
    "--title",
    input.title,
    "--body-file",
    "-",
  ];
  for (const label of input.labels ?? []) {
    args.push("--label", label);
  }
  const result = await exec.run(args, input.body);
  if (result.exitCode !== 0) {
    throw new GhCommandError(
      ["issue", "create", "--repo", input.repo, "--title", input.title],
      result.exitCode,
      result.stderr,
    );
  }
  return parseIssueUrl(result.stdout.trim());
};

export interface GhIssueEditInput {
  repo: string;
  number: number;
  body?: string;
  addLabels?: string[];
}

/**
 * 기존 issue 의 body / label 을 patch. body 는 stdin 으로 넘긴다 (긴 markdown
 * 안전).
 */
export const ghIssueEdit = async (
  exec: GhExecutor,
  input: GhIssueEditInput,
): Promise<void> => {
  const args: string[] = [
    "issue",
    "edit",
    String(input.number),
    "--repo",
    input.repo,
  ];
  if (input.body !== undefined) {
    args.push("--body-file", "-");
  }
  for (const label of input.addLabels ?? []) {
    args.push("--add-label", label);
  }
  const result = await exec.run(args, input.body);
  if (result.exitCode !== 0) {
    throw new GhCommandError(
      ["issue", "edit", String(input.number), "--repo", input.repo],
      result.exitCode,
      result.stderr,
    );
  }
};

export interface GhIssueListItem {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface GhIssueListByLabelOptions {
  state?: "open" | "closed" | "all";
  /**
   * `gh issue list --search "<text>"` substring 필터. dedupe 검색에서 marker
   * prefix (예: `<!-- spec-pact:slug=foo:`) 를 넘기면 해당 slug 의 epic + sub
   * 만 가져온다 — 같은 라벨에 수천 건의 issue 가 있어도 결과 set 이 한 SPEC
   * 범위로 좁혀져 dedupe 누락이 사실상 발생하지 않는다 (Codex P2 수정).
   */
  search?: string;
  /**
   * 결과 하드 캡. caller 가 명시할 때만 사용; 미지정 시 1000 (gh 의 max)
   * 으로 잡고 그 위에 search 로 좁히는 식으로 dedupe 누락을 막는다.
   */
  limit?: number;
}

/**
 * 라벨로 좁혀서 issue 목록을 가져온다 — dedupe 검색의 1차 필터. `gh` 의 `labels`
 * 필드가 버전별로 `string[]` 또는 `{name:string}[]` 이라 여기서 정규화한다.
 *
 * dedupe 신뢰성을 위해 호출자는 `options.search` 로 marker prefix 를 함께
 * 넘기는 것을 권장한다 — `--limit` 만으로는 한 라벨에 1000+ 이슈가 쌓이면
 * 기존 marker 가 결과에서 탈락한다.
 */
export const ghIssueListByLabel = async (
  exec: GhExecutor,
  repo: string,
  label: string,
  options: GhIssueListByLabelOptions = {},
): Promise<GhIssueListItem[]> => {
  const state = options.state ?? "all";
  const limit = String(options.limit ?? 1000);
  const args: string[] = [
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    state,
    "--limit",
    limit,
    "--json",
    "number,title,body,url,labels",
  ];
  if (options.search) {
    args.push("--search", options.search);
  }
  const result = await exec.run(args);
  if (result.exitCode !== 0) {
    throw new GhCommandError(
      ["issue", "list", "--repo", repo, "--label", label],
      result.exitCode,
      result.stderr,
    );
  }
  const trimmed = result.stdout.trim() || "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh-cli ghIssueListByLabel: failed to parse JSON (${reason}). stdout head: ${trimmed.slice(0, 120)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh-cli ghIssueListByLabel: expected array, got ${typeof parsed}`,
    );
  }
  return parsed.map(normalizeIssueListItem);
};

/**
 * `gh api <path>` 의 escape hatch. 위 wrapper 로 표현하기 어색한 호출 (예:
 * search/issues 의 정밀 필터, sub-issue 베타 endpoint) 이 필요할 때만 사용.
 */
export const ghApiGet = async <T = unknown>(
  exec: GhExecutor,
  path: string,
): Promise<T> => {
  const result = await exec.run(["api", path]);
  if (result.exitCode !== 0) {
    throw new GhCommandError(["api", path], result.exitCode, result.stderr);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return undefined as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh-cli ghApiGet: failed to parse JSON (${reason}). path: ${path}, stdout head: ${trimmed.slice(0, 120)}`,
    );
  }
};

const ISSUE_URL_RE = /\/issues\/(\d+)(?:[?#].*)?$/;

const parseIssueUrl = (url: string): GhIssueRef => {
  const match = url.match(ISSUE_URL_RE);
  if (!match || match[1] === undefined) {
    throw new Error(
      `gh-cli parseIssueUrl: cannot extract issue number from ${JSON.stringify(url)}`,
    );
  }
  return { number: Number(match[1]), url };
};

const normalizeIssueListItem = (raw: unknown): GhIssueListItem => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("gh-cli normalizeIssueListItem: row is not an object");
  }
  const row = raw as Record<string, unknown>;
  const number =
    typeof row.number === "number" ? row.number : Number(row.number);
  if (!Number.isFinite(number)) {
    throw new Error(
      `gh-cli normalizeIssueListItem: invalid number ${JSON.stringify(row.number)}`,
    );
  }
  const title = typeof row.title === "string" ? row.title : "";
  const body = typeof row.body === "string" ? row.body : "";
  const url = typeof row.url === "string" ? row.url : "";
  const rawLabels = Array.isArray(row.labels) ? row.labels : [];
  const labels = rawLabels
    .map((entry): string | null => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "name" in (entry as object)) {
        const name = (entry as { name: unknown }).name;
        return typeof name === "string" ? name : null;
      }
      return null;
    })
    .filter((value): value is string => value !== null);
  return { number, title, body, url, labels };
};

// ── Generic gh runner (Phase 2 후속 — `gh_run` plugin tool 의 백엔드) ────────

/**
 * `gh <args...>` 호출의 분류. plugin tool `gh_run` 이 dryRun gate 를 적용할
 * 지 결정하는 1차 기준. 알 수 없는 subcommand 는 보수적으로 `deny` 로 떨어진다
 * (allow-list 정신).
 */
export type GhCommandKind = "read" | "write" | "deny";

/** `gh_run` 이 deny 분류 명령을 받았을 때. */
export class GhDeniedCommandError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly reason: string,
  ) {
    super(
      `gh ${args.join(" ")} is denied — ${reason}. Allowed: read commands (auth status / repo view / issue list / pr view / api / search / ...) and write commands behind dryRun guard.`,
    );
    this.name = "GhDeniedCommandError";
  }
}

/** read 명령 set — 즉시 실행, dryRun 무시. */
const READ_VERBS: Record<string, ReadonlySet<string>> = {
  auth: new Set(["status"]),
  repo: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  label: new Set(["list"]),
  release: new Set(["list", "view"]),
  workflow: new Set(["list", "view"]),
  run: new Set(["list", "view", "watch"]),
  org: new Set(["list"]),
  gist: new Set(["list", "view"]),
};
/** verb 가 없는 read 명령 (top-level). */
const READ_TOPLEVEL = new Set(["search"]);

/** write 명령 set — dryRun guard 적용. */
const WRITE_VERBS: Record<string, ReadonlySet<string>> = {
  issue: new Set([
    "create",
    "edit",
    "close",
    "reopen",
    "delete",
    "lock",
    "unlock",
    "pin",
    "unpin",
    "comment",
    "develop",
    "transfer",
  ]),
  pr: new Set([
    "create",
    "edit",
    "close",
    "reopen",
    "ready",
    "review",
    "comment",
    "checkout",
  ]),
  repo: new Set(["create", "clone", "fork", "sync", "archive", "rename"]),
  label: new Set(["create", "edit", "delete", "clone"]),
  release: new Set(["create", "edit", "upload", "download"]),
  workflow: new Set(["enable", "disable"]),
  run: new Set(["delete"]),
  secret: new Set(["set", "delete"]),
  variable: new Set(["set", "delete"]),
  cache: new Set(["delete"]),
};

/** deny 명령 set — 사용자 환경 변경 / 파괴적 동작 위험. */
const DENY_VERBS: Record<string, ReadonlySet<string>> = {
  auth: new Set(["login", "logout", "refresh", "setup-git", "token"]),
  pr: new Set(["merge"]),
  repo: new Set(["delete", "edit"]),
  release: new Set(["delete"]),
  workflow: new Set(["run"]),
  run: new Set(["rerun", "cancel"]),
  extension: new Set([
    "install",
    "upgrade",
    "remove",
    "browse",
    "create",
    "exec",
    "list",
    "search",
  ]),
  alias: new Set(["set", "delete", "list", "import"]),
  config: new Set(["set", "get", "list", "clear-cache"]),
  gist: new Set(["create", "edit", "delete", "clone"]),
};

/**
 * `gh api` 의 method flag 위치를 찾아 반환. 명시적 `--method` / `-X` 가 있으면
 * 그 값. 없으면 — `gh api` 매뉴얼에 따라 — request parameter flag (`-f`,
 * `-F`, `--field`, `--raw-field`, `--input`, `-b`, `--body-file`) 가 하나라도
 * 있으면 default 가 **POST** 가 된다 (Codex P1 수정). 그것도 없으면 GET.
 */
const API_BODY_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-b",
  "--body-file",
]);
const apiMethod = (args: readonly string[]): string => {
  let hasBodyFlag = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--method" || args[i] === "-X") {
      return (args[i + 1] ?? "GET").toUpperCase();
    }
    const a = args[i] ?? "";
    if (a.startsWith("--method=")) {
      return a.slice("--method=".length).toUpperCase();
    }
    // body-bearing flags imply default POST per `gh api` manual.
    // `--field=foo=bar` / `--raw-field=foo=bar` / `-fkey=v` 같은 attached
    // forms 까지 포함하기 위해 prefix 매칭도 함께 본다.
    if (
      API_BODY_FLAGS.has(a) ||
      a.startsWith("--field=") ||
      a.startsWith("--raw-field=") ||
      a.startsWith("--input=") ||
      a.startsWith("--body-file=")
    ) {
      hasBodyFlag = true;
    }
  }
  return hasBodyFlag ? "POST" : "GET";
};

/**
 * `gh <args...>` 의 read / write / deny 분류. 알 수 없는 subcommand 는 deny.
 * `gh api` 는 `--method` flag 로 분기 — GET 은 read, 그 외 (POST/PUT/PATCH/DELETE)
 * 는 write.
 */
export const classifyGhCommand = (args: readonly string[]): GhCommandKind => {
  if (args.length === 0) return "deny";
  const head = args[0] ?? "";

  // top-level read commands (verb 없음)
  if (READ_TOPLEVEL.has(head)) return "read";

  // gh api — method 로 분기
  if (head === "api") {
    const method = apiMethod(args);
    return method === "GET" || method === "HEAD" ? "read" : "write";
  }

  const verb = args[1];
  if (!verb) return "deny"; // `gh <noun>` 만으로는 의도 불명확

  if (DENY_VERBS[head]?.has(verb)) return "deny";
  if (READ_VERBS[head]?.has(verb)) return "read";
  if (WRITE_VERBS[head]?.has(verb)) return "write";

  // 알 수 없는 조합 — 보수적으로 deny
  return "deny";
};

export interface RunGhOptions {
  /** write 호출일 때만 의미 있음. 기본 true. read 호출은 dryRun 무시 (항상 실행). */
  dryRun?: boolean;
}

export interface RunGhResult {
  args: readonly string[];
  kind: GhCommandKind;
  /** 이번 호출에서 실제로 실행됐는지. write + dryRun=true 면 false. */
  executed: boolean;
  /** plan 만 보여줄 때의 dryRun 플래그 — write 호출에서만 의미 있음. */
  dryRun: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `gh_run` plugin tool 의 백엔드. classify → 정책 적용 → 실행.
 *
 * - read: dryRun 무관 즉시 실행.
 * - write + dryRun=true (기본): 실행하지 않고 plan 형태로 surface.
 * - write + dryRun=false: 실행.
 * - deny: `GhDeniedCommandError` 로 throw.
 */
export const runGhCommand = async (
  exec: GhExecutor,
  args: readonly string[],
  options: RunGhOptions = {},
): Promise<RunGhResult> => {
  const kind = classifyGhCommand(args);
  if (kind === "deny") {
    const reason =
      args.length === 0
        ? "empty args"
        : `\`gh ${args[0] ?? ""}${args[1] ? ` ${args[1]}` : ""}\` is not in the read / write allow-list`;
    throw new GhDeniedCommandError(args, reason);
  }
  // read 는 dryRun 무관 — gate 가 의미 없음.
  const dryRun = kind === "write" ? (options.dryRun ?? true) : false;
  if (kind === "write" && dryRun) {
    return {
      args,
      kind,
      executed: false,
      dryRun: true,
      stdout: `(dry-run, not executed) gh ${args.join(" ")}`,
      stderr: "",
      exitCode: 0,
    };
  }
  const result = await exec.run(args);
  // 기존 wrapper (ghIssueCreate / ghIssueEdit / ghIssueListByLabel 등) 와 일관:
  // 비-zero exitCode 는 throw 로 surface — 호출자 / handler 가 매번 exitCode 를
  // 검사하지 않아도 된다. `applied` journal entry 가 실패한 호출에 잘못 남는
  // 문제도 함께 해결 (Codex P2).
  if (result.exitCode !== 0) {
    throw new GhCommandError(args, result.exitCode, result.stderr);
  }
  return {
    args,
    kind,
    executed: true,
    dryRun,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
};
