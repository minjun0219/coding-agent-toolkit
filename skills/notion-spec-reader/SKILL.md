---
name: notion-spec-reader
description: Notion 페이지를 캐시 우선 정책으로 읽고 한국어 스펙(요약/요구사항/화면/API/TODO/확인 필요)으로 정리한다. URL 이나 page id 와 함께 "스펙 정리해줘" / "요구사항 뽑아줘" 같은 요청 시 자동 트리거.
allowed-tools: [notion_get, notion_status, notion_refresh]
license: MIT
version: 0.1.0
---

# notion-spec-reader

## 역할

* 주어진 Notion 페이지를 **`notion_*` 도구를 통해서만** 읽어 구조화된 한국어 스펙으로 정리한다.
* 단일 page 만 처리한다. child page / database 는 다루지 않는다.

## 도구 사용 규칙

1. Notion 접근은 반드시 `notion_get` / `notion_refresh` / `notion_status` 도구로만 한다. 다른 경로(직접 fetch, Read, Bash) 금지.
2. 사용자가 명시적으로 "최신화" / "refresh" 를 요청하지 않는 한:
   * 먼저 `notion_status` 로 캐시 상태를 확인.
   * `exists=true && expired=false` 면 `notion_get` 으로만 읽는다 (재조회 금지).
   * 그 외에는 `notion_get` 호출 (도구가 알아서 cache miss 면 remote 를 친다).
3. 같은 페이지를 한 turn 안에서 두 번 이상 fetch 하지 않는다. 이미 받은 markdown 은 재사용.
4. 사용자가 "최신화" 를 요청한 경우에만 `notion_refresh` 를 사용한다.

## 출력 포맷 (한국어, 항상 이 순서)

```
# 문서 요약
한 단락. 이 문서가 무엇이고 어떤 맥락에서 쓰이는지 설명.

# 요구사항
- 필요/불필요/모호 를 구분해 bullet 으로 정리.
- 각 항목은 1줄.

# 화면 단위
- 화면명 — 설명
  - 주요 컴포넌트 / 동작 / 상태 전이

# API 의존성
- METHOD /path — 호출 시점, 요청/응답 핵심 필드

# TODO
- 구현 관점에서 즉시 착수 가능한 작업 단위 bullet.

# 확인 필요 사항
- 문서만 읽고는 단정할 수 없는 항목을 질문 형태로 정리.
```

## 작성 규칙

* 모든 본문은 **한국어**로 작성. 영문 식별자 / API path / 라이브러리 이름은 그대로 둔다.
* 추측 금지. 문서에 없는 내용은 "확인 필요 사항" 섹션으로만 옮긴다.
* 하나의 문장은 짧게. 한 bullet 은 한 가지 사실만.
* 코드/식별자는 `inline code` 로 감싼다.
* "일단 ~로 가정", "아마도" 같은 헷지 표현은 쓰지 않는다.

## 실패/예외 처리

* `notion_get` 이 timeout / 네트워크 오류 / 잘못된 응답으로 throw 하면, 사용자에게 환경변수(`AGENT_TOOLKIT_NOTION_MCP_URL` 등) 설정과 remote MCP 가용성을 명확히 묻고 멈춘다.
* page id 가 추출되지 않으면 입력값을 그대로 인용해 다시 요청한다.
* 페이지가 비어 있으면 "문서 요약" 섹션에 "본문이 비어 있음" 만 적고 나머지는 비워둔다.
