import SwaggerParser from "@apidevtools/swagger-parser";
import yaml from "js-yaml";
import type { OpenAPIV3 } from "openapi-types";
import type { SpecFormat } from "./schema";

/**
 * spec 본문 (raw text 또는 이미 parse 된 object) 을 받아서:
 *   1. JSON / YAML 디스패치
 *   2. 형식 감지 (`detectFormat`) — hint 가 있으면 강제, 없으면 본문의 `openapi` /
 *      `swagger` 필드를 본다
 *   3. swagger 2.0 이면 `swagger2openapi` 로 OpenAPI 3.0 변환
 *   4. SwaggerParser.dereference 로 `$ref` 제거
 *
 * 결과는 OpenAPI 3.x document + 감지된 원본 형식.
 */

export class SpecParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SpecParseError";
  }
}

export interface ParsedSpec {
  document: OpenAPIV3.Document;
  detectedFormat: "openapi3" | "swagger2";
}

/**
 * 옵션의 `sourceLocation` 은 spec 의 원본 절대 경로 (file://) 또는 URL — 외부 /
 * 상대 `$ref` (`./components.yaml#/...` 등) 를 SwaggerParser 가 정확한 base 위에서
 * resolve 하기 위해 필요하다. 미지정이면 SwaggerParser 가 process.cwd() 를 base 로
 * 떨어뜨리므로 외부 ref 가 있는 spec 은 깨질 수 있다.
 */
export interface ParseSpecOptions {
  /** 원본 spec 의 절대 경로 또는 URL (외부 / 상대 `$ref` resolve base). */
  sourceLocation?: string;
}

export async function parseSpecText(
  raw: string,
  hint: SpecFormat = "auto",
  options: ParseSpecOptions = {},
): Promise<ParsedSpec> {
  const parsed = parseStructured(raw);
  return parseSpecObject(parsed, hint, options);
}

export async function parseSpecObject(
  input: unknown,
  hint: SpecFormat = "auto",
  options: ParseSpecOptions = {},
): Promise<ParsedSpec> {
  if (input === null || typeof input !== "object") {
    throw new SpecParseError("spec root must be an object");
  }
  const detected = detectFormat(input, hint);

  let openapi3: object;
  if (detected === "swagger2") {
    openapi3 = await convertSwagger2(input);
  } else {
    openapi3 = input;
  }

  let dereferenced: unknown;
  try {
    // SwaggerParser.dereference 의 3-arg 시그니처: (path, api, options).
    // path 를 함께 넘기면 swagger-parser 가 외부 / 상대 `$ref` 를 그 base 에서
    // resolve 한다 — api 는 이미 파싱된 객체이므로 path 가 다시 fetch 되지는 않는다.
    // sourceLocation 이 없는 경우 (raw text 로만 들어온 경우) 는 1-arg 폴백.
    const cloned = structuredClone(openapi3) as never;
    if (options.sourceLocation) {
      dereferenced = await SwaggerParser.dereference(
        options.sourceLocation,
        cloned,
        {} as never,
      );
    } else {
      dereferenced = await SwaggerParser.dereference(cloned);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SpecParseError(`failed to dereference spec: ${reason}`, err);
  }

  return {
    document: dereferenced as OpenAPIV3.Document,
    detectedFormat: detected,
  };
}

function parseStructured(raw: string): unknown {
  const trimmed = raw.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      try {
        return yaml.load(raw);
      } catch {
        throw new SpecParseError("spec is neither valid JSON nor YAML", err);
      }
    }
  }
  try {
    return yaml.load(raw);
  } catch (err) {
    throw new SpecParseError("failed to parse spec as YAML", err);
  }
}

function detectFormat(doc: object, hint: SpecFormat): "openapi3" | "swagger2" {
  const hasOpenApi3 =
    hasStringField(doc, "openapi") &&
    /^3\./.test((doc as Record<string, unknown>).openapi as string);
  const hasSwagger2 =
    hasStringField(doc, "swagger") &&
    /^2\./.test((doc as Record<string, unknown>).swagger as string);

  if (hint === "openapi3") {
    if (!hasOpenApi3) {
      throw new SpecParseError(
        "format=openapi3 declared but document is not OpenAPI 3.x",
      );
    }
    return "openapi3";
  }
  if (hint === "swagger2") {
    if (!hasSwagger2) {
      throw new SpecParseError(
        "format=swagger2 declared but document is not Swagger 2.x",
      );
    }
    return "swagger2";
  }

  if (hasOpenApi3) return "openapi3";
  if (hasSwagger2) return "swagger2";
  throw new SpecParseError(
    "spec is missing both 'openapi' and 'swagger' version fields; cannot detect format",
  );
}

function hasStringField(doc: object, field: string): boolean {
  const value = (doc as Record<string, unknown>)[field];
  return typeof value === "string";
}

async function convertSwagger2(input: object): Promise<object> {
  const { default: converter } = await import("swagger2openapi");
  return new Promise((resolve, reject) => {
    converter.convertObj(
      input as Parameters<typeof converter.convertObj>[0],
      { patch: true, warnOnly: true },
      (err, result) => {
        if (err) {
          reject(
            new SpecParseError(
              `swagger 2.0 → 3.0 conversion failed: ${err.message}`,
              err,
            ),
          );
          return;
        }
        resolve(result.openapi as object);
      },
    );
  });
}
