import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveCacheKey } from "./notion-context";

/**
 * Append-only 에이전트 저널.
 *
 * 한 turn 안에서 결정 / blocker / 사용자 답변 등 "다음 turn 에 인용하고 싶은 사실"
 * 을 디스크에 한 줄(JSONL) 씩 쌓는다. 캐시처럼 정규화된 키 / TTL 모델을 쓰지 않는
 * 이유는 — 캐시는 외부 source of truth 의 사본이지만, 저널은 그 자체가 source of
 * truth 이기 때문이다. 따라서 만료 / 무효화 / 덮어쓰기 없음.
 *
 * 디스크 레이아웃:
 *   <baseDir>/journal.jsonl   각 줄이 하나의 JournalEntry
 *
 * baseDir 기본값은 `~/.config/opencode/agent-toolkit/journal` — Notion / OpenAPI
 * 캐시와 같은 부모 아래에 두되 디렉터리는 분리한다 (`AGENT_TOOLKIT_JOURNAL_DIR`).
 *
 * 동시 쓰기:
 *   `appendFile` 는 POSIX 의 O_APPEND 로 동작해 한 줄(< PIPE_BUF) 단위 append 는
 *   원자적이다. 정상적인 항목 크기에서는 race 가 라인 경계에서만 발생한다.
 *   라인 단위 손상은 read 단계의 graceful skip 으로 흡수된다.
 */

/** 기본 저널 디렉터리 — `AGENT_TOOLKIT_JOURNAL_DIR` 로 덮어쓴다. */
export const DEFAULT_JOURNAL_DIR = join(
  homedir(),
  ".config",
  "opencode",
  "agent-toolkit",
  "journal",
);

/** 저널 파일 이름 — 한 디렉터리에 단일 파일을 둔다 (MVP). */
export const JOURNAL_FILE = "journal.jsonl";

/**
 * 항목 종류. 저널은 자유 문자열을 허용하지만 흔한 4 가지를 권장 값으로 둔다.
 * 호출자가 새 종류를 도입해도 read / search 가 자동으로 따라간다.
 */
export type JournalKind =
  | "decision"
  | "blocker"
  | "answer"
  | "note"
  | (string & {});

/**
 * 저널 한 줄.
 * - `id`: timestamp + 6 hex — 같은 ms 안에 두 번 append 해도 충돌 안 나게.
 * - `timestamp`: append 시각 ISO8601 (UTC).
 * - `pageId`: 옵셔널 Notion page id 연결고리. 입력은 URL/dash-less 모두 허용하되
 *   디스크에는 정규화된 dash 형식(`8-4-4-4-12`)으로 저장 — page-key 기반 lookup 의 키.
 */
export interface JournalEntry {
  id: string;
  timestamp: string;
  kind: JournalKind;
  content: string;
  tags: string[];
  pageId?: string;
}

export interface JournalAppendInput {
  content: string;
  kind?: JournalKind;
  tags?: string[];
  pageId?: string;
}

/**
 * read 필터. 모두 옵셔널 — 다 비우면 가장 최근 `limit` (기본 20) 개를 반환.
 * `since` 는 ISO8601 또는 `Date.parse` 가 받아들이는 형식이면 된다 — 비교는 ms 단위.
 */
export interface JournalReadOptions {
  limit?: number;
  kind?: string;
  tag?: string;
  pageId?: string;
  since?: string;
}

export interface JournalSearchOptions {
  limit?: number;
  kind?: string;
}

export interface JournalStatus {
  path: string;
  exists: boolean;
  totalEntries: number;
  sizeBytes: number;
  lastEntryAt?: string;
}

export interface AgentJournalOptions {
  baseDir?: string;
}

const DEFAULT_LIMIT = 20;

/**
 * 파일시스템 기반 append-only 저널.
 *
 * 외부에 노출되는 메서드는 append / read / search / status 4 가지.
 * 모든 read 경로는 손상된 라인을 건너뛰고 graceful 하게 동작한다 — 부분 쓰기가
 * 직전 turn 끝에 있어도 다음 turn 에서 나머지를 읽을 수 있다.
 */
export class AgentJournal {
  private readonly dir: string;
  private readonly file: string;

  constructor(options: AgentJournalOptions = {}) {
    this.dir = resolve(options.baseDir ?? DEFAULT_JOURNAL_DIR);
    this.file = join(this.dir, JOURNAL_FILE);
  }

  getDir(): string {
    return this.dir;
  }

  getPath(): string {
    return this.file;
  }

