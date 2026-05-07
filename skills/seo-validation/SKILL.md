---
name: seo-validation
description: Validate Open Graph / Twitter Card / JSON-LD / favicon metadata for a single URL using the `seo_validate` plugin tool (powered by the `ogpeek` library). Auto-trigger when the user supplies a URL together with phrases like "OG 메타", "OpenGraph 점검", "SEO 점검", "메타태그 검증", "og:title", "공유 미리보기 확인". Input is a single http/https URL; output is a Korean-language markdown report with a tag/value/status table plus error / warning / info sections. SSRF guard blocks private / loopback / link-local hosts by default — only override when the user explicitly asks for an internal scan and accepts the risk. One URL per turn — do not auto-batch.
allowed-tools: [seo_validate, journal_append]
license: MIT
version: 0.1.0
---

# seo-validation

## Role

* Single URL OG / Twitter / JSON-LD / favicon 메타 검증. `seo_validate` 한 호출 = fetch + parse + 경고 분류까지 한 번에.
* 검증 결과를 한국어 markdown 으로 정리해 사용자에게 보여 준다 — raw JSON dump 금지.
* SEO 추측 금지. 권고는 ogpeek 의 13 종 warning code 안에서만.

## Mental model

```
caller  ──► rocky  ──► seo-validation
                         ├── 0. URL 추출 / http|https 검증
                         ├── 1. seo_validate {url}        ← fetch (timeout 8s, 5MiB cap, redirect ≤ 5) → ogpeek.parse
                         │       └── (기본) SSRF 가드: localhost / 127.x / 10.x / 172.16-31.x / 192.168.x / 169.254.x / ::1 / fc00::/7 / fe80::/10 차단
                         ├── 2. summary → 한국어 markdown 표 + 에러 / 경고 / 권고 블록
                         └── 3. (선택) journal_append   ← 사용자가 기록 요청 시
```

## Inputs

- **url** (필수, string) — 검증 대상. http / https 만 허용. 사용자 메시지에서 그대로 추출 — 정규화 / 추측 금지.
- **timeoutMs** (선택, number) — fetch timeout (ms). 1..30000. 명시 안 하면 `agent-toolkit.json` 의 `seo.timeoutMs` (없으면 8000).
- **allowPrivateHosts** (선택, boolean) — SSRF 가드 비활성. 사용자가 "사내망", "로컬 dev server", "127.0.0.1 / localhost", "내부 호스트" 같은 표현을 명시할 때만 true 로. 그 외에는 절대 켜지 말 것.

## Outputs

`seo_validate` 결과의 두 부분 중 사용자에게 보이는 건 markdown 표 + 분류된 메시지. raw OgDebugResult 는 사용자가 명시적으로 요구할 때만 (`raw 도 보여줘`) JSON 코드블록으로.

### Output format

```
## OG / SEO 검증: <finalUrl>

| 태그 | 값 | 상태 |
| --- | --- | --- |
| og:title | "..." | ✓ 정상 / ⚠ 너무 김 (... 자) / ✗ 누락 |
| og:type | "..." | ✓ 정상 / ⚠ 알 수 없는 type / ✗ 누락 |
| og:url | "..." | ✓ 정상 / ⚠ 페이지 URL 과 불일치 / ✗ 누락 |
| og:image | "..." | ✓ 정상 / ✗ 누락 |
| og:description | "..." | ✓ 정상 / — (선택) |
| canonical | "..." | ✓ 정상 / — (선택) |
| favicon | (n 개) | ✓ 정상 / — (없음) |
| JSON-LD | (n 개 블록) | ✓ 정상 / — (없음) |

### 에러
- `OG_TITLE_MISSING`: ... (ogpeek 메시지 그대로 인용)

### 경고
- `OG_TITLE_TOO_LONG`: ... (실제 길이 / 권장 ≤ 60)

### 권고
- (사용자 행동 가능한 1 줄 권고. ogpeek warning code 가 직접 안내하지 않는 항목은 적지 말 것)
- (redirect 가 있었다면) 요청 URL → finalUrl 까지 N 회 redirect — canonical 점검 권장
```

표의 ✓ / ⚠ / ✗ 는 사용자 설정에 emoji 가 거슬리면 `OK` / `WARN` / `MISSING` 으로 대체 가능 — 기본은 위 마커.

