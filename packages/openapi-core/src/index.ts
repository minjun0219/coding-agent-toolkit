/**
 * openapi-core public surface — three downstream consumers share this barrel:
 *
 *   - `@minjun0219/agent-toolkit-claude-code` (Claude Code plugin)
 *   - `@minjun0219/agent-toolkit-opencode` (opencode plugin)
 *   - `openapi-mcp` (standalone stdio CLI)
 *
 * The standalone CLI uses a different config shape (`openapi-mcp.json`,
 * mapped through `./schema`'s `OpenApiMcpConfig`) and registers its own
 * tools directly against `SpecRegistry`. The two plugin hosts share the
 * 7 `openapi_*` tool handlers via `./handlers`.
 */
// Plugin hosts (Claude Code + opencode) consume this barrel — they want the
// agent-toolkit.json `loadConfig` from `./toolkit-config`. The standalone
// openapi-mcp CLI loads the openapi-mcp.json `loadConfig` directly via
// `@minjun0219/openapi-core/config-loader`, so the barrel intentionally hides
// that file's same-named symbol to avoid an ambiguous re-export.
export * from "./adapter";
export * from "./cache";
export * from "./fetcher";
export * from "./filter";
export * from "./handlers";
export * from "./indexer";
export * from "./logger";
export * from "./openapi-registry";
export * from "./parser";
export * from "./registry";
export * from "./schema";
export * from "./toolkit-config";
export * from "./url";
