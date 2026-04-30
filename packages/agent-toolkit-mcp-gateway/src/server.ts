import { NotionGateway } from "./gateway";

export interface ServerOptions {
  gateway: NotionGateway;
  /** 서버 바인딩 포트 (기본 4319) */
  port?: number;
  /** 호스트 (기본 127.0.0.1) - localhost 외 접근은 기본 차단 */
  hostname?: string;
}

/**
 * Bun.serve 기반의 매우 얇은 HTTP wrapper.
 *
 * 엔드포인트 (모두 application/json):
 *   GET  /health
 *   POST /v1/notion/get        body: { input: string }
 *   POST /v1/notion/refresh    body: { input: string }
 *   POST /v1/notion/status     body: { input: string }
 *
 * `input` 은 page id 또는 Notion url 양쪽 모두 허용.
 */
export function startGatewayServer(options: ServerOptions) {
  const gateway = options.gateway;
  const port = options.port ?? 4319;
  const hostname = options.hostname ?? "127.0.0.1";

  return Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return json({ ok: true });
        }
        if (req.method !== "POST") {
          return json({ error: "method not allowed" }, 405);
        }

        // 모든 POST endpoint 는 동일한 body 형태를 사용한다.
        const body = (await safeJson(req)) as { input?: string } | null;
        const input = body?.input?.trim();
        if (!input) {
          return json({ error: "missing 'input' (pageId or url)" }, 400);
        }

        switch (url.pathname) {
          case "/v1/notion/get": {
            const r = await gateway.getPage(input);
            return json(serializeResult(r));
          }
          case "/v1/notion/refresh": {
            const r = await gateway.refreshPage(input);
            return json(serializeResult(r));
          }
          case "/v1/notion/status": {
            const s = await gateway.getCacheStatus(input);
            return json(s);
          }
          default:
            return json({ error: "not found" }, 404);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: msg }, 500);
      }
    },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function serializeResult(r: {
  entry: { pageId: string; title: string; cachedAt: string; ttlSeconds: number; contentHash: string; url: string };
  markdown: string;
  fromCache: boolean;
}) {
  return {
    fromCache: r.fromCache,
    pageId: r.entry.pageId,
    title: r.entry.title,
    cachedAt: r.entry.cachedAt,
    ttlSeconds: r.entry.ttlSeconds,
    contentHash: r.entry.contentHash,
    url: r.entry.url,
    markdown: r.markdown,
  };
}
