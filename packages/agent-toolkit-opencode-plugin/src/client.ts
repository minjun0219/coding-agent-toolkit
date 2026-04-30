/**
 * gateway HTTP 클라이언트.
 *
 * plugin 은 gateway 의 thin wrapper 이므로 별도 비즈니스 로직 없이
 * fetch 로 endpoint 만 두드린다.
 */
export class GatewayClient {
  private readonly base: string;

  constructor(base: string) {
    if (!base) throw new Error("GatewayClient: base url is required");
    this.base = base.replace(/\/$/, "");
  }

  /** 헬스체크. 시작 직후 readiness probe 용. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async get(input: string): Promise<GetResult> {
    return this.post<GetResult>("/v1/notion/get", { input });
  }

  async refresh(input: string): Promise<GetResult> {
    return this.post<GetResult>("/v1/notion/refresh", { input });
  }

  async status(input: string): Promise<StatusResult> {
    return this.post<StatusResult>("/v1/notion/status", { input });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`gateway returned non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg =
        (parsed as { error?: string })?.error ?? `gateway error ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }
}

export interface GetResult {
  fromCache: boolean;
  pageId: string;
  title: string;
  cachedAt: string;
  ttlSeconds: number;
  contentHash: string;
  url: string;
  markdown: string;
}

export interface StatusResult {
  pageId: string;
  exists: boolean;
  expired: boolean;
  cachedAt?: string;
  ttlSeconds?: number;
  ageSeconds?: number;
  title?: string;
}
