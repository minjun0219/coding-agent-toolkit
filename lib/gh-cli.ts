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

/**
 * 라벨로 좁혀서 issue 목록을 가져온다 — dedupe 검색의 1차 필터. `gh` 의 `labels`
 * 필드가 버전별로 `string[]` 또는 `{name:string}[]` 이라 여기서 정규화한다.
 */
export const ghIssueListByLabel = async (
  exec: GhExecutor,
  repo: string,
  label: string,
  state: "open" | "closed" | "all" = "all",
): Promise<GhIssueListItem[]> => {
  const result = await exec.run([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    state,
    "--limit",
    "500",
    "--json",
    "number,title,body,url,labels",
  ]);
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
