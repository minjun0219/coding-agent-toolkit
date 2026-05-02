import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { chunkNotionMarkdown, extractActionItems } from "../lib/notion-chunking";

interface CliArgs {
  inputPath: string;
  maxChars: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const inputPath = args[0];
  if (!inputPath) {
    throw new Error("Usage error: missing input markdown path.");
  }

  const maxCharsIndex = args.indexOf("--max-chars");
  let maxChars = 1400;
  if (maxCharsIndex >= 0) {
    const raw = args[maxCharsIndex + 1];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Usage error: --max-chars must be positive integer (got: ${raw ?? ""})`);
    }
    maxChars = parsed;
  }

  return { inputPath, maxChars };
}

function printHelp() {
  console.log(`notion-extract (Bun)

Usage:
  bun scripts/notion-extract.ts <markdown-file> [--max-chars 1400]

Output:
  JSON to stdout with chunks + extracted action items.
`);
}

async function main() {
  const { inputPath, maxChars } = parseArgs(process.argv.slice(2));
  const absPath = resolve(inputPath);
  const markdown = await readFile(absPath, "utf8");
  const chunks = chunkNotionMarkdown(markdown, { maxCharsPerChunk: maxChars });
  const extracted = extractActionItems(chunks);

  const out = {
    source: {
      path: absPath,
      name: basename(absPath),
      maxCharsPerChunk: maxChars,
    },
    chunkCount: chunks.length,
    chunks,
    extracted,
  };

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
