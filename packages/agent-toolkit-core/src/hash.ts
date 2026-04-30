import { createHash } from "node:crypto";

/**
 * 문자열의 sha256 해시 앞 16자를 반환한다.
 * 캐시 무결성 비교용이라 짧게 자른다.
 *
 * @param content 해시 대상 문자열
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}
