import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { contentHash } from "./hash";
import { resolveCacheKey } from "./key";
import type {
  NotionCacheEntry,
  NotionCacheStatus,
  RawNotionPage,
} from "./types";
import { notionToMarkdown } from "./normalize";

/** 캐시 디렉터리 기본 위치. cwd 기준으로 .agent-cache/notion/pages 사용. */
const DEFAULT_DIR = ".agent-cache/notion/pages";

/** 기본 TTL (초). 환경에 따라 옵션으로 덮어쓸 수 있다. */
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

export interface NotionCacheOptions {
  /** 캐시 루트 디렉터리. 미지정 시 cwd 기준 기본 경로 사용 */
  baseDir?: string;
  /** 기본 TTL (초). 미지정 시 24시간 */
  defaultTtlSeconds?: number;
}

/**
 * 파일시스템 기반의 Notion 페이지 캐시.
 *
 * 한 페이지당 두 개의 파일을 둔다:
 *   - <pageId>.json : 메타데이터
 *   - <pageId>.md   : normalize된 markdown 본문
 *
 * 외부에 노출되는 메서드는 read / write / status / clear 4가지.
 */
export class NotionCache {
  private readonly dir: string;
  private readonly defaultTtl: number;

  constructor(options: NotionCacheOptions = {}) {
    this.dir = resolve(options.baseDir ?? DEFAULT_DIR);
    this.defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /** 캐시 루트 경로 반환 (디버깅 / status 용) */
  getDir(): string {
    return this.dir;
  }

  /**
   * 페이지가 캐시에 존재하고 만료되지 않았다면 entry + markdown 을 반환,
   * 그렇지 않으면 null 을 반환한다.
   *
   * @param input page id 또는 url
   */
  async read(
    input: string,
  ): Promise<{ entry: NotionCacheEntry; markdown: string } | null> {
    const { key } = resolveCacheKey(input);
    const jsonPath = join(this.dir, `${key}.json`);
    const mdPath = join(this.dir, `${key}.md`);

    if (!existsSync(jsonPath) || !existsSync(mdPath)) {
      return null;
    }

    let entry: NotionCacheEntry;
    let markdown: string;
    try {
      const raw = await readFile(jsonPath, "utf8");
      entry = JSON.parse(raw) as NotionCacheEntry;
      markdown = await readFile(mdPath, "utf8");
    } catch (err) {
      // 손상된 캐시는 없는 셈 친다.
      return null;
    }

    if (this.isExpired(entry)) {
      return null;
    }
    return { entry, markdown };
  }

  /**
   * Remote MCP 에서 받은 raw 페이지를 normalize 하여 캐시에 기록한다.
   *
   * @param input 원래 사용자 입력 (page id 또는 url) - entry.url 에 저장됨
   * @param page  remote MCP raw payload
   * @param ttlSeconds 이 항목에만 적용할 TTL (옵션)
   */
  async write(
    input: string,
    page: RawNotionPage,
    ttlSeconds?: number,
  ): Promise<{ entry: NotionCacheEntry; markdown: string }> {
    const { pageId, key } = resolveCacheKey(input);
    const markdown = notionToMarkdown(page);
    const entry: NotionCacheEntry = {
      pageId,
      url: input,
      cachedAt: new Date().toISOString(),
      ttlSeconds: ttlSeconds ?? this.defaultTtl,
      contentHash: contentHash(markdown),
      title: page.title || "(untitled)",
    };

    await mkdir(this.dir, { recursive: true });
    const jsonPath = join(this.dir, `${key}.json`);
    const mdPath = join(this.dir, `${key}.md`);
    await writeFile(jsonPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await writeFile(mdPath, markdown, "utf8");
    return { entry, markdown };
  }

  /**
   * 캐시 메타 + 만료 여부를 가볍게 조회한다.
   * 페이지가 디스크에 없는 경우 exists=false 만 채워서 반환.
   */
  async status(input: string): Promise<NotionCacheStatus> {
    const { pageId, key } = resolveCacheKey(input);
    const jsonPath = join(this.dir, `${key}.json`);
    if (!existsSync(jsonPath)) {
      return { pageId, exists: false, expired: false };
    }
    try {
      const raw = await readFile(jsonPath, "utf8");
      const entry = JSON.parse(raw) as NotionCacheEntry;
      const ageSeconds = Math.max(
        0,
        Math.floor((Date.now() - new Date(entry.cachedAt).getTime()) / 1000),
      );
      return {
        pageId,
        exists: true,
        expired: this.isExpired(entry),
        cachedAt: entry.cachedAt,
        ttlSeconds: entry.ttlSeconds,
        ageSeconds,
        title: entry.title,
      };
    } catch {
      return { pageId, exists: false, expired: false };
    }
  }

  /**
   * 단일 항목의 캐시를 강제로 만료시킨다 (파일은 남기되, 다음 read 에서 miss 처리).
   * 우리는 단순히 ttlSeconds 를 0 으로 갱신하여 만료시킨다.
   */
  async invalidate(input: string): Promise<boolean> {
    const status = await this.status(input);
    if (!status.exists) return false;
    const { key } = resolveCacheKey(input);
    const jsonPath = join(this.dir, `${key}.json`);
    const raw = await readFile(jsonPath, "utf8");
    const entry = JSON.parse(raw) as NotionCacheEntry;
    entry.ttlSeconds = 0;
    await writeFile(jsonPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return true;
  }

  /** 내부적으로 cachedAt + ttlSeconds 와 현재 시각을 비교해 만료 여부 판단. */
  private isExpired(entry: NotionCacheEntry): boolean {
    if (entry.ttlSeconds <= 0) return true;
    const cachedAtMs = new Date(entry.cachedAt).getTime();
    if (!Number.isFinite(cachedAtMs)) return true;
    const expiresAtMs = cachedAtMs + entry.ttlSeconds * 1000;
    return Date.now() >= expiresAtMs;
  }
}

/**
 * 한 줄 헬퍼: 환경변수로부터 NotionCache 를 만든다.
 *   AGENT_TOOLKIT_CACHE_DIR  (옵션)
 *   AGENT_TOOLKIT_CACHE_TTL  (옵션, 초)
 */
export function createCacheFromEnv(): NotionCache {
  const baseDir = process.env.AGENT_TOOLKIT_CACHE_DIR;
  const ttlRaw = process.env.AGENT_TOOLKIT_CACHE_TTL;
  const ttl = ttlRaw ? Number.parseInt(ttlRaw, 10) : undefined;
  return new NotionCache({
    baseDir,
    defaultTtlSeconds: Number.isFinite(ttl) && ttl! > 0 ? ttl : undefined,
  });
}

