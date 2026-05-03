/**
 * Phase 2 — 잠긴 SPEC → GitHub epic + sub-issue 시리즈 idempotent sync.
 *
 * 핵심 원리:
 *  1. 한 SPEC = 한 epic, `# 합의 TODO` flat bullet 1 개 = 한 sub-issue.
 *  2. dedupe 는 issue body 안의 marker (HTML comment) substring 매칭으로만.
 *     제목으로 매칭하지 않는다 — 사람이 제목을 바꿔도 같은 marker 면 같은 issue.
 *  3. dryRun=true 면 plan 만 산출하고 `gh` 호출은 list 한 번만 (이미 발생).
 *  4. apply 순서: missing sub 들을 먼저 만들고, 그 결과로 epic body 의 task list
 *     를 `- [ ] #<n> <title>` 로 다시 렌더링한 뒤 epic 을 만들거나 patch.
 *
 * `GhExecutor` 는 주입식이므로 이 모듈은 fetch 도, 실제 `gh` 도 직접 호출하지
 * 않는다 — 모든 호출은 `lib/gh-cli.ts` 의 wrapper 를 거친다.
 */

import {
  type GhExecutor,
  type GhIssueListItem,
  type GhIssueRef,
  ghIssueCreate,
  ghIssueEdit,
  ghIssueListByLabel,
} from "./gh-cli";

// ── Markers ──────────────────────────────────────────────────────────────────

/** epic 이라는 사실을 issue body 에 박아두는 invisible marker. */
export const epicMarker = (slug: string): string =>
  `<!-- spec-pact:slug=${slug}:kind=epic -->`;

/** index 번호까지 포함한 sub-issue marker. index 는 1-based bullet 순서. */
export const subMarker = (slug: string, index: number): string =>
  `<!-- spec-pact:slug=${slug}:kind=sub:index=${index} -->`;

/** parse-only — 기존 issue body 에서 marker 를 식별. */
export const MARKER_RE =
  /<!--\s*spec-pact:slug=([A-Za-z0-9_-]+):kind=(epic|sub)(?::index=(\d+))?\s*-->/;

// ── SPEC parsing ─────────────────────────────────────────────────────────────

/** 잠긴 SPEC frontmatter — 우리가 sync 에 필요한 키만 strict 로 본다. */
export interface SpecFrontmatter {
  slug: string;
  status: "locked" | "drifted" | "verified";
  source_url?: string;
  source_page_id?: string;
  agreed_at?: string;
  spec_pact_version?: number;
  /** passthrough — 나머지 키는 보존. */
  [key: string]: unknown;
}

export interface ParsedSpec {
  path: string;
  frontmatter: SpecFrontmatter;
  body: string;
  /** `# 합의 TODO` 섹션의 flat top-level bullet 들. trimmed, marker 제거 X. */
  bullets: string[];
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * SPEC 파일을 파싱한다. status 가 `locked` 가 아니면 throw — sync 는 잠긴 SPEC
 * 만 한다 (drift 중 / verify 중인 SPEC 은 issue 와 동기화하면 안 됨).
 */
export const parseSpecFile = (absPath: string, raw: string): ParsedSpec => {
  const match = raw.match(FRONTMATTER_RE);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `parseSpecFile: ${absPath} has no YAML frontmatter (expected leading "---").`,
    );
  }
  const frontmatter = parseFrontmatter(match[1], absPath);
  const body = match[2];
  if (!frontmatter.slug) {
    throw new Error(`parseSpecFile: ${absPath} frontmatter missing \`slug\`.`);
  }
  if (frontmatter.status !== "locked") {
    throw new Error(
      `parseSpecFile: ${absPath} status=${frontmatter.status}, refusing to sync — only \`locked\` SPECs sync to GitHub.`,
    );
  }
  const bullets = extractAgreedTodoBullets(body);
  if (bullets.length === 0) {
    throw new Error(
      `parseSpecFile: ${absPath} has no flat bullets under \`# 합의 TODO\`.`,
    );
  }
  return { path: absPath, frontmatter, body, bullets };
};

