import type { RawNotionPage } from "./types";

/**
 * Notion 페이지 raw payload 를 markdown 문자열로 normalize 한다.
 *
 * 우선순위:
 *   1. payload.markdown 이 이미 존재하면 그대로 사용 (trim 만 적용)
 *   2. payload.blocks 가 있으면 type 별로 markdown 으로 변환
 *   3. 둘 다 없으면 빈 문자열 반환
 *
 * 지원하는 block type 은 MVP 범위 안에서 최소한만 처리한다:
 *   paragraph / heading_1 / heading_2 / heading_3 /
 *   bulleted_list_item / numbered_list_item / to_do / quote / code
 *
 * @param page Notion remote MCP 가 내려준 페이지 객체
 * @returns markdown 본문 문자열 (앞뒤 공백 제거)
 */
export function notionToMarkdown(page: RawNotionPage): string {
  if (page.markdown && page.markdown.trim().length > 0) {
    return page.markdown.trim();
  }

  if (!page.blocks || page.blocks.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const block of page.blocks) {
    const text = (block.text ?? "").trim();
    if (!text) continue;

    switch (block.type) {
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;
      case "to_do":
        lines.push(`- [ ] ${text}`);
        break;
      case "quote":
        lines.push(`> ${text}`);
        break;
      case "code":
        lines.push("```", text, "```");
        break;
      case "paragraph":
      default:
        lines.push(text);
        break;
    }
    // 블록 사이 빈 줄을 둬서 markdown 가독성을 확보한다.
    lines.push("");
  }

  return lines.join("\n").trim();
}
