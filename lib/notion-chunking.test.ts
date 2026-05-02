import { describe, expect, it } from "bun:test";
import { chunkNotionMarkdown, extractActionItems } from "./notion-chunking";

const SAMPLE = `# 문서 요약
주문 기능 개선을 위한 기획.

## 요구사항
- 사용자는 주문 목록을 페이지네이션으로 조회할 수 있어야 한다.
- 관리자는 필수로 주문 상태를 변경할 수 있어야 한다.

## 화면 단위
- 주문 목록 화면: 검색 폼, 상태 필터, 테이블, 페이지네이션 버튼

## API 의존성
- GET /api/orders
- PATCH /api/orders/{id}/status

## TODO
- [ ] 주문 목록 API 연동
- [ ] 상태 변경 모달 구현

## 확인 필요 사항
- 취소 상태에서 환불 상태로 바로 전환 가능한가?
`;

describe("chunkNotionMarkdown", () => {
  it("chunks by heading and keeps line metadata", () => {
    const chunks = chunkNotionMarkdown(SAMPLE, { maxCharsPerChunk: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]?.id).toBe("chunk-001");
    expect(chunks[0]?.startLine).toBeGreaterThan(0);
    expect(chunks[0]?.endLine).toBeGreaterThanOrEqual(chunks[0]?.startLine ?? 0);
  });
});

describe("extractActionItems", () => {
  it("extracts requirements/screens/apis/todos/questions", () => {
    const chunks = chunkNotionMarkdown(SAMPLE, { maxCharsPerChunk: 300 });
    const extracted = extractActionItems(chunks);
    expect(extracted.requirements.some((x) => x.text.includes("페이지네이션"))).toBe(true);
    expect(extracted.screens.some((x) => x.text.includes("주문 목록 화면"))).toBe(true);
    expect(extracted.apis.some((x) => x.text === "GET /api/orders")).toBe(true);
    expect(extracted.todos.some((x) => x.text.includes("주문 목록 API 연동"))).toBe(true);
    expect(extracted.questions.some((x) => x.text.includes("전환 가능한가"))).toBe(true);
  });
});