const parseFrontmatter = (yaml: string, absPath: string): SpecFrontmatter => {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: unknown = trimmed.slice(colon + 1).trim();
    if (typeof value === "string") {
      // strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else if (/^-?\d+$/.test(value)) {
        value = Number(value);
      } else if (value.startsWith("[")) {
        // intentionally do not parse arrays — sync only needs scalar keys
      }
    }
    out[key] = value;
  }
  if (typeof out.slug !== "string") {
    throw new Error(
      `parseSpecFile: ${absPath} frontmatter \`slug\` must be a string.`,
    );
  }
  if (
    out.status !== "locked" &&
    out.status !== "drifted" &&
    out.status !== "verified"
  ) {
    throw new Error(
      `parseSpecFile: ${absPath} frontmatter \`status\` must be one of locked/drifted/verified, got ${JSON.stringify(out.status)}.`,
    );
  }
  return out as SpecFrontmatter;
};

const AGREED_TODO_HEADING_RE = /^#\s+합의\s+TODO\s*$/m;

/**
 * `# 합의 TODO` 섹션의 top-level bullet 만 추출. nested bullet 은 무시.
 * spec-pact/draft.md 의 contract 가 "1 bullet = 1 작업 단위" 라 nested 는 의미상
 * sub-issue 가 아니다.
 */
export const extractAgreedTodoBullets = (body: string): string[] => {
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((line) =>
    AGREED_TODO_HEADING_RE.test(line),
  );
  if (headingIdx < 0) return [];
  const bullets: string[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#\s/.test(line)) break; // next H1 ends the section
    const m = line.match(/^- (.+?)\s*$/);
    if (m?.[1]) {
      bullets.push(m[1]);
    }
    // nested ("  - ..." or "  *") and other lines are skipped
  }
  return bullets;
};

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlanSubItem {
  /** 1-based bullet position in `# 합의 TODO`. */
  index: number;
  title: string;
  body: string;
  /** matched existing issue (by marker substring), if any. */
  existing?: { number: number; url: string };
}

export interface PlanEpic {
  title: string;
  body: string;
  existing?: { number: number; url: string };
}

export interface SyncPlan {
  repo: string;
  slug: string;
  dedupeLabel: string;
  labels: string[];
  epic: PlanEpic;
  subs: PlanSubItem[];
  toCreate: { epic: boolean; subs: number[] };
  /** epic body 가 현재 issue 의 body 와 다를 때 true. */
  toPatchEpicBody: boolean;
  /** SPEC 에서 사라진 bullet 들의 sub index — close 하지 않고 surface 만. */
  orphans: number[];
}

/**
 * 현재 SPEC + 이미 존재하는 issue 목록 → idempotent plan.
 *
 * `existing` 은 dedupeLabel 로 좁혀서 가져온 list (open + closed 포함).
 * 같은 marker 가 여러 issue 에 있으면 가장 작은 number 를 선택.
 */
export const buildSyncPlan = (
  spec: ParsedSpec,
  repo: string,
  dedupeLabel: string,
  labels: string[],
  existing: GhIssueListItem[],
): SyncPlan => {
  const slug = spec.frontmatter.slug;

  // index existing by marker
  const epicExisting: { number: number; url: string }[] = [];
  const subExisting = new Map<number, { number: number; url: string }>();
  const seenSubIndices = new Set<number>();

  for (const issue of existing) {
    const m = issue.body.match(MARKER_RE);
    if (!m || m[1] !== slug) continue;
    if (m[2] === "epic") {
      epicExisting.push({ number: issue.number, url: issue.url });
    } else if (m[2] === "sub" && m[3]) {
      const idx = Number(m[3]);
      if (!Number.isFinite(idx)) continue;
      seenSubIndices.add(idx);
      const prev = subExisting.get(idx);
      if (!prev || issue.number < prev.number) {
        subExisting.set(idx, { number: issue.number, url: issue.url });
      }
    }
  }
  // smallest epic number wins
  epicExisting.sort((a, b) => a.number - b.number);
  const epicMatch = epicExisting[0];

  // build sub plan items first
  const subs: PlanSubItem[] = spec.bullets.map((bullet, i) => {
    const index = i + 1;
    return {
      index,
      title: renderSubTitle(slug, bullet),
      body: renderSubBody(spec, index, bullet),
      existing: subExisting.get(index),
    };
  });

  // epic body uses sub numbers when known; for to-be-created subs, leaves number blank
  const epic: PlanEpic = {
    title: renderEpicTitle(spec),
    body: renderEpicBody(spec, subs),
    existing: epicMatch,
  };

  const toCreateSubs = subs.filter((s) => !s.existing).map((s) => s.index);
  const toCreateEpic = !epicMatch;

  // detect bullets that disappeared
  const currentIndexSet = new Set(subs.map((s) => s.index));
  const orphans: number[] = [];
  for (const idx of seenSubIndices) {
    if (!currentIndexSet.has(idx)) orphans.push(idx);
  }
  orphans.sort((a, b) => a - b);

  // patch epic body when it exists AND its rendered shape differs
  const toPatchEpicBody =
    epicMatch !== undefined &&
    !sameMeaningfulBody(
      existing.find((i) => i.number === epicMatch.number)?.body ?? "",
      epic.body,
    );

  return {
    repo,
    slug,
    dedupeLabel,
    labels,
    epic,
    subs,
    toCreate: { epic: toCreateEpic, subs: toCreateSubs },
    toPatchEpicBody,
    orphans,
  };
};

