import type { JournalAppendInput, JournalEntry } from "./agent-journal";

/**
 * GitHub PR review watch 의 핸들 / 이벤트 / journal reduce 계층.
 *
 * agent-toolkit 의 source-of-truth 모델:
 *   - GitHub: PR / 코멘트 / 머지 본체. 토킷이 직접 호출하지 않는다 (외부 GitHub MCP 의 책임).
 *   - 외부 MCP payload: passthrough. 토킷은 가공만.
 *   - `journal.jsonl`: 토킷이 결정한 watch 상태 / 이벤트 처리 이력. **이 한 곳이 토킷의 유일한 SoT.**
 *
 * 이 모듈은 GitHub 네트워크를 두드리지 않는다 (의존성 / 비밀 0). agent-journal.ts 위에
 * pure reducer + 정규화 함수만 얹는다 — append 자체는 caller (플러그인 핸들러) 가
 * `AgentJournal.append` 로 직접 한다.
 *
 * journal kind 4 종 (reserved):
 *   - `pr_watch_start`    PR watch 등록 (수동 / SPEC drift / 외부 트리거 무관)
 *   - `pr_watch_stop`     watch 해제 (머지 / 닫힘 / 수동)
 *   - `pr_event_inbound`  외부 MCP 가 가져온 코멘트·리뷰·체크·머지 신호 1 건
 *   - `pr_event_resolved` mindy 의 검증 결과 (accepted / rejected / deferred) + reply commentId
 *
 * 모든 entry 는 메인 태그 `"pr-watch"` + 모드 태그 (`"start" | "stop" | "inbound" | "resolved"`)
 * + handle 태그 (`"pr:owner/repo#123"`) 를 0~2번째 인덱스로 박는다 — `journal_search "pr-watch"`
 * 한 방으로 lifecycle 회수.
 *
 * `JournalEntry.pageId` 슬롯은 사용하지 않는다. resolveCacheKey 가 Notion 8-4-4-4-12 만
 * 받기 때문에 PR handle 을 넣을 수 없다. handle 은 항상 tag (`"pr:..."`) 로만 표현된다.
 */

// ── PR handle ─────────────────────────────────────────────────────────────

/** 정규화된 PR 핸들. */
export interface PrHandle {
  /** `owner/repo` — 슬래시 정확히 1 개. */
  repo: string;
  /** PR 번호 (양의 정수). */
  number: number;
  /** journal / display 용 canonical 표현. 예: `minjun0219/agent-toolkit#42`. */
  canonical: string;
}

/**
 * GitHub `owner/repo` 키 패턴.
 * 슬래시 정확히 1 개 + 양쪽은 `[a-zA-Z0-9_.-]` 본문 (실제 GitHub 규칙과 근사).
 *
 * `agent-toolkit.json` 의 다른 host:env:spec / host:env:db 식별자 패턴 (`ID_BODY`,
 * 슬래시 미허용) 과 의도적으로 분리한다 — repo 키는 슬래시가 본질이고, 다른 핸들의
 * 콜론 separator 와 혼동되지 않으려고 정규식을 따로 둔다.
 */
export const REPO_BODY = "[a-zA-Z0-9_.-]+";
export const REPO_PATTERN = new RegExp(`^${REPO_BODY}\\/${REPO_BODY}$`);

/**
 * `owner/repo#NUMBER` / GitHub PR URL / canonical 을 모두 받아 정규화한다.
 *
 * 받는 형태:
 *   - `owner/repo#123`
 *   - `https://github.com/owner/repo/pull/123` (?... fragment 무시)
 *   - `http://github.com/owner/repo/pull/123`
 *   - `github.com/owner/repo/pull/123` (스킴 생략)
 *
 * 거부:
 *   - 슬래시 갯수 ≠ 1, 비어있는 입력, number 가 정수 아님 / ≤ 0, repo 패턴 미충족.
 *
 * 의도적으로 enterprise GitHub host (api.github.com 외) 는 *지원하지 않는다* — agent-toolkit.json
 * 의 `github.repositories` 키도 owner/repo 만이고, host 변경은 외부 MCP 의 책임이다.
 */
