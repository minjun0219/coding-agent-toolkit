# Review instructions

This file is the highest-priority instruction block for Claude Code Code Review on this repo. It overrides `CLAUDE.md` and `AGENTS.md` where they conflict. Write every review comment in Korean — keep code identifiers, paths, and commands in English (see `AGENTS.md` "Output / communication").

## Comment format

- Open the summary with a one-line tally: `🔴 N important / 🟡 M nit / 🟣 K pre-existing`. If there are zero important findings, lead with "중요 이슈 없음".
- Each inline comment is three bullets: `문제 / 영향 / 제안`. Include a directly applicable fix snippet when possible.

## What 🔴 Important means here

Reserve Important for the categories below. Everything else is Nit at most.

- **MVP scope violation**: a change that pulls in anything listed under *Out* in `AGENTS.md` "MVP scope" — YAML OpenAPI parsing, multi-spec merge, mock servers, multi-host plugin layouts, OAuth, Notion child pages, journal TTL / summarization / embeddings, Rocky running multi-step implementation directly, and so on.
- **Public contract break**: input/output shape of any of the twelve plugin tools (`notion_*` / `swagger_*` / `journal_*`), `rocky` routing, or the usage rules of the two skills (`notion-context`, `openapi-client`).
- **Lockstep drift**: `agent-toolkit.json` shape changed but `agent-toolkit.schema.json` and `lib/toolkit-config.ts` are not both updated in sync.
- **Doc-sync miss**: a user-facing surface (tools / env vars / handle format) changed but `README.md` / `.opencode/INSTALL.md` did not follow; a new env var that was not added to the plugin's `readEnv()`; a plugin tool contract change without the matching update in the relevant skill or `agents/rocky.md`.
- **Runtime safety violation**: `__dirname` (forbidden under ESM — use `import.meta.url` / `import.meta.dir`), `.js` / `.ts` extensions on imports, or any Node-only API that breaks the Bun-only runtime assumption.
- **Errors and secrets**: secrets / tokens / Notion auth-flow data leaking into logs; error messages missing identifying context (input value, timeout, status code, pageId mismatch, …); fs paths built from external input without normalization / sanitization.
- **Journal integrity**: any change that breaks the append-only / corruption-tolerant contract — read throwing on a malformed line, mutating existing lines, introducing TTL, etc.
- **Dependency add**: a new runtime dep in `package.json` when the standard library or a Bun built-in would do, or an add without justification.

## 🟡 Nit (cap 5 per review)

Style, naming, minor JSDoc gaps, test-file location (`*.test.ts` must sit next to the source it covers), missing `mkdtempSync` isolation in fs-touching tests, and small readability improvements are all Nit. Post at most five inline; collapse the rest into the summary as `유사 항목 N 개 더`.

## Do not report

- gitignored files: `bun.lock`, `node_modules/`, `dist/`, `*.tsbuildinfo`, `.env*`.
- Type errors and test failures already caught by `bun run typecheck` / `bun test` — CI handles those. Exception: if a new module under `lib/` ships without an adjacent `*.test.ts`, report that as a Nit.
- A PR that *was explicitly asked* to pull in a `ROADMAP.md` phase item is not, by that fact alone, an MVP-scope violation — the scope expansion is part of the request.

## Always check

- Each item in `AGENTS.md` "Change checklist" is satisfied for the surfaces this PR touches.
- New exported functions / classes carry JSDoc.
- Error messages include identifying context.
- User-facing text (`README.md`, `.opencode/INSTALL.md`, `skills/*/SKILL.md`, `agents/rocky.md`) matches the changed tools / env vars / handle formats.

## Citation bar

Behavior claims ("this code does X") need a `path:line` citation in the source, not an inference from naming. Do not raise an Important finding from naming alone.

## Re-review convergence

From the second review of the same PR onward, do not post new Nits — only Important and any newly introduced Pre-existing findings. Trust that resolved threads from the previous review auto-close when the underlying code is fixed.
