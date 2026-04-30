import { AgentToolkitPlugin, type PluginOptions } from "./runtime";
import { createNotionCommands, type NotionCommands } from "./commands";

export { AgentToolkitPlugin } from "./runtime";
export type { PluginOptions } from "./runtime";
export { GatewayClient } from "./client";
export type { GetResult, StatusResult } from "./client";
export { createNotionCommands } from "./commands";
export type { NotionCommands } from "./commands";

/**
 * opencode plugin 등록 헬퍼.
 *
 * plugin host 의 정확한 API 가 환경에 따라 다를 수 있으므로,
 * 여기서는 "lifecycle hooks 와 commands 묶음을 그대로 반환" 하는 단순한 형태로 둔다.
 * opencode 측에서 register 할 때 이 객체를 그대로 넘기면 된다.
 */
export interface OpencodePluginExport {
  name: string;
  version: string;
  /** 호스트가 호출할 lifecycle hooks */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** /notion 하위 커맨드들 */
  commands: {
    "notion get": (input: string) => Promise<string>;
    "notion refresh": (input: string) => Promise<string>;
    "notion status": (input: string) => Promise<string>;
  };
  /** plugin 인스턴스 (테스트 / 디버깅용) */
  instance: AgentToolkitPlugin;
}

export function createOpencodePlugin(
  options: PluginOptions = {},
): OpencodePluginExport {
  const plugin = new AgentToolkitPlugin(options);
  let cmds: NotionCommands | null = null;

  return {
    name: "@agent-toolkit/opencode-plugin",
    version: "0.1.0",
    instance: plugin,
    async start() {
      await plugin.start();
      cmds = createNotionCommands(plugin.getClient());
    },
    async stop() {
      plugin.stop();
      cmds = null;
    },
    commands: {
      "notion get": (input: string) => {
        if (!cmds) throw new Error("plugin not started");
        return cmds.get(input);
      },
      "notion refresh": (input: string) => {
        if (!cmds) throw new Error("plugin not started");
        return cmds.refresh(input);
      },
      "notion status": (input: string) => {
        if (!cmds) throw new Error("plugin not started");
        return cmds.status(input);
      },
    },
  };
}
