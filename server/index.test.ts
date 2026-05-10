/**
 * Smoke tests for the Claude Code MCP server entrypoint. Connects an
 * in-memory `Client` to a real `buildServer()` instance and asserts:
 *
 *  - the expected 15 tools are registered (no notion / pr-watch leakage)
 *  - their input schemas advertise the right required fields
 *  - `spec_pact_fragment` round-trips via the lib helper
 *
 * No network, no MySQL — only the surface that does not require external
 * services is exercised here. The handler logic itself is covered by the
 * lib/*.test.ts and .opencode/plugins/agent-toolkit.test.ts suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index";

const EXPECTED_TOOLS = [
  "openapi_get",
  "openapi_refresh",
  "openapi_status",
  "openapi_search",
  "openapi_envs",
  "openapi_endpoint",
  "openapi_tags",
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

/** 제거 후보 + Claude Code 진입점에서 비노출 — surface 누수 금지. */
const REMOVED_TOOLS = [
  "notion_get",
  "notion_refresh",
  "notion_status",
  "notion_extract",
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

/** beforeAll 에서 덮어쓰는 env 키 — afterAll 에서 정확히 같은 셋만 원복한다. */
const ENV_KEYS_TO_RESTORE = [
  "AGENT_TOOLKIT_JOURNAL_DIR",
  "AGENT_TOOLKIT_OPENAPI_CACHE_DIR",
] as const;

let client: Client;
let tmpHome: string;
let skillsDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Isolate the journal / openapi cache so the test doesn't touch a real
  // `~/.config/...` tree on the developer's machine. Mutating env keys must
  // match the names that the lib helpers actually read — see
  // `lib/agent-journal.ts` (AGENT_TOOLKIT_JOURNAL_DIR) and
  // `lib/openapi-context.ts` (AGENT_TOOLKIT_OPENAPI_CACHE_DIR).
  tmpHome = mkdtempSync(join(tmpdir(), "agent-toolkit-server-test-"));
  for (const key of ENV_KEYS_TO_RESTORE) {
    savedEnv[key] = process.env[key];
  }
  process.env.AGENT_TOOLKIT_JOURNAL_DIR = join(tmpHome, "journal");
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
  // Restore env exactly to its pre-test state — keep the rest of the suite
  // (and any sibling test in the same Bun process) deterministic.
  for (const key of ENV_KEYS_TO_RESTORE) {
    const prior = savedEnv[key];
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("agent-toolkit MCP server", () => {
  test("exposes exactly the 17 in-scope tools", async () => {
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
