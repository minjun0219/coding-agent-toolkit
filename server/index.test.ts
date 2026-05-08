/**
 * Smoke tests for the Claude Code MCP server entrypoint. Connects an
 * in-memory `Client` to a real `buildServer()` instance and asserts:
 *
 *  - the expected 19 tools are registered (no pr-watch / gh-passthrough /
 *    spec-to-issues leakage)
 *  - their input schemas advertise the right required fields
 *  - `spec_pact_fragment` round-trips via the lib helper
 *
 * No network, no Notion, no MySQL — only the surface that does not require
 * external services is exercised here. The handler logic itself is covered
 * by the lib/*.test.ts and .opencode/plugins/agent-toolkit.test.ts suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index";

const EXPECTED_TOOLS = [
  "notion_get",
  "notion_refresh",
  "notion_status",
  "notion_extract",
  "openapi_get",
  "openapi_refresh",
  "openapi_status",
  "openapi_search",
  "openapi_envs",
  "journal_append",
  "journal_read",
  "journal_search",
  "journal_status",
  "mysql_envs",
  "mysql_status",
  "mysql_tables",
  "mysql_schema",
  "mysql_query",
  "spec_pact_fragment",
] as const;

const REMOVED_TOOLS = [
  "pr_watch_start",
  "pr_watch_stop",
  "pr_watch_status",
  "pr_event_record",
  "pr_event_pending",
  "pr_event_resolve",
  "gh_run",
  "issue_create_from_spec",
  "issue_status",
] as const;

const FRAGMENT_BODY = "# DRAFT mode\n\nfixture body for in-memory test.\n";

let client: Client;
let tmpHome: string;
let skillsDir: string;

beforeAll(async () => {
  // Isolate the journal / cache so the test doesn't touch a real `~/.config`
  // tree on the developer's machine.
  tmpHome = mkdtempSync(join(tmpdir(), "agent-toolkit-server-test-"));
  process.env.AGENT_TOOLKIT_JOURNAL_PATH = join(tmpHome, "journal.jsonl");
  process.env.AGENT_TOOLKIT_NOTION_CACHE_DIR = join(tmpHome, "notion-cache");
  process.env.AGENT_TOOLKIT_OPENAPI_CACHE_DIR = join(tmpHome, "openapi-cache");

  skillsDir = join(tmpHome, "skills");
  const draftDir = join(skillsDir, "spec-pact", "fragments");
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, "draft.md"), FRAGMENT_BODY);

  const server = await buildServer({ skillsDir });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "agent-toolkit-test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
});

describe("agent-toolkit MCP server", () => {
  test("exposes exactly the 19 in-scope tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  test("does not leak removal-candidate tools", async () => {
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    for (const removed of REMOVED_TOOLS) {
      expect(names.has(removed)).toBe(false);
    }
  });

  test("required fields match the opencode plugin contract", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const requiredFields = (name: string): string[] => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`tool not found: ${name}`);
      const schema = tool.inputSchema as { required?: string[] };
      return [...(schema.required ?? [])].sort();
    };

    expect(requiredFields("notion_get")).toEqual(["input"]);
    expect(requiredFields("notion_extract")).toEqual(["input"]);
    expect(requiredFields("openapi_search")).toEqual(["query"]);
    expect(requiredFields("journal_append")).toEqual(["content"]);
    expect(requiredFields("journal_search")).toEqual(["query"]);
    expect(requiredFields("mysql_query")).toEqual(["handle", "sql"]);
    expect(requiredFields("spec_pact_fragment")).toEqual(["mode"]);
  });

  test("spec_pact_fragment returns the fixture body for `draft`", async () => {
    const res = await client.callTool({
      name: "spec_pact_fragment",
      arguments: { mode: "draft" },
    });
    const block = (res.content as Array<{ type: string; text: string }>)[0];
    expect(block?.type).toBe("text");
    const payload = JSON.parse(block?.text ?? "{}") as {
      mode: string;
      content: string;
    };
    expect(payload.mode).toBe("draft");
    expect(payload.content).toBe(FRAGMENT_BODY);
  });

  test("spec_pact_fragment rejects unknown modes", async () => {
    const res = await client.callTool({
      name: "spec_pact_fragment",
      arguments: { mode: "totally-bogus" },
    });
    expect(res.isError).toBe(true);
  });
});
