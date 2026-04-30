#!/usr/bin/env bun
import { createCacheFromEnv } from "@agent-toolkit/core";
import { RemoteMcpClient } from "./remote";
import { NotionGateway } from "./gateway";
import { startGatewayServer } from "./server";

/**
 * gateway 단독 실행 진입점.
 *
 * 환경변수:
 *   AGENT_TOOLKIT_GATEWAY_PORT       (기본 4319)
 *   AGENT_TOOLKIT_GATEWAY_HOST       (기본 127.0.0.1)
 *   AGENT_TOOLKIT_NOTION_MCP_URL     (필수) - remote Notion MCP base URL
 *   AGENT_TOOLKIT_NOTION_MCP_TOKEN   (옵션) - bearer token
 *   AGENT_TOOLKIT_CACHE_DIR          (옵션) - 캐시 디렉터리
 *   AGENT_TOOLKIT_CACHE_TTL          (옵션, 초)
 */
function main() {
  const endpoint = process.env.AGENT_TOOLKIT_NOTION_MCP_URL;
  if (!endpoint) {
    console.error(
      "[gateway] AGENT_TOOLKIT_NOTION_MCP_URL is required (remote Notion MCP endpoint)",
    );
    process.exit(1);
  }

  const cache = createCacheFromEnv();
  const remote = new RemoteMcpClient({
    endpoint,
    token: process.env.AGENT_TOOLKIT_NOTION_MCP_TOKEN,
  });
  const gateway = new NotionGateway({ cache, remote });

  const port = Number.parseInt(
    process.env.AGENT_TOOLKIT_GATEWAY_PORT ?? "4319",
    10,
  );
  const hostname = process.env.AGENT_TOOLKIT_GATEWAY_HOST ?? "127.0.0.1";

  const server = startGatewayServer({ gateway, port, hostname });
  console.log(
    `[gateway] listening on http://${server.hostname}:${server.port} (cache=${cache.getDir()})`,
  );

  // graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[gateway] received ${sig}, shutting down`);
      server.stop();
      process.exit(0);
    });
  }
}

main();
