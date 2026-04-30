import { NotionCache } from "@agent-toolkit/core";
import {
  RemoteMcpClient,
  NotionGateway,
  startGatewayServer,
} from "@agent-toolkit/mcp-gateway";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 가짜 remote Notion MCP + gateway 를 띄워 cache miss/hit/refresh 흐름을 검증한다.
 * MVP smoke test 용 (test runner 와 별개로 직접 실행).
 */
const remote = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/getPage" && req.method === "POST") {
      return Response.json({
        id: "1234abcd1234abcd1234abcd1234abcd",
        title: "Hello",
        markdown: "# Hello\n\nworld",
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const cacheDir = mkdtempSync(join(tmpdir(), "smoke-"));
const cache = new NotionCache({ baseDir: cacheDir, defaultTtlSeconds: 60 });
const remoteClient = new RemoteMcpClient({
  endpoint: `http://${remote.hostname}:${remote.port}`,
});
const gateway = new NotionGateway({ cache, remote: remoteClient });
const server = startGatewayServer({
  gateway,
  port: 0,
  hostname: "127.0.0.1",
});
const base = `http://${server.hostname}:${server.port}`;

async function call(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "1234abcd1234abcd1234abcd1234abcd" }),
  });
  return res.json();
}

const health = await fetch(`${base}/health`).then((r) => r.json());
console.log("health :", health);

const first = await call("/v1/notion/get");
console.log("first  :", {
  fromCache: first.fromCache,
  title: first.title,
  hash: first.contentHash,
});

const second = await call("/v1/notion/get");
console.log("second :", { fromCache: second.fromCache, title: second.title });

const status = await call("/v1/notion/status");
console.log("status :", status);

const refreshed = await call("/v1/notion/refresh");
console.log("refresh:", { fromCache: refreshed.fromCache });

server.stop();
remote.stop();
console.log("OK");
