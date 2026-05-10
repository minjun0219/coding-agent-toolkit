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

export async function parseSpecText(
  raw: string,
  hint: SpecFormat = "auto",
): Promise<ParsedSpec> {
  const parsed = parseStructured(raw);
  return parseSpecObject(parsed, hint);
}

export async function parseSpecObject(
  input: unknown,
  hint: SpecFormat = "auto",
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
    dereferenced = await SwaggerParser.dereference(
      structuredClone(openapi3) as never,
    );
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
