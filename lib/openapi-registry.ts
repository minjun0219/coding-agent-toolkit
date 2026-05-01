import { ID_BODY, type OpenapiRegistry, type ToolkitConfig } from "./toolkit-config";

/**
 * `agent-toolkit.json` 의 `openapi.registry` 트리를 다루는 helper 모음.
 *
 * 입력 표기:
 *   - `host`            — 한 host 아래의 모든 spec
 *   - `host:env`        — 한 host 의 한 env 아래의 모든 spec
 *   - `host:env:spec`   — 정확히 한 spec
 *
 * 식별자는 `agent-toolkit.schema.json` 의 패턴(`^[a-zA-Z0-9_-]+$`)을 따라야 한다 — 콜론은
 * separator 로 예약. 등록되지 않은 handle 은 lookup 실패 시 명확한 에러로 거부한다.
 */

/** 평면화된 한 항목. listRegistry 의 결과 row. */
export interface OpenapiRegistryEntry {
  host: string;
  env: string;
  spec: string;
  url: string;
}

// 식별자 본문은 toolkit-config 의 ID_BODY 와 동일해야 한다 (스키마 / config 검증과 동기).
// drift 방지를 위해 한 곳 (`ID_BODY`) 만 두고 여기서는 그걸로 핸들 / 스코프 정규식을 합성.
const HANDLE_FULL = new RegExp(`^(${ID_BODY}):(${ID_BODY}):(${ID_BODY})$`);
const HANDLE_HOST_ENV = new RegExp(`^(${ID_BODY}):(${ID_BODY})$`);
const HANDLE_HOST = new RegExp(`^${ID_BODY}$`);
const HEX_KEY = /^[0-9a-f]{16}$/;

/** 입력이 정확히 `host:env:spec` 형태인지. */
export function isFullHandle(s: string): boolean {
  return HANDLE_FULL.test(s);
}

/** `host`, `host:env`, `host:env:spec` 중 하나라도 맞는지. 16-hex 키와 URL 은 false. */
export function isScope(s: string): boolean {
  if (!s || HEX_KEY.test(s)) return false;
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("file://")) {
    return false;
  }
  return HANDLE_FULL.test(s) || HANDLE_HOST_ENV.test(s) || HANDLE_HOST.test(s);
}

/**
 * 정확한 `host:env:spec` handle 을 단일 URL 로 해석.
 * handle 이 형식에 맞지 않거나 등록 안 되어 있으면 throw — 메시지에 handle 을 포함.
 */
export function resolveHandleToUrl(
  handle: string,
  registry: OpenapiRegistry | undefined,
): string {
  const m = HANDLE_FULL.exec(handle);
  if (!m) {
    throw new Error(
      `Not a host:env:spec handle: "${handle}" (expected three colon-separated identifiers)`,
    );
  }
  const [, host, env, spec] = m as unknown as [string, string, string, string];
  const url = registry?.[host]?.[env]?.[spec];
  if (!url) {
    throw new Error(
      `Handle "${handle}" not found in openapi.registry. Check ./.opencode/agent-toolkit.json or ~/.config/opencode/agent-toolkit/agent-toolkit.json.`,
    );
  }
  return url;
}

/**
 * scope (`host` / `host:env` / `host:env:spec`) 를 매칭되는 URL 리스트로 풀어 준다.
 * 매칭 0 건이면 빈 배열. handle 형식에 안 맞으면 빈 배열 — caller 가 의도하지 않은 스코프를
 * 안전하게 무시한다.
 */
export function resolveScopeToUrls(
  scope: string,
  registry: OpenapiRegistry | undefined,
): string[] {
  if (!registry || !scope) return [];
  if (HANDLE_FULL.test(scope)) {
    try {
      return [resolveHandleToUrl(scope, registry)];
    } catch {
      return [];
    }
  }
  const fullEnv = HANDLE_HOST_ENV.exec(scope);
  if (fullEnv) {
    const [, host, env] = fullEnv as unknown as [string, string, string];
    const specs = registry[host]?.[env];
    return specs ? Object.values(specs) : [];
  }
  if (HANDLE_HOST.test(scope)) {
    const envs = registry[scope];
    if (!envs) return [];
    const out: string[] = [];
    for (const env of Object.values(envs)) {
      for (const url of Object.values(env)) out.push(url);
    }
    return out;
  }
  return [];
}

/** registry 트리를 평면 (host, env, spec, url) 리스트로 펼친다 — `swagger_envs` 의 출력 그대로. */
export function listRegistry(config: ToolkitConfig): OpenapiRegistryEntry[] {
  const reg = config.openapi?.registry ?? {};
  const out: OpenapiRegistryEntry[] = [];
  for (const [host, envs] of Object.entries(reg)) {
    for (const [env, specs] of Object.entries(envs)) {
      for (const [spec, url] of Object.entries(specs)) {
        out.push({ host, env, spec, url });
      }
    }
  }
  return out;
}
