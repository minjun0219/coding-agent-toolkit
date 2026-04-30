import {
  NotionCache,
  resolveCacheKey,
  type NotionPageResult,
  type NotionCacheStatus,
} from "@agent-toolkit/core";
import { RemoteMcpClient } from "./remote";

export interface GatewayOptions {
  cache: NotionCache;
  remote: RemoteMcpClient;
}

/**
 * 캐시 + remote MCP 를 묶은 gateway core.
 * HTTP 서버나 plugin 어느 쪽에서든 동일하게 호출할 수 있도록 순수 클래스로 만든다.
 */
export class NotionGateway {
  private readonly cache: NotionCache;
  private readonly remote: RemoteMcpClient;

  constructor(options: GatewayOptions) {
    this.cache = options.cache;
    this.remote = options.remote;
  }

  /**
   * 캐시 우선으로 페이지를 반환한다.
   * 캐시 hit 이면 fromCache=true, miss 이면 remote 에서 가져와 저장 후 반환.
   */
  async getPage(input: string): Promise<NotionPageResult> {
    const cached = await this.cache.read(input);
    if (cached) {
      return { ...cached, fromCache: true };
    }
    return this.refreshPage(input);
  }

  /**
   * 캐시를 무시하고 remote 에서 강제 fetch 후 캐시를 갱신한다.
   */
  async refreshPage(input: string): Promise<NotionPageResult> {
    const { pageId } = resolveCacheKey(input);
    const raw = await this.remote.getPage(pageId);
    const written = await this.cache.write(input, raw);
    return { ...written, fromCache: false };
  }

  /**
   * 캐시 메타 + 만료 여부 조회 (remote 호출 없음).
   */
  async getCacheStatus(input: string): Promise<NotionCacheStatus> {
    return this.cache.status(input);
  }
}
