/**
 * Notion 캐시 메타데이터.
 *
 * 디스크에는 두 파일로 저장된다:
 *   - <key>.json : 메타데이터 + 원본 블록 정보
 *   - <key>.md   : normalize된 markdown 본문
 */
export interface NotionCacheEntry {
  /** Notion page id (dash 포함 정규형) */
  pageId: string;
  /** 원래 입력값 (page id 또는 url) */
  url: string;
  /** ISO 8601 캐시 저장 시각 */
  cachedAt: string;
  /** 만료까지 남은 기준이 되는 TTL (초) */
  ttlSeconds: number;
  /** markdown 본문의 sha256 (앞 16자) */
  contentHash: string;
  /** 페이지 제목 */
  title: string;
}

/**
 * gateway 가 반환하는 페이지 결과.
 * cache 메타와 본문(markdown), 그리고 캐시 적중 여부를 포함한다.
 */
export interface NotionPageResult {
  entry: NotionCacheEntry;
  markdown: string;
  fromCache: boolean;
}

/**
 * 캐시 상태 조회 결과.
 */
export interface NotionCacheStatus {
  pageId: string;
  exists: boolean;
  expired: boolean;
  cachedAt?: string;
  ttlSeconds?: number;
  ageSeconds?: number;
  title?: string;
}

/**
 * Notion remote MCP 가 반환했다고 가정하는 최소 페이지 모양.
 * 우리는 title 과 markdown(혹은 blocks) 만 사용한다.
 */
export interface RawNotionPage {
  id: string;
  title: string;
  /** 이미 markdown 으로 내려온 경우 */
  markdown?: string;
  /** 또는 단순 텍스트 블록 배열 */
  blocks?: Array<{ type: string; text?: string }>;
}