export function parsePrHandle(input: string): PrHandle {
  if (typeof input !== "string") {
    throw new Error(
      `parsePrHandle: input must be a string (got ${typeof input})`,
    );
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("parsePrHandle: input must be a non-empty string");
  }
  // 1) URL 모드 — 슬래시가 두 개 이상이라 짧은 형태와 충돌하지 않는다.
  const urlMatch =
    /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
      trimmed,
    );
  if (urlMatch) {
    const [, owner, repo, num] = urlMatch as unknown as [
      string,
      string,
      string,
      string,
    ];
    return buildHandle(owner, repo, num, trimmed);
  }
  // 2) `owner/repo#NUMBER` 모드.
  const shortMatch = /^([^#\s]+)\/([^#\s]+)#(\d+)$/.exec(trimmed);
  if (shortMatch) {
    const [, owner, repo, num] = shortMatch as unknown as [
      string,
      string,
      string,
      string,
    ];
    return buildHandle(owner, repo, num, trimmed);
  }
  throw new Error(
    `parsePrHandle: cannot parse "${input}" — expected "owner/repo#123" or a https://github.com/owner/repo/pull/123 URL`,
  );
}

function buildHandle(
  owner: string,
  repo: string,
  numRaw: string,
  original: string,
): PrHandle {
  const repoKey = `${owner}/${repo}`;
  if (!REPO_PATTERN.test(repoKey)) {
    throw new Error(
      `parsePrHandle: "${repoKey}" does not match ${REPO_PATTERN} (allowed body: alphanumeric, "_", ".", "-")`,
    );
  }
  const number = Number.parseInt(numRaw, 10);
  if (
    !Number.isFinite(number) ||
    !Number.isInteger(number) ||
    number <= 0 ||
    String(number) !== numRaw
  ) {
    throw new Error(
      `parsePrHandle: PR number must be a positive integer — got "${numRaw}" from "${original}"`,
    );
  }
  return { repo: repoKey, number, canonical: `${repoKey}#${number}` };
}

/** PR 핸들의 canonical 표현 — `owner/repo#NUMBER`. */
export function formatPrHandle(h: PrHandle): string {
  return h.canonical;
}

/** PR 핸들 → journal tag 표현. `pr:owner/repo#123`. */
export function handleTag(h: PrHandle): string {
  return `pr:${h.canonical}`;
}

// ── Event ref ─────────────────────────────────────────────────────────────

/**
 * 외부 GitHub MCP 가 가져오는 이벤트 종류. unknown 종류는 normalizeEventRef 가 throw
 * (silent skip 하지 않는다 — 미지원 이벤트가 들어오면 caller 가 명시적으로 인지해야).
 */
export type PrEventType =
  | "issue_comment"
  | "pr_review"
  | "pr_review_comment"
  | "check_run"
  | "status"
  | "merge"
  | "close";

/** 모든 PR 이벤트 종류 — switch / 검증에서 재사용. */
export const PR_EVENT_TYPES: readonly PrEventType[] = [
  "issue_comment",
  "pr_review",
  "pr_review_comment",
  "check_run",
  "status",
  "merge",
  "close",
];

/** 외부 MCP 의 raw 이벤트 → 토킷 측 정규화 reference. */
export interface PrEventRef {
  type: PrEventType;
  /** 외부 MCP 의 numeric / sha / timestamp id — caller 가 가져온 그대로. */
  externalId: string;
  /** 토킷 측 idempotency 키. journal tag `evt:<toolkitKey>` 에 박힌다. */
  toolkitKey: string;
}

/**
 * 외부 MCP raw payload → toolkit reference 정규화.
 *
 * toolkitKey 합성 정책 (hash 없이 type-prefix + externalId):
 *   - issue_comment       → `c:<id>`
 *   - pr_review           → `r:<id>`
 *   - pr_review_comment   → `rc:<id>`
 *   - check_run           → `chk:<id>`
 *   - status              → `st:<id>`
 *   - merge               → `m:<sha>`
 *   - close               → `cl:<ts>`
 *
 * externalId 는 trim 후 비어 있으면 throw. type 이 미지원이면 throw — caller 가 외부 MCP
 * payload 의 type 을 직접 만지지 않도록 가드.
 */
export function normalizeEventRef(
  type: string,
  externalId: string,
): PrEventRef {
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new Error(
      "normalizeEventRef: type must be a non-empty string (one of issue_comment / pr_review / pr_review_comment / check_run / status / merge / close)",
    );
  }
  const t = type.trim() as PrEventType;
  if (!PR_EVENT_TYPES.includes(t)) {
    throw new Error(
      `normalizeEventRef: unsupported type "${type}" — allowed: ${PR_EVENT_TYPES.join(", ")}`,
    );
  }
  if (typeof externalId !== "string" || externalId.trim().length === 0) {
    throw new Error(
      `normalizeEventRef: externalId must be a non-empty string for type "${t}"`,
    );
  }
  const id = externalId.trim();
  const prefix = TYPE_PREFIX[t];
  return { type: t, externalId: id, toolkitKey: `${prefix}:${id}` };
}

