---
name: openapi-client
description: Read a cached OpenAPI / Swagger spec under a cache-first policy and emit a `fetch` or `axios` call snippet (TypeScript) for one endpoint. Auto-trigger when the user supplies an OpenAPI spec URL, a 16-hex cache key, or a `host:env:spec` registry handle (configured in `agent-toolkit.json`) together with phrases like "이 endpoint 호출 코드 만들어줘" / "axios 로 작성해줘" / "fetch snippet 줘" / "POST /pets 호출 코드 / acme:dev:users 의 …".
allowed-tools: [openapi_get, openapi_status, openapi_refresh, openapi_search, openapi_envs]
license: MIT
version: 0.2.0
---

# openapi-client

## Role

* Locate a single endpoint inside a cached OpenAPI / Swagger JSON spec and emit a TypeScript call snippet using either `fetch` (default) or `axios`, with path / query / body parameters and a response type when the spec defines one.
* Single endpoint, single spec at a time. The skill does not generate full SDKs, mock servers, or multi-spec merges.

## Mental model

```
agent (you)
  ├── 0. openapi_envs           ← list registered host:env:spec handles (no remote call)
  ├── 1. openapi_status         ← cache metadata only (no remote call)
  ├── 2. openapi_get            ← cache hit → spec / miss → GET URL + JSON-validate + cache write (one shot)
  ├── 3. openapi_search         ← search across cached specs (optionally scoped) to locate the endpoint
  └── 4. openapi_refresh        ← only when the user explicitly asks for "최신화" / refresh
```

The cache is a thin TTL layer in front of the spec URL. `openapi_get` already handles cache miss by downloading the spec, validating its shape (`openapi` 3.x or `swagger` 2.x), and persisting it — no separate write step is needed. JSON-only in this version: YAML specs throw, document the limitation when the user hits it.


## Inputs

`openapi_get` / `openapi_status` / `openapi_refresh` accept any of:

- **Spec URL** (`https://…` or `file://…`) — direct download source.
- **16-hex cache key** — disk key returned by `openapi_status` / `openapi_search`. Resolves via cache metadata; when the metadata is gone, the tool throws with a clear "no recoverable spec URL" message.
- **`host:env:spec` handle** — symbolic name registered in `agent-toolkit.json` (`./.opencode/agent-toolkit.json` overrides `~/.config/opencode/agent-toolkit/agent-toolkit.json`). Resolves to a spec URL via the registry. Unregistered handles throw.

`openapi_search` accepts an optional `scope`:

- **`host`** — search inside every spec under one host
- **`host:env`** — search inside one environment
- **`host:env:spec`** — search inside one spec
- **omitted** — search across every cached spec

Use `openapi_envs` first when the user does not name a specific handle but talks about "이 환경 / 그 spec".

## Tool usage rules

1. Reach OpenAPI specs only through `openapi_get` / `openapi_refresh` / `openapi_status` / `openapi_search` / `openapi_envs`. No direct `fetch`, Read, or Bash to download the spec yourself.
2. Unless the user explicitly asks to refresh ("최신화" / "refresh"):
   * Check cache state first with `openapi_status` when the input (URL / key / handle) is given.
   * When `exists=true && expired=false`, use `openapi_get` (it returns instantly from cache) and `openapi_search` to locate the endpoint.
   * Otherwise call `openapi_get` once — it hits the remote on cache miss automatically.
3. Do not download the same spec more than once per turn. Reuse the spec object you already have.
4. Use `openapi_refresh` only when the user explicitly asks to re-download.
5. **Prefer `host:env:spec` handles when the user works with multiple environments.** Resolve the user's environment / service intent by calling `openapi_envs` once, presenting the matching handles, and asking which one when ambiguous. Pass the handle as-is to the openapi_* tools — never expand it to a URL yourself.
6. **Use `openapi_search` `scope` when the user has multiple environments cached.** A scope of `acme:dev` keeps results inside that environment. When the user does not name an environment, leave `scope` off and search across everything.

## Locating the endpoint

Given an ambiguous request ("POST /pets 호출 코드 만들어줘"):

