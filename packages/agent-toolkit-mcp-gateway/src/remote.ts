import type { RawNotionPage } from "@agent-toolkit/core";

export interface RemoteMcpOptions {
  /** Remote Notion MCP HTTP endpoint */
  endpoint: string;
  /** Bearer token (옵션). 있으면 Authorization 헤더로 첨부 */
  token?: string;
  /** fetch timeout (ms). 기본 15s */
  timeoutMs?: number;
}

/**
 * Remote Notion MCP HTTP 클라이언트.
 *
 * MVP 에서는 한 가지 endpoint 동작만 가정한다:
 *   POST {endpoint}/getPage
 *   body: { pageId: string }
 *   200 -> { id, title, markdown?, blocks? }
 *
 * 실제 Remote MCP 의 wire format 이 다르더라도 이 함수만 바꿔주면 된다.
 */
export class RemoteMcpClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteMcpOptions) {
    if (!options.endpoint) {
      throw new Error("RemoteMcpClient: endpoint is required");
    }
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * 단일 Notion 페이지를 가져온다.
   * timeout 또는 non-2xx 응답은 명확한 메시지로 throw 한다.
   */
  async getPage(pageId: string): Promise<RawNotionPage> {
    const url = `${this.endpoint}/getPage`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ pageId }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Remote MCP error ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        );
      }

      const data = (await res.json()) as RawNotionPage;
      if (!data || typeof data !== "object" || !("id" in data)) {
        throw new Error("Remote MCP returned malformed payload (missing id)");
      }
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Remote MCP request timed out after ${this.timeoutMs}ms (pageId=${pageId})`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
