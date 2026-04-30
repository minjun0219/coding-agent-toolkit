/**
 * Notion page id / url 로부터 캐시에 사용할 정규화된 key 와 pageId 를 만든다.
 *
 * 입력 예시:
 *   - "1234abcd1234abcd1234abcd1234abcd"
 *   - "1234abcd-1234-abcd-1234-abcd1234abcd"
 *   - "https://www.notion.so/Some-Title-1234abcd1234abcd1234abcd1234abcd"
 *   - "https://www.notion.so/workspace/Some-Title-1234abcd1234abcd1234abcd1234abcd?pvs=4"
 *
 * 반환되는 key 는 디스크 파일명으로도 안전한 dash 포함 32자 hex 형식.
 *
 * @param input page id 또는 Notion URL
 * @returns { pageId, key } 형태의 정규화 결과
 * @throws 입력에서 page id 를 추출하지 못한 경우
 */
export function resolveCacheKey(input: string): { pageId: string; key: string } {
  if (!input || typeof input !== "string") {
    throw new Error("resolveCacheKey: input must be a non-empty string");
  }

  const trimmed = input.trim();

  // URL 또는 raw id 양쪽에서 32자 hex 묶음을 찾는다.
  // dash 포함 형태(8-4-4-4-12) 와 dash 없는 32자 형태 모두 허용.
  const hexNoDash = trimmed.match(/[0-9a-fA-F]{32}/);
  const hexWithDash = trimmed.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );

  let raw: string | undefined;
  if (hexWithDash) {
    raw = hexWithDash[0].replace(/-/g, "");
  } else if (hexNoDash) {
    raw = hexNoDash[0];
  }

  if (!raw || raw.length !== 32) {
    throw new Error(
      `resolveCacheKey: cannot extract Notion page id from input "${input}"`,
    );
  }

  const lower = raw.toLowerCase();
  const pageId = `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(
    12,
    16,
  )}-${lower.slice(16, 20)}-${lower.slice(20)}`;

  // 파일명에는 dash 그대로 두는 편이 디버깅에 유리.
  return { pageId, key: pageId };
}