1. When the user already gave a spec URL / 16-hex key / `host:env:spec` handle, run `openapi_get` for that input, then look up the endpoint by `(method, path)` in `spec.paths`.
2. When the user names an environment but not a specific spec ("acme:dev 의 POST /pets"), call `openapi_envs` once, identify the matching specs under that scope, and run `openapi_search` with `scope: "acme:dev"`. When multiple candidates remain, surface them (`specTitle` + `method path` + `summary`) and ask the user which one.
3. Otherwise use `openapi_search` (no scope) with the path and/or operationId substring across every cached spec. When multiple matches come back, surface the candidates and ask the user which one — including the `specTitle` so the environment / service is clear.
4. When zero matches come back, do not invent the endpoint — quote what you searched for and ask the user to clarify the spec, environment, or path.

## Output format — fetch snippet (default)

```ts
// <method> <path> — <summary if present>
// spec: <specTitle> @ <specUrl>
type <PascalCaseOperationId>Response = /* response shape from spec, or `unknown` if not declared */;

export async function <camelCaseOperationId>(
  // path params, then query, then body — only ones the spec declares
): Promise<<PascalCaseOperationId>Response> {
  const url = `${BASE_URL}<path with ${pathParam} substitutions>`;
  const res = await fetch(url, {
    method: "<METHOD>",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: /* JSON.stringify(body) when there is a body, else undefined */,
  });
  if (!res.ok) {
    throw new Error(`<operationId> failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<<PascalCaseOperationId>Response>;
}

// Example
// const u = await <camelCaseOperationId>(/* … */);
```

## Output format — axios snippet (on request)

```ts
// <method> <path> — <summary if present>
// spec: <specTitle> @ <specUrl>
import axios from "axios";

type <PascalCaseOperationId>Response = /* … */;

export async function <camelCaseOperationId>(
  // path params, then query, then body
): Promise<<PascalCaseOperationId>Response> {
  const { data } = await axios.<method-lowercase>(
    `${BASE_URL}<path>`,
    /* body OR config — depends on method */,
  );
  return data as <PascalCaseOperationId>Response;
}
```

## Writing rules

* The skill's user-facing answer (the prose around the snippet) is in Korean; the generated code is in English / TypeScript with English identifiers — no translation of operationIds or paths.
* Use `operationId` to derive both the function name (camelCase) and response type (PascalCase). When `operationId` is absent, fall back to `<method>_<path-slug>` and call this out in one sentence.
* Path parameters → required positional args, in spec declaration order.
* Query parameters → one trailing `query?: { … }` arg with optional fields by default; required ones explicitly typed as required.
* Request body → one trailing `body: <type>` arg when the operation declares a body; type pulled from `requestBody.content["application/json"].schema` if present, else `unknown`.
* Response type → from the first `2xx` response's `application/json` schema. When the spec does not declare it, type as `unknown` and say so in one inline comment.
* `BASE_URL` is a placeholder constant; do not bake a hostname into the snippet.

## Do NOT

* Do not download a spec without going through the `openapi_*` tools — that defeats the cache and skips the shape validation.
* Do not generate code for an endpoint that is not present in the cached spec — quote the search query and ask.
* Do not invent a response or body type. When the spec does not declare it, use `unknown` and surface the gap in one inline comment.
* Do not paste the entire spec into the answer. The user wants one snippet plus a usage line.
* Do not assume YAML support. When `openapi_get` rejects with a non-JSON body, tell the user the spec is YAML and that this skill is JSON-only in MVP.
* Do not silently pick an environment when the user has more than one (`acme:dev`, `acme:staging`, …). Ask which one before running `openapi_get`.
* Do not invent registry handles. When a handle is not in `openapi_envs`, surface the available handles and ask the user to pick — do not guess "this looks like dev so I'll try `acme:dev`".

## Failure / error handling

* `openapi_get` throws on timeout / network error / non-JSON body / missing `openapi` / `swagger` field → surface the error in one sentence and ask the user to verify the spec URL and `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS`.
* `openapi_get` / `openapi_status` throws when a `host:env:spec` handle is unregistered → ask the user to add it under `openapi.registry` in `agent-toolkit.json`, or quote the available handles from `openapi_envs`.
* `openapi_search` throws on a scope that matches no entries (typo in `host` / `host:env`) → quote the scope and the available handles from `openapi_envs`, ask the user to correct it.
* `openapi_search` returns 0 matches with a valid scope → quote the query and ask which spec / path, do not hallucinate.
* The endpoint exists but lacks `operationId` / response schema → emit the snippet with the documented fallback (path-slug name, `unknown` response) and call out the gap in one inline comment.