/**
 * conflict 감지의 핵심 — marker / `- [ ]` / `- [x]` 라인 외에 의미 있는 다른
 * 변경이 있는지 비교. epic body 가 다르더라도 task list 만 다르면 우리가 다시
 * 렌더링해도 안전; 사람이 추가한 prose / 다른 섹션이 있으면 patch 시 잃어버린다.
 *
 * 이 함수는 "patch 가 안전한가" 를 본다 — return true 면 동일 (skip), false 면
 * 새 body 로 덮어쓰는 게 의미 있다. patch 시 사람 변경 보존 책임은 호출자가
 * `applySyncPlan` 의 conflict guard 에서 추가로 검사한다.
 */
const sameMeaningfulBody = (a: string, b: string): boolean =>
  a.trim() === b.trim();

// ── Render ───────────────────────────────────────────────────────────────────

const renderEpicTitle = (spec: ParsedSpec): string => {
  const v = spec.frontmatter.spec_pact_version ?? 1;
  return `[spec] ${spec.frontmatter.slug} v${v}`;
};

const renderSubTitle = (slug: string, bullet: string): string => {
  const summary = bullet.length > 80 ? `${bullet.slice(0, 77)}...` : bullet;
  return `[${slug}] ${summary}`;
};

/**
 * epic body 는 sub 의 GitHub number 가 있으면 `- [ ] #<n> <title>` 로,
 * 아직 없으면 `- [ ] <title>` 로 렌더링한다. apply 시점에 sub 가 만들어지면
 * 다시 호출해서 번호를 채워넣는다.
 */
