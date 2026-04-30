import type { GatewayClient, GetResult, StatusResult } from "./client";

/**
 * opencode 의 slash command 가 호출하는 핸들러.
 *
 * opencode plugin API 의 정확한 contract 는 호스트마다 다를 수 있으므로,
 * 여기서는 "문자열을 받아 사람이 읽을 수 있는 결과 문자열을 반환" 하는
 * 가장 일반적인 형태로 구현한다. plugin host 가 다른 형태를 원하면
 * 이 함수의 반환값만 가공해 쓰면 된다.
 */
export interface NotionCommands {
  get(input: string): Promise<string>;
  refresh(input: string): Promise<string>;
  status(input: string): Promise<string>;
}

export function createNotionCommands(client: GatewayClient): NotionCommands {
  return {
    async get(input: string) {
      const r = await client.get(input.trim());
      return formatGetResult(r);
    },
    async refresh(input: string) {
      const r = await client.refresh(input.trim());
      return formatGetResult(r, true);
    },
    async status(input: string) {
      const s = await client.status(input.trim());
      return formatStatus(s);
    },
  };
}

function formatGetResult(r: GetResult, forced = false): string {
  const header = [
    `# ${r.title}`,
    `pageId: ${r.pageId}`,
    `cachedAt: ${r.cachedAt}`,
    `ttlSeconds: ${r.ttlSeconds}`,
    `fromCache: ${r.fromCache}${forced ? " (forced refresh)" : ""}`,
    `contentHash: ${r.contentHash}`,
  ].join("\n");
  return `${header}\n\n---\n\n${r.markdown}\n`;
}

function formatStatus(s: StatusResult): string {
  if (!s.exists) {
    return `pageId: ${s.pageId}\nstatus: not cached`;
  }
  const lines = [
    `pageId: ${s.pageId}`,
    `title: ${s.title ?? "(unknown)"}`,
    `cachedAt: ${s.cachedAt}`,
    `ttlSeconds: ${s.ttlSeconds}`,
    `ageSeconds: ${s.ageSeconds}`,
    `expired: ${s.expired}`,
  ];
  return lines.join("\n");
}