  /**
   * 저널에 한 줄 append.
   *
   * `content` 는 trim 후 비어 있으면 throw — 의미 없는 빈 줄 방지.
   * `pageId` 가 들어오면 `resolveCacheKey` 로 정규화 후 저장 → 입력이 URL 이든
   * dash-less hex 든 같은 키로 묶인다.
   */
  async append(input: JournalAppendInput): Promise<JournalEntry> {
    if (!input || typeof input !== "object") {
      throw new Error("AgentJournal.append: input must be an object");
    }
    const rawContent = typeof input.content === "string" ? input.content : "";
    const content = rawContent.trim();
    if (!content) {
      throw new Error(
        "AgentJournal.append: content must be a non-empty string after trim",
      );
    }
    const kind =
      typeof input.kind === "string" && input.kind.trim().length > 0
        ? input.kind.trim()
        : "note";
    const tags = Array.isArray(input.tags)
      ? input.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];
    let pageId: string | undefined;
    if (typeof input.pageId === "string" && input.pageId.trim().length > 0) {
      pageId = resolveCacheKey(input.pageId).pageId;
    }
    const entry: JournalEntry = {
      id: `${Date.now()}-${randomBytes(3).toString("hex")}`,
      timestamp: new Date().toISOString(),
      kind,
      content,
      tags,
      ...(pageId ? { pageId } : {}),
    };
    await mkdir(this.dir, { recursive: true });
    // 한 줄 = 한 entry. JSON 안에 줄바꿈이 들어가지 않도록 stringify default 를 쓴다.
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /**
   * 가장 최근 항목부터 `limit` 개를 반환. 필터는 AND 결합.
   *
   * - `kind`: 정확 일치
   * - `tag`: 태그 배열 안에 포함되어야 함 (정확 일치)
   * - `pageId`: `resolveCacheKey` 로 정규화 후 정확 일치
   * - `since`: 해당 시각 *이후* 항목만 (Date.parse 실패 시 필터 무시)
   */
  async read(options: JournalReadOptions = {}): Promise<JournalEntry[]> {
    const all = await this.readAll();
    let filtered: JournalEntry[] = all;
    if (typeof options.kind === "string" && options.kind.length > 0) {
      const k = options.kind;
      filtered = filtered.filter((e) => e.kind === k);
    }
    if (typeof options.tag === "string" && options.tag.length > 0) {
      const t = options.tag;
      filtered = filtered.filter((e) => e.tags.includes(t));
    }
    if (typeof options.pageId === "string" && options.pageId.length > 0) {
      const pid = resolveCacheKey(options.pageId).pageId;
      filtered = filtered.filter((e) => e.pageId === pid);
    }
    if (typeof options.since === "string" && options.since.length > 0) {
      const sinceMs = Date.parse(options.since);
      if (Number.isFinite(sinceMs)) {
        filtered = filtered.filter((e) => {
          const ms = Date.parse(e.timestamp);
          return Number.isFinite(ms) && ms > sinceMs;
        });
      }
    }
    // 가장 최근 항목이 앞에 오도록.
    const reversed = [...filtered].reverse();
    const cap = capOrDefault(options.limit);
    return reversed.slice(0, cap);
  }

  /**
   * substring 검색 (case-insensitive). 매칭 대상: `content` / `kind` / `tags` / `pageId`.
   * 빈 query 는 전체 (kind 필터만 적용) 를 가장 최근부터 반환 — `read` 와 같은 동작.
   */
  async search(
    query: string,
    options: JournalSearchOptions = {},
  ): Promise<JournalEntry[]> {
    const all = await this.readAll();
    const needle = (typeof query === "string" ? query : "").trim().toLowerCase();
    let pool: JournalEntry[] = all;
    if (typeof options.kind === "string" && options.kind.length > 0) {
      const k = options.kind;
      pool = pool.filter((e) => e.kind === k);
    }
    const matches =
      needle.length === 0
        ? pool
        : pool.filter((e) => entryMatchesNeedle(e, needle));
    const reversed = [...matches].reverse();
    const cap = capOrDefault(options.limit);
    return reversed.slice(0, cap);
  }

  /**
   * 저널 메타 (파일 존재, 라인 수, 바이트 크기, 마지막 항목 시각).
   * 디스크 IO 는 file stat + 전체 read — 항목 수가 폭증하면 최적화 대상이 되겠지만,
   * MVP 의 사용 패턴(turn 단위 한두 줄 추가) 에서는 충분.
   */
  async status(): Promise<JournalStatus> {
    if (!existsSync(this.file)) {
      return { path: this.file, exists: false, totalEntries: 0, sizeBytes: 0 };
    }
    let sizeBytes = 0;
    try {
      const s = await stat(this.file);
      sizeBytes = s.size;
    } catch {
      // stat 가 깨져도 read 자체는 시도 — 부분 정보라도 surface.
    }
    const all = await this.readAll();
    const last = all[all.length - 1];
    return {
      path: this.file,
      exists: true,
      totalEntries: all.length,
      sizeBytes,
      lastEntryAt: last?.timestamp,
    };
  }

  /**
   * 모든 valid entry 를 append 순(시간 오름차순) 으로 반환.
   * 손상 / 부분 쓰기 라인은 건너뛴다 — 호출자가 throw 를 받지 않게.
   */
  private async readAll(): Promise<JournalEntry[]> {
    if (!existsSync(this.file)) return [];
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    if (!raw) return [];
    const out: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const entry = normalizeEntry(parsed);
      if (entry) out.push(entry);
    }
    return out;
  }
}

function capOrDefault(limit: unknown): number {
  if (typeof limit !== "number") return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.floor(limit);
}

function entryMatchesNeedle(entry: JournalEntry, needle: string): boolean {
  if (entry.content.toLowerCase().includes(needle)) return true;
  if (entry.kind.toLowerCase().includes(needle)) return true;
  if (entry.pageId && entry.pageId.toLowerCase().includes(needle)) return true;
  for (const t of entry.tags) {
    if (t.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * raw JSON 한 줄을 JournalEntry 로 정규화. 필수 필드가 비어 있으면 null —
 * read 단에서 그대로 skip 된다.
 */
function normalizeEntry(value: unknown): JournalEntry | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return null;
  if (typeof o.timestamp !== "string" || o.timestamp.length === 0) return null;
  if (typeof o.kind !== "string" || o.kind.length === 0) return null;
  if (typeof o.content !== "string") return null;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string")
    : [];
  const pageId =
    typeof o.pageId === "string" && o.pageId.length > 0 ? o.pageId : undefined;
  return {
    id: o.id,
    timestamp: o.timestamp,
    kind: o.kind,
    content: o.content,
    tags,
    ...(pageId ? { pageId } : {}),
  };
}

/** env 변수에서 baseDir 을 읽어 인스턴스 생성. */
export function createJournalFromEnv(): AgentJournal {
  const baseDir = process.env.AGENT_TOOLKIT_JOURNAL_DIR;
  return new AgentJournal({ baseDir });
}