const TYPE_PREFIX: Record<PrEventType, string> = {
  issue_comment: "c",
  pr_review: "r",
  pr_review_comment: "rc",
  check_run: "chk",
  status: "st",
  merge: "m",
  close: "cl",
};

/** evt 태그 표현 — `evt:<toolkitKey>`. */
export function eventTag(ref: PrEventRef): string {
  return `evt:${ref.toolkitKey}`;
}

// ── Reduce: watch state ───────────────────────────────────────────────────

export interface PrWatchState {
  handle: PrHandle;
  /** 마지막 start / stop 비교 결과 — start 가 더 최신이거나 같으면 active. */
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  /** 마지막 start entry 의 note (옵셔널). */
  note?: string;
}

/**
 * 모든 active watch 를 한 번에 reduce. journal 한 번 훑어 handle 별 마지막 start/stop 비교.
 *
 * - 같은 handle 에 start 가 두 번 들어오면 (정상적인 polling 환경에서는 일어나지 않지만)
 *   reducer 는 "마지막 start" 를 active 의 시점으로 본다.
 * - stop 후 다시 start 가 들어오면 (재개) active 로 본다 — append-only 에선 정상 흐름.
 */
export function reduceActiveWatches(entries: JournalEntry[]): PrWatchState[] {
  const map = new Map<string, PrWatchState>();
  for (const e of entries) {
    if (e.kind !== "pr_watch_start" && e.kind !== "pr_watch_stop") continue;
    const handle = handleFromTags(e.tags);
    if (!handle) continue;
    const cur =
      map.get(handle.canonical) ??
      ({ handle, active: false } satisfies PrWatchState);
    if (e.kind === "pr_watch_start") {
      cur.active = true;
      cur.startedAt = e.timestamp;
      cur.note = startNoteFromContent(e.content);
      // 재개의 경우 stoppedAt 는 그대로 두지 않는다 — caller 가 "active 인데 stoppedAt 가 있는"
      // 모순된 view 를 보지 않게.
      cur.stoppedAt = undefined;
    } else {
      cur.active = false;
      cur.stoppedAt = e.timestamp;
    }
    map.set(handle.canonical, cur);
  }
  return [...map.values()].filter((s) => s.active);
}

/**
 * tags 배열에서 `pr:<canonical>` 를 찾아 PrHandle 로 복원. 없거나 잘못된 형식이면 null —
 * reducer 단에서 silent skip 한다 (사용자가 수동으로 박은 entry 도 포함 가능).
 */
