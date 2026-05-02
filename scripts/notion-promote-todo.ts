import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../lib/toolkit-config";

interface ExtractJson {
  source?: { path?: string; name?: string };
  extracted?: { todos?: Array<{ text?: string; chunkId?: string }> };
}

interface CliArgs {
  input: string;
  slug: string;
  specPath?: string;
}

const DEFAULT_SPEC_DIR = ".agent/specs";
const DEFAULT_INDEX_FILE = "INDEX.md";

function printHelp() {
  console.log(`notion-promote-todo (Bun)

Usage:
  bun scripts/notion-promote-todo.ts <extract-json-path|-> --slug <slug> [--spec-path <path>]

Examples:
  bun scripts/notion-promote-todo.ts ./extract.json --slug order-flow
  bun scripts/notion-promote-todo.ts - --slug order-flow

If input is '-', JSON is read from stdin.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const input = args[0];
  if (!input) {
    throw new Error("Usage error: missing extract JSON path (or '-' for stdin).");
  }

  const slugIdx = args.indexOf("--slug");
  const slug = slugIdx >= 0 ? args[slugIdx + 1] : undefined;
  if (!slug || slug.trim().length === 0) {
    throw new Error("Usage error: --slug is required.");
  }

  const pathIdx = args.indexOf("--spec-path");
  const specPath = pathIdx >= 0 ? args[pathIdx + 1] : undefined;

  return { input, slug: slug.trim(), specPath };
}

async function readStdinUtf8(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function ensureTodos(payload: ExtractJson): string[] {
  const raw = payload.extracted?.todos ?? [];
  const dedup = new Set<string>();
  for (const row of raw) {
    const text = (row.text ?? "").trim();
    if (!text) continue;
    dedup.add(text);
  }
  return [...dedup];
}

function upsertTodoSection(markdown: string, todos: string[]): string {
  const sectionBody = todos.map((t) => `- ${t}`).join("\n");
  const replacement = `# 합의 TODO\n${sectionBody}\n`;

  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "# 합의 TODO");
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#\s+/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, start).join("\n").replace(/\n+$/g, "");
    const after = lines.slice(end).join("\n").replace(/^\n+/g, "");
    if (!before && !after) return replacement;
    if (!before) return `${replacement}\n${after}\n`;
    if (!after) return `${before}\n\n${replacement}`;
    return `${before}\n\n${replacement}\n${after}\n`;
  }

  const base = markdown.trim();
  if (!base) {
    return `# 요약\n\n자동 생성된 SPEC TODO 승격 문서.\n\n${replacement}\n`;
  }
  return `${base}\n\n${replacement}\n`;
}

function ensureIndexTable(indexBody: string): string {
  const trimmed = indexBody.trim();
  if (!trimmed) {
    return [
      "# SPEC INDEX",
      "",
      "| slug | path | status |",
      "| --- | --- | --- |",
      "",
    ].join("\n");
  }
  return indexBody;
}

function upsertIndexRow(indexBody: string, slug: string, specPath: string): string {
  const normalized = ensureIndexTable(indexBody);
  const lines = normalized.split("\n");
  const rowRe = new RegExp(`^\\|\\s*${slug.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\|`);
  const newRow = `| ${slug} | ${specPath} | locked |`;

  let replaced = false;
  const next = lines.map((line) => {
    if (rowRe.test(line)) {
      replaced = true;
      return newRow;
    }
    return line;
  });

  if (replaced) return `${next.join("\n").replace(/\n+$/g, "")}\n`;

  const tableHeaderIdx = next.findIndex((line) => line.startsWith("| slug | path | status |"));
  if (tableHeaderIdx >= 0) {
    const insertIdx = tableHeaderIdx + 2;
    next.splice(insertIdx, 0, newRow);
    return `${next.join("\n").replace(/\n+$/g, "")}\n`;
  }

  return `${next.join("\n")}\n\n| slug | path | status |\n| --- | --- | --- |\n${newRow}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw =
    args.input === "-"
      ? await readStdinUtf8()
      : await readFile(resolve(args.input), "utf8");

  let payload: ExtractJson;
  try {
    payload = JSON.parse(raw) as ExtractJson;
  } catch (err) {
    throw new Error(`Invalid JSON input: ${(err as Error).message}`);
  }

  const todos = ensureTodos(payload);
  if (todos.length === 0) {
    throw new Error("No TODO items found in extracted.todos.");
  }

  const { config } = await loadConfig({ projectRoot: process.cwd() });
  const specDir = resolve(config.spec?.dir ?? DEFAULT_SPEC_DIR);
  const indexFile = config.spec?.indexFile ?? DEFAULT_INDEX_FILE;
  const specPath = args.specPath
    ? resolve(args.specPath)
    : resolve(specDir, `${args.slug}.md`);
  const indexPath = resolve(specDir, indexFile);

  await mkdir(dirname(specPath), { recursive: true });
  await mkdir(dirname(indexPath), { recursive: true });

  const prevSpec = existsSync(specPath) ? await readFile(specPath, "utf8") : "";
  const nextSpec = upsertTodoSection(prevSpec, todos);
  await writeFile(specPath, nextSpec, "utf8");

  const prevIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "";
  const nextIndex = upsertIndexRow(prevIndex, args.slug, specPath);
  await writeFile(indexPath, nextIndex, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        slug: args.slug,
        specPath,
        indexPath,
        promotedTodoCount: todos.length,
        source: payload.source ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
