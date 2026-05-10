import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SpecSource } from "./schema";

/**
 * spec 소스 (URL 또는 file path) 에서 raw 본문을 가져온다. URL 모드에서는 etag /
 * lastModified conditional GET 을 지원해 304 응답을 그대로 흘린다.
 *
 * undici 가 fetch 보다 dispatcher / TLS 옵션 처리가 명확해서 그대로 채택. Bun 도
 * undici 를 정상 import 한다.
 */

export class SpecFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SpecFetchError";
  }
}

export interface FetchResult {
  body: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
  notModified: false;
  source: SpecSource;
}

export interface NotModifiedResult {
  notModified: true;
  fetchedAt: string;
  source: SpecSource;
}

export type FetchOutcome = FetchResult | NotModifiedResult;

export interface ConditionalHeaders {
  etag?: string;
  lastModified?: string;
}

export interface FetcherOptions {
  timeoutMs?: number;
  insecureTls?: boolean;
  extraCaCerts?: string[];
}

export interface SpecFetcher {
  fetch(
    source: SpecSource,
    conditional?: ConditionalHeaders,
  ): Promise<FetchOutcome>;
}

export function createFetcher(options: FetcherOptions = {}): SpecFetcher {
  return new DefaultSpecFetcher(options);
}

class DefaultSpecFetcher implements SpecFetcher {
  private dispatcher: unknown;

  constructor(private readonly options: FetcherOptions) {}

  async fetch(
    source: SpecSource,
    conditional?: ConditionalHeaders,
  ): Promise<FetchOutcome> {
    if (source.type === "file") {
      return this.fetchFile(source);
    }
    return this.fetchUrl(source, conditional);
  }

  private async fetchFile(
    source: Extract<SpecSource, { type: "file" }>,
  ): Promise<FetchResult> {
    const absolute = path.resolve(source.path);
    try {
      const body = await readFile(absolute, "utf8");
      return {
        body,
        fetchedAt: new Date().toISOString(),
        notModified: false,
        source,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SpecFetchError(
        `failed to read spec file ${absolute}: ${reason}`,
        undefined,
        err,
      );
    }
  }

  private async fetchUrl(
    source: Extract<SpecSource, { type: "url" }>,
    conditional?: ConditionalHeaders,
  ): Promise<FetchOutcome> {
    const { request } = await import("undici");
    const dispatcher = await this.getDispatcher();
    const headers: Record<string, string> = {
      Accept:
        "application/json, application/yaml;q=0.9, text/yaml;q=0.9, */*;q=0.1",
    };
    if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
    if (conditional?.lastModified)
      headers["If-Modified-Since"] = conditional.lastModified;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 10_000,
    );

    try {
      const response = await request(source.url, {
        method: "GET",
        headers,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher: dispatcher as never } : {}),
      });

      const fetchedAt = new Date().toISOString();
      if (response.statusCode === 304) {
        await response.body.dump();
        return { notModified: true, fetchedAt, source };
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        throw new SpecFetchError(
          `unexpected HTTP ${response.statusCode} fetching ${source.url}`,
          response.statusCode,
        );
      }

      const body = await response.body.text();
      const etag = headerString(response.headers.etag);
      const lastModified = headerString(response.headers["last-modified"]);
      return {
        body,
        etag,
        lastModified,
        fetchedAt,
        notModified: false,
        source,
      };
    } catch (err) {
      if (err instanceof SpecFetchError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new SpecFetchError(
        `failed to fetch ${source.url}: ${reason}`,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getDispatcher(): Promise<unknown> {
    const wantsCustomTls =
      this.options.insecureTls === true ||
      (this.options.extraCaCerts !== undefined &&
        this.options.extraCaCerts.length > 0);
    if (!wantsCustomTls) return undefined;
    if (this.dispatcher) return this.dispatcher;

    const { Agent } = await import("undici");
    const connect: Record<string, unknown> = {};
    if (this.options.insecureTls) {
      connect.rejectUnauthorized = false;
    } else if (
      this.options.extraCaCerts &&
      this.options.extraCaCerts.length > 0
    ) {
      const cas = await Promise.all(
        this.options.extraCaCerts.map(async (p) => {
          try {
            return await readFile(p, "utf8");
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new SpecFetchError(
              `failed to read extraCaCerts entry '${p}': ${reason}`,
              undefined,
              err,
            );
          }
        }),
      );
      connect.ca = cas;
    }
    this.dispatcher = new Agent({ connect });
    return this.dispatcher;
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