function handleFromTags(tags: string[]): PrHandle | null {
  for (const t of tags) {
    if (t.startsWith("pr:")) {
      try {
        return parsePrHandle(t.slice(3));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * `pr_watch_start` content 에서 사용자 note 부분만 뽑아낸다.
 * `buildAppend` 가 만드는 형식은 `<canonical> watch started — <note>` 또는 `<canonical> watch started`.
 * note 가 없으면 undefined.
 */
function startNoteFromContent(content: string): string | undefined {
  const idx = content.indexOf(" — ");
  if (idx < 0) return undefined;
  const note = content.slice(idx + 3).trim();
  return note.length > 0 ? note : undefined;
}

// ── Reduce: pending events ────────────────────────────────────────────────

export interface PendingPrEvent {
  handle: PrHandle;
  ref: PrEventRef;
  /** inbound 시각. */
  receivedAt: string;
  /** inbound 시 caller 가 박은 한 줄 요약 (예: "user bob: typo on /api/orders"). */
  summary: string;
  /** 원본 inbound entry id — caller 가 다시 인용할 때. */
  inboundEntryId: string;
}

/**
 * 한 handle 의 미처리 이벤트 목록을 시간 오름차순으로 반환.
 *
 * 정의:
 *   - inbound 가 있고
 *   - 같은 toolkitKey 의 resolved 가 *없는* 것
 *
 * polling 정의상 같은 코멘트가 두 번 들어올 수 있다 — toolkitKey 가 중복되면 *첫 번째* inbound
 * 만 surface (Set dedupe). caller (`pr_event_record` 핸들러) 가 alreadySeen 을 보고 처리 안 함.
 */
export function reducePendingEvents(
  handle: PrHandle,
  entries: JournalEntry[],
): PendingPrEvent[] {
  const handleKey = handle.canonical;
  const resolvedKeys = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "pr_event_resolved") continue;
    if (handleFromTags(e.tags)?.canonical !== handleKey) continue;
    const tk = toolkitKeyFromTags(e.tags);
    if (tk) resolvedKeys.add(tk);
  }
  const seen = new Set<string>();
  const out: PendingPrEvent[] = [];
  for (const e of entries) {
    if (e.kind !== "pr_event_inbound") continue;
    if (handleFromTags(e.tags)?.canonical !== handleKey) continue;
    const tk = toolkitKeyFromTags(e.tags);
    const t = eventTypeFromTags(e.tags);
    if (!tk || !t) continue;
    if (resolvedKeys.has(tk)) continue;
    if (seen.has(tk)) continue;
    seen.add(tk);
    const ref = makeRefFromTagPair(t, tk);
    if (!ref) continue;
    out.push({
      handle,
      ref,
      receivedAt: e.timestamp,
      summary: inboundSummaryFromContent(e.content),
      inboundEntryId: e.id,
    });
  }
  return out;
}

function toolkitKeyFromTags(tags: string[]): string | null {
  for (const t of tags) if (t.startsWith("evt:")) return t.slice(4);
  return null;
}

function eventTypeFromTags(tags: string[]): PrEventType | null {
  for (const t of tags) {
    if (t.startsWith("type:")) {
      const candidate = t.slice(5) as PrEventType;
      if (PR_EVENT_TYPES.includes(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * `<type>:<id>` 형식의 toolkitKey 와 type 으로 PrEventRef 복원. type 이 안 맞으면 null —
 * 예: `c:42` 인데 type 태그가 `pr_review` 라면 손상된 entry 로 간주.
 */
function makeRefFromTagPair(
  type: PrEventType,
  toolkitKey: string,
): PrEventRef | null {
  const expectedPrefix = TYPE_PREFIX[type];
  const colon = toolkitKey.indexOf(":");
  if (colon < 0) return null;
  const prefix = toolkitKey.slice(0, colon);
  const externalId = toolkitKey.slice(colon + 1);
  if (prefix !== expectedPrefix || externalId.length === 0) return null;
  return { type, externalId, toolkitKey };
}

function inboundSummaryFromContent(content: string): string {
  const idx = content.indexOf(" — ");
  return idx < 0 ? content : content.slice(idx + 3);
}

// ── Select: handle slice ──────────────────────────────────────────────────

/**
 * 한 handle 의 모든 lifecycle entry (`pr_watch_start` / `pr_watch_stop` / `pr_event_inbound`
 * / `pr_event_resolved`) 를 시간 오름차순. 다른 PR 의 entry 는 제거.
 */
export function selectByHandle(
  handle: PrHandle,
  entries: JournalEntry[],
): JournalEntry[] {
  const handleKey = handle.canonical;
  return entries.filter((e) => {
    if (
      e.kind !== "pr_watch_start" &&
      e.kind !== "pr_watch_stop" &&
      e.kind !== "pr_event_inbound" &&
      e.kind !== "pr_event_resolved"
    ) {
      return false;
    }
    return handleFromTags(e.tags)?.canonical === handleKey;
  });
}

// ── Build append inputs ───────────────────────────────────────────────────

export type ResolveDecision = "accepted" | "rejected" | "deferred";

export const RESOLVE_DECISIONS: readonly ResolveDecision[] = [
  "accepted",
  "rejected",
  "deferred",
];

export interface BuildWatchStartInput {
  handle: PrHandle;
  note?: string;
  /** allow-list label (등록된 레이블만 권고 — strict 가드는 외부 MCP 책임). */
  labels?: string[];
  /** 머지 모드 권고 — `merge` / `squash` / `rebase`. 실제 머지는 외부 MCP. */
  mergeMode?: string;
}

export interface BuildWatchStopInput {
  handle: PrHandle;
  /** `merged` / `closed` / `manual` 등 자유 문자열. */
  reason?: string;
}

export interface BuildEventInboundInput {
  handle: PrHandle;
  ref: PrEventRef;
  /** 외부 MCP 응답을 직접 박지 않고 — caller 가 한 줄 요약으로 정제해 넘긴다. */
  summary: string;
}

export interface BuildEventResolvedInput {
  handle: PrHandle;
  ref: PrEventRef;
  decision: ResolveDecision;
  reasoning: string;
  /** 외부 MCP 로 작성한 reply commentId (있으면). */
  replyExternalId?: string;
}

export type BuildAppend =
  | { kind: "pr_watch_start"; data: BuildWatchStartInput }
  | { kind: "pr_watch_stop"; data: BuildWatchStopInput }
  | { kind: "pr_event_inbound"; data: BuildEventInboundInput }
  | { kind: "pr_event_resolved"; data: BuildEventResolvedInput };

/**
 * 4 종 lifecycle event 를 `JournalAppendInput` 으로 표준화.
 *
 * tag 순서는 항상:
 *   `[메인, 모드, 핸들, 추가...]` — `journal_search "pr-watch"` 한 방으로 lifecycle 회수.
 *
 * 메인 태그 = `"pr-watch"`, 모드 태그 = `"start" | "stop" | "inbound" | "resolved"`.
 * pageId 슬롯은 사용하지 않는다 (Notion id 패턴이 아니므로).
 */
export function buildAppend(input: BuildAppend): JournalAppendInput {
  if (input.kind === "pr_watch_start") {
    const { handle, note, labels, mergeMode } = input.data;
    const tags: string[] = ["pr-watch", "start", handleTag(handle)];
    for (const l of labels ?? []) {
      const trimmed = l.trim();
      if (trimmed.length > 0) tags.push(`label:${trimmed}`);
    }
    if (mergeMode && mergeMode.trim().length > 0) {
      tags.push(`mergeMode:${mergeMode.trim()}`);
    }
    const noteTrim = note?.trim();
    const content = noteTrim
      ? `${handle.canonical} watch started — ${noteTrim}`
      : `${handle.canonical} watch started`;
    return { content, kind: "pr_watch_start", tags };
  }
  if (input.kind === "pr_watch_stop") {
    const { handle, reason } = input.data;
    const tags: string[] = ["pr-watch", "stop", handleTag(handle)];
    const reasonTrim = reason?.trim();
    if (reasonTrim && reasonTrim.length > 0) tags.push(`reason:${reasonTrim}`);
    const content = reasonTrim
      ? `${handle.canonical} watch stopped — ${reasonTrim}`
      : `${handle.canonical} watch stopped`;
    return { content, kind: "pr_watch_stop", tags };
  }
  if (input.kind === "pr_event_inbound") {
    const { handle, ref, summary } = input.data;
    const summaryTrim =
      typeof summary === "string" && summary.trim().length > 0
        ? summary.trim()
        : "(no summary)";
    const tags = [
      "pr-watch",
      "inbound",
      handleTag(handle),
      eventTag(ref),
      `type:${ref.type}`,
    ];
    return {
      content: `${handle.canonical} ${ref.type} received — ${summaryTrim}`,
      kind: "pr_event_inbound",
      tags,
    };
  }
  // pr_event_resolved
  const { handle, ref, decision, reasoning, replyExternalId } = input.data;
  if (!RESOLVE_DECISIONS.includes(decision)) {
    throw new Error(
      `buildAppend: decision must be one of ${RESOLVE_DECISIONS.join(", ")} — got "${decision}"`,
    );
  }
  const reasoningTrim =
    typeof reasoning === "string" && reasoning.trim().length > 0
      ? reasoning.trim()
      : "(no reasoning)";
  const tags = [
    "pr-watch",
    "resolved",
    handleTag(handle),
    eventTag(ref),
    `type:${ref.type}`,
    `decision:${decision}`,
  ];
  if (replyExternalId && replyExternalId.trim().length > 0) {
    tags.push(`reply:${replyExternalId.trim()}`);
  }
  return {
    content: `${handle.canonical} ${ref.type} ${decision} — ${reasoningTrim}`,
    kind: "pr_event_resolved",
    tags,
  };
}
