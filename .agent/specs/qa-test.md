---
slug: qa-test
title: QA Test SPEC — agent-toolkit live issue sync
status: locked
version: 1
source_page_id: ""
source_content_hash: ""
created_at: "2026-05-05T00:00:00Z"
updated_at: "2026-05-05T00:00:00Z"
---

# QA Test SPEC — agent-toolkit live issue sync

이 SPEC은 `issue_create_from_spec` 도구의 live QA 검증을 위한 테스트 픽스처다.
`minjun0219/agent-toolkit-test-target-repo` 리포지토리를 대상으로 epic + sub-issue 생성을 검증한다.

## 개요

agent-toolkit의 `spec-to-issues` 기능이 잠긴 SPEC의 합의 TODO를 GitHub epic + sub-issue 시리즈로 올바르게 동기화하는지 검증한다.

# 합의 TODO

- QA: dryRun 모드에서 plan이 올바르게 출력되는지 확인
- QA: apply 모드에서 epic과 sub-issue가 생성되는지 확인
- QA: 재실행 시 idempotency(no-op)가 보장되는지 확인