## Tool usage rules

1. URL 은 사용자 메시지에서 *literal* 로 추출. 정규화 (예: `http→https` 강제) 금지 — finalUrl 은 ogpeek 가 redirect 후 알려준다.
2. **한 턴에 같은 URL 을 두 번 호출하지 않는다.** 결과를 reuse — 사용자가 다른 URL 을 또 주거나 명시적 재요청 시에만 새 호출.
3. 다중 URL 요청 ("이 5개 URL 검증해줘") 은 v1 범위 밖 — "현재 한 번에 한 URL 만 검증합니다. 어떤 URL 부터 볼까요?" 로 한 번에 하나만 진행.
4. **SSRF 가드는 기본 ON.** 사용자가 "localhost", "127.0.0.1", "내부 호스트", "사내망", "로컬 dev server" 를 *명시적으로 언급* 할 때만 `allowPrivateHosts: true` 로 호출. 호출 직후 답변에 "SSRF 가드를 사용자 요청으로 끔 — 외부 URL 검증으로 돌아갈 때 잊지 말 것" 한 줄 안내.
5. timeout 은 기본 8 초. 사용자가 "느린 사이트", "응답이 늦어" 라고 할 때만 늘리고 30 초 상한.
6. 결과의 `raw` 는 기본 출력에 포함하지 않는다 — 사용자가 "raw 도 보여줘" / "JSON 그대로" 라고 할 때만 JSON 코드블록으로 첨부.
7. journal 기록은 사용자가 "기록해줘" / "남겨줘" 라고 할 때만 — `tags: ["seo-validation"]`, `kind: "note"`, content 는 `seo_validate <finalUrl> errors=N warnings=M`.

## Failure / error handling

- **fetch 단 에러** (`FetchError`): `code` 가 `BLOCKED` / `TIMEOUT` / `TOO_LARGE` / `BAD_STATUS` / `NOT_HTML` / `TOO_MANY_REDIRECTS` 등. 사용자에게 한국어로 한 줄 + 원인 요약. `BLOCKED` (SSRF 가드 hit) 면 "내부 호스트 검증이 필요하면 `agent-toolkit.json` 의 `seo.allowPrivateHosts:true` 또는 도구 인자로 켜 주세요" 안내.
- **invalid URL** / **non-http(s) scheme**: 사용자에게 "http / https URL 만 검증할 수 있습니다 — 받은 입력: `<url>`" 로 답하고 stop.
- **timeout**: `seo.timeoutMs` 또는 호출 인자 `timeoutMs` 안내.
- **HTML 이 비어있거나 메타가 전혀 없음**: 표는 그대로 출력 (모두 ✗ 또는 —), 에러 / 경고 섹션을 ogpeek 결과대로 채움. 임의로 "이 페이지는 SEO 가 안 되어있다" 같은 광범위 평가 금지.

## Do NOT

* ogpeek 라이브러리 / `ogpeek/fetch` 를 직접 import 하지 않는다 — 항상 `seo_validate` 도구 경유.
* SSRF 가드를 사용자 명시 요청 없이 끄지 않는다.
* 같은 URL 을 한 턴에 두 번 fetch 하지 않는다.
* SEO 일반론 (예: "헤딩 구조를 개선하라") 을 추가하지 않는다 — ogpeek warning code 가 가리키는 항목만.
* `summary.raw` 를 매번 출력하지 않는다 — 명시적 요청 시에만.
* 사용자에게 ogpeek 의 영문 warning code 만 던지지 않는다 — code + 한국어 한 줄 설명을 같이.
* 다중 URL / sitemap / 크롤링은 거절. v1 범위 밖이라고 분명히.

## Related config (`agent-toolkit.json`)

```jsonc
{
  "seo": {
    "allowPrivateHosts": false,  // 기본 false. true 면 localhost / 사설 IP fetch 허용 — 사내망 검증 전용.
    "timeoutMs": 8000             // fetch timeout (ms). 1..30000.
  }
}
```

도구 호출 인자 (`timeoutMs` / `allowPrivateHosts`) 가 항상 우선. config 는 turn-spanning 기본값 용도로만.
