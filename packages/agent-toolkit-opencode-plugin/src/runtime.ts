import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { GatewayClient } from "./client";

export interface PluginOptions {
  /** 미리 떠있는 gateway 주소가 있다면 spawn 대신 그걸 사용 */
  externalGatewayUrl?: string;
  /** spawn 모드일 때 사용할 포트 (기본 4319) */
  port?: number;
  /** spawn 모드일 때 host (기본 127.0.0.1) */
  hostname?: string;
  /** 추가 env (gateway child process 에 머지됨) */
  env?: Record<string, string | undefined>;
}

/**
 * plugin runtime.
 *
 * - externalGatewayUrl 이 주어지면 child process 없이 그 endpoint 만 호출.
 * - 아니면 Bun.spawn 으로 gateway 를 띄우고, /health 가 ok 가 될 때까지 대기.
 */
export class AgentToolkitPlugin {
  private proc: Subprocess | undefined;
  private readonly url: string;
  private readonly client: GatewayClient;
  private readonly options: PluginOptions;

  constructor(options: PluginOptions = {}) {
    this.options = options;
    if (options.externalGatewayUrl) {
      this.url = options.externalGatewayUrl.replace(/\/$/, "");
    } else {
      const port = options.port ?? 4319;
      const host = options.hostname ?? "127.0.0.1";
      this.url = `http://${host}:${port}`;
    }
    this.client = new GatewayClient(this.url);
  }

  /** 노출되는 명령들이 사용하는 client. */
  getClient(): GatewayClient {
    return this.client;
  }

  /** child process 가 떠있다면 base url 반환. */
  getUrl(): string {
    return this.url;
  }

  /**
   * gateway 를 spawn 하고 ready 까지 polling.
   * external 모드면 spawn 없이 health check 만 시도한다.
   */
  async start(): Promise<void> {
    if (this.options.externalGatewayUrl) {
      const ok = await this.waitForReady(5_000);
      if (!ok) {
        throw new Error(
          `external gateway at ${this.url} did not respond to /health`,
        );
      }
      return;
    }

    if (this.proc) return;

    // gateway CLI 의 절대경로. 같은 monorepo 안에서 spawn 한다.
    const gatewayCli = resolve(
      __dirname,
      "../../agent-toolkit-mcp-gateway/src/cli.ts",
    );

    const env: Record<string, string> = {
      ...sanitizeEnv(process.env),
      ...sanitizeEnv(this.options.env),
      AGENT_TOOLKIT_GATEWAY_PORT: String(this.options.port ?? 4319),
      AGENT_TOOLKIT_GATEWAY_HOST: this.options.hostname ?? "127.0.0.1",
    };

    this.proc = Bun.spawn(["bun", "run", gatewayCli], {
      env,
      stdout: "inherit",
      stderr: "inherit",
      // plugin 이 죽으면 child gateway 도 함께 종료되도록.
      onExit: (_p, exitCode) => {
        if (exitCode !== 0) {
          console.error(`[plugin] gateway exited with code ${exitCode}`);
        }
        this.proc = undefined;
      },
    });

    const ok = await this.waitForReady(8_000);
    if (!ok) {
      this.stop();
      throw new Error(
        `[plugin] gateway failed to become ready at ${this.url} within timeout`,
      );
    }
  }

  /** child process 가 있다면 종료 신호 전달. */
  stop(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        // 이미 죽었으면 무시
      }
    }
    this.proc = undefined;
  }

  /**
   * /health 가 ok 가 될 때까지 폴링한다.
   * 100ms 간격, 총 timeoutMs 만큼 시도.
   */
  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.health()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }
}

/**
 * undefined 값을 제거하여 Bun.spawn 의 env 타입에 맞춘다.
 */
function sanitizeEnv(
  src: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