export const renderEpicBody = (
  spec: ParsedSpec,
  subs: PlanSubItem[],
): string => {
  const slug = spec.frontmatter.slug;
  const lines: string[] = [];
  lines.push(epicMarker(slug));
  lines.push("");
  lines.push(`# Spec`);
  lines.push("");
  if (spec.frontmatter.source_url) {
    lines.push(`- Notion: ${spec.frontmatter.source_url}`);
  }
  if (spec.frontmatter.source_page_id) {
    lines.push(`- Notion page id: \`${spec.frontmatter.source_page_id}\``);
  }
  lines.push(`- SPEC: \`${spec.path}\``);
  lines.push(`- Anchored: ${spec.frontmatter.agreed_at ?? "unknown"}`);
  lines.push("");
  lines.push(`# Sub-issues`);
  lines.push("");
  for (const sub of subs) {
    if (sub.existing) {
      lines.push(
        `- [ ] #${sub.existing.number} ${sub.title.replace(/^\[[^\]]+\]\s*/, "")}`,
      );
    } else {
      lines.push(`- [ ] ${sub.title.replace(/^\[[^\]]+\]\s*/, "")}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "_Generated by [agent-toolkit](https://github.com/minjun0219/agent-toolkit) `spec-to-issues` — re-run is idempotent (markers based)._",
  );
  return lines.join("\n");
};

export const renderSubBody = (
  spec: ParsedSpec,
  index: number,
  bullet: string,
): string => {
  const slug = spec.frontmatter.slug;
  const lines: string[] = [];
  lines.push(subMarker(slug, index));
  lines.push("");
  lines.push(`# 작업`);
  lines.push("");
  lines.push(`- ${bullet}`);
  lines.push("");
  lines.push(`# Spec`);
  lines.push("");
  if (spec.frontmatter.source_url) {
    lines.push(`- Notion: ${spec.frontmatter.source_url}`);
  }
  lines.push(`- SPEC: \`${spec.path}\` — \`# 합의 TODO\` bullet ${index}`);
  if (spec.frontmatter.agreed_at) {
    lines.push(`- Anchored: ${spec.frontmatter.agreed_at}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "_Generated by [agent-toolkit](https://github.com/minjun0219/agent-toolkit) `spec-to-issues`._",
  );
  return lines.join("\n");
};

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyResult {
  created: { epic?: GhIssueRef; subs: GhIssueRef[] };
  patchedEpic: boolean;
  reused: { epic?: number; subs: number[] };
}

/**
 * plan 에 따라 실제 `gh` 호출. 순서는:
 *  1. missing sub 들을 만든다 (한 번에 하나씩 — gh 의 throttle 정책 안전).
 *  2. plan 의 epic body 를 다시 렌더링한다 (이번엔 새 sub 번호도 포함).
 *  3. epic 이 없으면 만들고, 있으면 (대상 변경이 있을 때만) patch.
 *
 * `spec` 인자는 epic body 재렌더링용 — buildSyncPlan 시점과 같은 SPEC 인스턴스를
 * 넘긴다 (호출자가 plan 과 spec 을 함께 들고 있어야 한다).
 */
export const applySyncPlan = async (
  exec: GhExecutor,
  plan: SyncPlan,
  spec: ParsedSpec,
): Promise<ApplyResult> => {
  // 1. create missing subs
  const createdSubs: GhIssueRef[] = [];
  const subIndexToRef = new Map<number, { number: number; url: string }>();
  for (const sub of plan.subs) {
    if (sub.existing) {
      subIndexToRef.set(sub.index, sub.existing);
      continue;
    }
    const ref = await ghIssueCreate(exec, {
      repo: plan.repo,
      title: sub.title,
      body: sub.body,
      labels: plan.labels,
    });
    createdSubs.push(ref);
    subIndexToRef.set(sub.index, ref);
  }

  // 2. re-render epic body with the new numbers
  const subsForEpic = plan.subs.map((s) => ({
    ...s,
    existing: subIndexToRef.get(s.index),
  }));
  const epicBody = renderEpicBody(spec, subsForEpic);

  // 3. epic create / patch
  let createdEpic: GhIssueRef | undefined;
  let patchedEpic = false;
  if (!plan.epic.existing) {
    createdEpic = await ghIssueCreate(exec, {
      repo: plan.repo,
      title: plan.epic.title,
      body: epicBody,
      labels: plan.labels,
    });
  } else if (createdSubs.length > 0 || plan.toPatchEpicBody) {
    await ghIssueEdit(exec, {
      repo: plan.repo,
      number: plan.epic.existing.number,
      body: epicBody,
    });
    patchedEpic = true;
  }

  return {
    created: { epic: createdEpic, subs: createdSubs },
    patchedEpic,
    reused: {
      epic: plan.epic.existing?.number,
      subs: plan.subs
        .filter((s) => s.existing)
        .map((s) => (s.existing as { number: number }).number),
    },
  };
};

// ── Top-level entry point ────────────────────────────────────────────────────

export interface SyncSpecToIssuesInput {
  spec: ParsedSpec;
  repo: string;
  dedupeLabel: string;
  labels: string[];
  dryRun: boolean;
}

export interface SyncSpecToIssuesOutput {
  plan: SyncPlan;
  applied?: ApplyResult;
}

/**
 * dryRun 이면 plan 만, 아니면 plan + applied 결과를 반환. 어느 쪽이든 `gh issue
 * list` 는 한 번 호출된다 (dedupe 기반).
 */
export const syncSpecToIssues = async (
  exec: GhExecutor,
  input: SyncSpecToIssuesInput,
): Promise<SyncSpecToIssuesOutput> => {
  const existing = await ghIssueListByLabel(
    exec,
    input.repo,
    input.dedupeLabel,
    "all",
  );
  const plan = buildSyncPlan(
    input.spec,
    input.repo,
    input.dedupeLabel,
    input.labels,
    existing,
  );
  if (input.dryRun) {
    return { plan };
  }
  const applied = await applySyncPlan(exec, plan, input.spec);
  return { plan, applied };
};
