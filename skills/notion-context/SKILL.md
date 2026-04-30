---
name: notion-context
description: Notion 페이지를 캐시 우선 정책으로 읽어 LLM 컨텍스트로 쓰거나 한국어 스펙(요약/요구사항/화면/API/TODO/확인 필요)으로 정리한다. URL 또는 page id 와 함께 "스펙 정리해줘" / "요구사항 뽑아줘" / "Notion 페이지 X 가 Y 에 대해 뭐라고 하는지" 같은 요청 시 자동 트리거.
allowed-tools: [notion_get, notion_status, notion_refresh]
license: MIT
version: 0.2.0
---

# notion-context

## 역할

* Notion 단일 페이지를 **캐시 우선** 정책으로 읽어 LLM 에 그대로 컨텍스트로 넘기거나, 구조화된 한국어 스펙으로 정리한다.
* child page / database 는 다루지 않는다.

## Mental model

```
agent (you)
  ├── 1. notion_status         ← 캐시 메타만 조회 (remote 호출 없음)
  ├── 2. notion_get            ← cache hit 즉시 markdown / miss 면 remote MCP fetch + 캐시 기록 (한 번에)
  └── 3. notion_refresh        ← 사용자가 명시적으로 "최신화" 를 요청한 경우에만
```

진실의 원천은 Notion. 캐시는 같은 페이지를 한 turn 안에서 두 번 이상 remote 까지 가지 않게 막아 주는 layer 다. `notion_get` 이 cache miss 시 remote fetch + 정규화 + 저장까지 한 번에 처리하므로 별도의 `put` / 수동 동기화 단계는 없다.

## 도구 사용 규칙

1. Notion 접근은 반드시 `notion_get` / `notion_refresh` / `notion_status` 도구로만 한다. 다른 경로(직접 fetch, Read, Bash, MCP 직접 호출) 금지.
2. 사용자가 명시적으로 "최신화" / "refresh" 를 요청하지 않는 한:
   * 먼저 `notion_status` 로 캐시 상태를 확인.
   * `exists=true && expired=false` 면 `notion_get` 으로만 읽는다 (재조회 / refresh 금지).
   * 그 외에는 `notion_get` 호출 (도구가 알아서 cache miss 면 remote 를 친다).
3. 같은 페이지를 한 turn 안에서 두 번 이상 fetch 하지 않는다. 이미 받은 markdown 은 재사용.
4. 사용자가 "최신화" / "force refresh" 를 요청한 경우에만 `notion_refresh` 를 사용한다.
5. `input` 인자에는 사용자가 준 page id 또는 Notion URL 원문을 그대로 넘긴다 — 도구가 정규화한다.

## Freshness policy

* **Default**: turn 동안은 캐시를 신뢰한다.
* **Mutating workflow** (사용자가 방금 페이지를 편집했다고 말하거나 "최신인지 확인" 을 직접 요구) 에만 `notion_refresh` 호출.
* `notion_status` 의 `expired=true` 는 자동 refresh 신호가 아니다 — 다음 `notion_get` 호출 시 도구가 자연스럽게 remote 를 한 번 더 친다.
* 동일 페이지에서 `fromCache: false` 가 떴다고 해서 곧이어 다시 부르지 말 것 — 같은 결과만 받는다.

## 출력 포맷 — 스펙 정리 모드 (한국어, 항상 이 순서)

사용자가 "스펙 정리" / "요구사항 뽑아줘" / "스펙 만들어줘" 류로 요청한 경우에만 적용. 단순히 "이 페이지 뭐라고 적혀 있어" 같은 grounding 질의에는 markdown 본문을 그대로 인용 / 요약하면 된다.

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

## 하지 말 것

* **매 turn 마다 remote 를 치지 말 것** — 캐시 우선 정책이 존재하는 이유다.
* `notion_status` 가 `exists=true && expired=false` 인데 `notion_refresh` 를 부르지 말 것 — 같은 본문을 다시 받을 뿐이다.
* Page id / URL 을 추측하지 말 것. 사용자 입력에서 추출되지 않으면 입력값을 그대로 인용해 다시 묻는다.
* 문서에 없는 내용을 본문 / 요구사항 / API 에 적지 말 것 — 요점은 "확인 필요 사항" 으로만 옮긴다.
* `notion_get` 으로 받은 markdown 을 임의로 잘라 LLM 에 넘기기 전에, 페이지가 길면 핵심 섹션 위주로 요약해 사용. 통째로 throw 하지 말 것.

## 실패 / 예외 처리

* `notion_get` 이 timeout / 네트워크 오류 / 잘못된 응답으로 throw 하면, 사용자에게 환경변수(`AGENT_TOOLKIT_NOTION_MCP_URL`, `AGENT_TOOLKIT_NOTION_MCP_TIMEOUT_MS` 등) 설정과 remote MCP 가용성을 명확히 묻고 멈춘다.
* page id 가 추출되지 않으면 입력값을 그대로 인용해 다시 요청한다.
* 페이지가 비어 있으면 "문서 요약" 섹션에 "본문이 비어 있음" 만 적고 나머지는 비워둔다.
