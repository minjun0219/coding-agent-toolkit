---
name: openapi-client
description: Read a cached OpenAPI / Swagger spec under a cache-first policy and emit a `fetch` or `axios` call snippet (TypeScript) for one endpoint. Auto-trigger when the user supplies an OpenAPI spec URL or 16-hex spec key together with phrases like "이 endpoint 호출 코드 만들어줘" / "axios 로 작성해줘" / "fetch snippet 줘" / "POST /pets 호출 코드".
allowed-tools: [swagger_get, swagger_status, swagger_refresh, swagger_search]
license: MIT
version: 0.1.0
---

# openapi-client

## Role

* Locate a single endpoint inside a cached OpenAPI / Swagger JSON spec and emit a TypeScript call snippet using either `fetch` (default) or `axios`, with path / query / body parameters and a response type when the spec defines one.
* Single endpoint, single spec at a time. The skill does not generate full SDKs, mock servers, or multi-spec merges.

## Mental model

```
agent (you)
  ├── 1. swagger_status         ← cache metadata only (no remote call)
  ├── 2. swagger_get            ← cache hit → spec / miss → GET URL + JSON-validate + cache write (one shot)
  ├── 3. swagger_search         ← search across cached specs to locate the endpoint
  └── 4. swagger_refresh        ← only when the user explicitly asks for "최신화" / refresh
```

The cache is a thin TTL layer in front of the spec URL. `swagger_get` already handles cache miss by downloading the spec, validating its shape (`openapi` 3.x or `swagger` 2.x), and persisting it — no separate write step is needed. JSON-only in this version: YAML specs throw, document the limitation when the user hits it.

## Tool usage rules

1. Reach OpenAPI specs only through `swagger_get` / `swagger_refresh` / `swagger_status` / `swagger_search`. No direct `fetch`, Read, or Bash to download the spec yourself.
2. Unless the user explicitly asks to refresh ("최신화" / "refresh"):
   * Check cache state first with `swagger_status` when the spec URL or key is given.
   * If `exists=true && expired=false`, use `swagger_get` (it returns instantly from cache) and `swagger_search` to locate the endpoint.
   * Otherwise call `swagger_get` once — it will hit the remote on cache miss automatically.
3. Do not download the same spec more than once per turn. Reuse the spec object you already have.
4. Use `swagger_refresh` only when the user explicitly asks to re-download.
5. `swagger_search` spans **every cached spec**. When the user has multiple specs cached and wants results from one, scope by passing a more specific query (e.g. include the spec title or a unique path prefix).

## Locating the endpoint

Given an ambiguous request ("POST /pets 호출 코드 만들어줘"):

1. If the user already gave a spec URL / 16-hex key, run `swagger_get` for that spec, then look up the endpoint by `(method, path)` in `spec.paths`.
2. Otherwise use `swagger_search` with the path and/or operationId substring. If multiple matches come back, surface the candidates (`specTitle` + `method path` + `summary`) and ask the user which one.
3. If zero matches, do not invent the endpoint — quote what you searched for and ask the user to clarify the spec or the path.

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

* The body of the SKILL output (this skill's user-facing answer) is in Korean; the generated code is in English / TypeScript with English identifiers — no translation of operationIds or paths.
* Use `operationId` to derive both the function name (camelCase) and response type (PascalCase). If `operationId` is absent, fall back to `<method>_<path-slug>` and call this out in one sentence.
* Path parameters → required positional args, in spec declaration order.
* Query parameters → one trailing `query?: { … }` arg with optional fields by default; required ones explicitly typed as required.
* Request body → one trailing `body: <type>` arg when the operation declares a body; type pulled from `requestBody.content["application/json"].schema` if present, else `unknown`.
* Response type → from the first `2xx` response's `application/json` schema. If the spec does not declare it, type as `unknown` and say so in one inline comment.
* `BASE_URL` is a placeholder constant; do not bake a hostname into the snippet.

## Do NOT

* Do not download a spec without going through the `swagger_*` tools — that defeats the cache and skips the shape validation.
* Do not generate code for an endpoint that is not present in the cached spec — quote the search query and ask.
* Do not invent a response or body type. If the spec does not declare it, use `unknown` and surface the gap in one inline comment.
* Do not paste the entire spec into the answer. The user wants one snippet plus a usage line.
* Do not assume YAML support. If `swagger_get` rejects with a non-JSON body, tell the user the spec is YAML and that this skill is JSON-only in MVP.

## Failure / error handling

* `swagger_get` throws on timeout / network error / non-JSON body / missing `openapi` / `swagger` field → surface the error in one sentence and ask the user to verify the spec URL and `AGENT_TOOLKIT_OPENAPI_DOWNLOAD_TIMEOUT_MS`.
* `swagger_search` returns 0 matches → quote the query and ask which spec / path, do not hallucinate.
* The endpoint exists but lacks `operationId` / response schema → emit the snippet with the documented fallback (path-slug name, `unknown` response) and call out the gap in one inline comment.
