#!/usr/bin/env bun
import { createOpencodePlugin } from "./index";

/**
 * 수동 디버깅용 CLI.
 *
 * 사용 예:
 *   bun run packages/agent-toolkit-opencode-plugin/src/cli.ts get <pageId-or-url>
 *   bun run packages/agent-toolkit-opencode-plugin/src/cli.ts refresh <pageId-or-url>
 *   bun run packages/agent-toolkit-opencode-plugin/src/cli.ts status <pageId-or-url>
 *
 * 환경변수:
 *   AGENT_TOOLKIT_GATEWAY_URL - 외부 gateway 주소가 있다면 spawn 대신 사용
 *   (그 외 변수는 gateway CLI 와 동일)
 */
async function main() {
  const [, , subcmd, input] = process.argv;
  if (!subcmd || !input) {
    console.error("usage: agent-toolkit-plugin <get|refresh|status> <pageId-or-url>");
    process.exit(2);
  }

  const externalGatewayUrl = process.env.AGENT_TOOLKIT_GATEWAY_URL;
  const plugin = createOpencodePlugin({ externalGatewayUrl });

  await plugin.start();
  try {
    const handler =
      subcmd === "get"
        ? plugin.commands["notion get"]
        : subcmd === "refresh"
          ? plugin.commands["notion refresh"]
          : subcmd === "status"
            ? plugin.commands["notion status"]
            : null;
    if (!handler) {
      console.error(`unknown subcommand: ${subcmd}`);
      process.exit(2);
    }
    const out = await handler(input);
    process.stdout.write(`${out}\n`);
  } finally {
    await plugin.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
