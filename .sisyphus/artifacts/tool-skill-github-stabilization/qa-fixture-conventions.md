# QA Fixture / Evidence Conventions

이 문서는 `tool-skill-github-stabilization` 작업에서 외부 QA용 fixture 와 evidence 를 어떻게 남길지 정리한다.

## 1) 공통 원칙

- live QA 는 **mock / fake / golden** 과 분리한다.
- `gh`, GitHub payload, skill contract 는 전부 **결정적(deterministic)** 이어야 한다.
- 비밀값은 남기지 않는다.
- fixture 이름은 역할이 드러나게 짓는다.
- temp dir 는 항상 `mkdtempSync(join(tmpdir(), 'agent-toolkit-test-'))` 패턴을 쓴다.

## 2) GitHub fixture 규칙

### fake `gh` binary / fake `GhExecutor`

기존 `lib/gh-cli.test.ts` 패턴을 따른다.

- `GhExecutor` interface 를 직접 구현한 fake 를 쓴다.
- 호출 순서를 queue 로 관리한다.
- `args` prefix 검증을 넣어 실제 `gh` 인자 조합을 고정한다.
- stderr/stdout/exitCode 를 명시적으로 채운다.

권장 형태:

```ts
const { exec, calls } = fakeExec([
  {
    expectArgsPrefix: ["issue", "list", "--repo", "x/y"],
    result: { stdout: "[]", stderr: "", exitCode: 0 },
  },
]);
```

### fake GitHub payload

PR 이벤트 / issue 이벤트 payload 는 최소 필드만 담는다.

- PR 이벤트: `id`, `type`, `number`, `action`, `comment`, `review`, `author`, `url`
- issue 이벤트: `number`, `title`, `body`, `url`, `labels`
- labels 는 string array 또는 `{ name }[]` 둘 다 테스트할 수 있게 만든다.
- 시간값은 고정 ISO string 을 쓴다.

예시:

```json
{
  "number": 42,
  "title": "QA epic",
  "body": "<!-- spec-pact:slug=foo:kind=epic -->",
  "url": "https://github.com/x/y/issues/42",
  "labels": ["qa-agent-toolkit", "spec-pact"]
}
```

## 3) skill contract markdown 규칙

기존 `.opencode/plugins/skill-agent-contract.test.ts` 패턴을 따른다.

- skill markdown 의 `allowed-tools` 를 파싱해 등록된 tool 과 비교한다.
- agent markdown 은 forbidden policy 문구를 포함하는지 확인한다.
- snapshot 전체 비교보다 **필수 문자열 존재 여부**를 우선한다.
- drift 탐지는 문구/도구 이름 단위로 한다.

체크 대상 예:

- `skills/notion-context/SKILL.md`
- `skills/openapi-client/SKILL.md`
- `skills/mysql-query/SKILL.md`
- `skills/spec-pact/SKILL.md`
- `skills/spec-to-issues/SKILL.md`
- `skills/pr-review-watch/SKILL.md`
- `skills/gh-passthrough/SKILL.md`

## 4) live QA evidence 경로 규칙

모든 live QA evidence 는 아래 루트에 둔다.

`.sisyphus/evidence/tool-skill-github-stabilization/`

권장 파일명:

- `t5-evidence-conventions.txt`
- `t5-redaction-rules.txt`

규칙:

- evidence 는 텍스트 UTF-8 로 저장한다.
- 한 파일에는 한 목적만 둔다.
- 날짜 / 실행 환경 / 검증 결과를 함께 남긴다.
- GitHub live mutation evidence 와 read-only 검증 evidence 를 섞지 않는다.

## 5) secret redaction 규칙

다음 키워드는 로그 / evidence / fixture 본문에 그대로 남기지 않는다.

- `token`
- `PAT`
- `Authorization`
- `redact`

주의:

- `Authorization` 헤더 값은 물론 헤더 이름 자체도 예시 로그에 과도하게 노출하지 않는다.
- PAT 는 접두/접미 일부만 남기는 식도 피한다.
- 토큰은 `***` 로만 표기한다.
- `redact` 함수 / 규칙을 테스트할 때는 입력과 출력 예시를 분리한다.

예시:

```txt
authorization: ***
token: ***
PAT: ***
```

## 6) mkdtempSync temp dir 패턴

임시 디렉터리는 다음 패턴을 사용한다.

```ts
const dir = mkdtempSync(join(tmpdir(), "agent-toolkit-test-"));
```

규칙:

- fixture write 전용 temp dir 는 테스트마다 새로 만든다.
- cleanup 이 필요하면 finally 에서 정리한다.
- 경로 하드코딩은 금지한다.

## 7) surface 별 fixture 체크리스트

### GitHub

- fake `gh` / `GhExecutor`
- PR issue payload
- PR review / issue comment payload
- labels / timestamps / URL 고정

### Notion

- pageId / URL 정규화 fixture
- markdown 본문 chunk fixture
- cache hit/miss 상태 fixture

### OpenAPI

- spec JSON fixture
- endpoint search fixture
- registry handle (`host:env:spec`) fixture

### MySQL

- read-only query fixture
- `SHOW` / `DESCRIBE` / `EXPLAIN` fixture
- connection handle (`host:env:db`) fixture

### opencode host

- plugin registration fixture
- skill/agent contract fixture
- tool inventory fixture

### journal

- append-only JSONL fixture
- tag-based lookup fixture
- corruption skip fixture

## 8) expected evidence format

evidence 파일에는 보통 아래를 넣는다.

1. 검증 스크립트 한 줄 요약
2. 입력 파일 / 경로
3. 판정 결과
4. 실패 시 원인

예:

```txt
PASS: qa-fixture-conventions.md contains GitHub / Notion / OpenAPI / MySQL / opencode host / journal sections
PASS: redaction keywords present: token, PAT, Authorization, redact
PASS: temp dir pattern present: mkdtempSync(join(tmpdir(), "agent-toolkit-test-"))
```
