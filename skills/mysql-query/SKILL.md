---
name: mysql-query
description: Inspect a MySQL database under a strict read-only policy — list tables, dump a table's CREATE / index detail, or run a single SELECT / SHOW / DESCRIBE / EXPLAIN with an enforced LIMIT. Auto-trigger when the user supplies a `host:env:db` handle (registered in `agent-toolkit.json` 의 `mysql.connections`) or phrases like "users 테이블 조회" / "schema 보여줘" / "users 컬럼 뭐 있더라" / "SELECT id FROM users where status='active'". Writes are always rejected — INSERT / UPDATE / DELETE / DDL / SET / CALL / LOAD / multi-statement / INTO OUTFILE 모두 거부한다.
allowed-tools: [mysql_envs, mysql_status, mysql_tables, mysql_schema, mysql_query]
license: MIT
version: 0.1.0
---

# mysql-query

**Read-only.** This skill executes a single SQL statement at a time and rejects any write, DDL, multi-statement, `SET`, `CALL`, `LOAD`, or `INTO OUTFILE` / `DUMPFILE` form. It also forces a row cap (`LIMIT 100` by default, never above `1000`) on every row-returning statement. The DB account itself should be read-only (`GRANT SELECT` only) — that is the first defense; this skill is the second.

## Role

* Look up registered MySQL handles, ping a connection, list tables, dump a table's schema (CREATE / indexes), and run a single read-only SQL — for company-admin inspection workflows ("users 테이블에 누가 있지", "지난 주 가입자 schema 가 어떻게 생겼지").
* One handle, one SQL at a time. No bulk export, no migration plan, no multi-DB join.

## Inputs

`mysql_status` / `mysql_tables` / `mysql_schema` / `mysql_query` accept a `handle: host:env:db` registered in `agent-toolkit.json` (`./.opencode/agent-toolkit.json` overrides `~/.config/opencode/agent-toolkit/agent-toolkit.json`). `mysql_envs` takes no input — it lists every registered handle.

The `agent-toolkit.json` profile must declare exactly one of:

- **`passwordEnv`** — env-var name holding the password, paired with explicit `host` / `port?` / `user` / `database` fields, OR
- **`dsnEnv`** — env-var name holding `mysql://user:pass@host:port/db` (decomposed fields are forbidden in this mode).

Plaintext passwords in the config file are **never** accepted — the loader rejects them.

## Mental model

```
agent (you)
  ├── 0. mysql_envs              ← list registered host:env:db handles (no DB call)
  ├── 1. mysql_status            ← handle metadata + a single SELECT 1 ping
  ├── 2. mysql_tables            ← SHOW FULL TABLES
  ├── 3. mysql_schema            ← table omitted: INFORMATION_SCHEMA.COLUMNS summary
  │                                table given : SHOW CREATE TABLE + SHOW INDEX FROM
  └── 4. mysql_query             ← assertReadOnlySql + enforceLimit + execute
```

Each tool issues at most one or two SQL statements. There is no result caching — the data layer is the source of truth and DB schema can shift mid-session, so every `mysql_tables` / `mysql_schema` call goes back to the server.

## Tool usage rules

1. **Reach MySQL only through `mysql_*` tools.** No direct `Bun.spawn("mysql", …)`, no Bash, no Read of `.my.cnf` or other secret files.
2. **Use the handle the user named.** When the user says "users 테이블" without a handle, call `mysql_envs` once, surface the registered handles, and ask which one. Never guess.
3. **Schema-shape questions go through `mysql_schema`, not `mysql_query`.** `SHOW CREATE TABLE` 의 dedicated form 이 더 안정적이고 권한도 낮은 수준에서 동작한다.
4. **`mysql_query` 는 한 SQL, 한 결과.** 같은 turn 안에서 같은 SQL 을 두 번 던지지 않는다 — 결과를 재사용한다.
5. **`limit` 을 명시적으로 줘야 할 때.** 사용자가 "10 개만" / "딱 5 줄" 처럼 row 수를 말했으면 `mysql_query.limit` 으로 넘긴다. 안 줬으면 디폴트 100, 절대 상한 1000.
6. **결과 표시.** rows 는 markdown 표로, columns 메타는 표 헤더로. `truncated: true` 면 본문 아래에 `[N rows, capped at LIMIT M]` 한 줄을 덧붙인다. SHOW / DESCRIBE / EXPLAIN 은 cap 없이 그대로.
7. **에러는 사용자에게 그대로 인용.** 자격증명 누락 / handle 미등록 / SQL 거부 사유는 한 줄로 인용 후 어디를 고칠지 한 마디 (env 변수 이름, `agent-toolkit.json` 경로 등).

## Output format — markdown table

```md
**`<handle>` · `<rewritten SQL one line>`**

| col1 | col2 | col3 |
| --- | --- | --- |
| v1 | v2 | v3 |
| … | … | … |

[N rows, capped at LIMIT M]
```

`mysql_schema` 의 detail 모드 (table 지정) 출력은 `CREATE TABLE …` 코드블록 + 그 아래 INDEX 목록 (markdown 표) 두 부분.

`mysql_envs` 출력은 handle 별 `host` / `port` / `user` / `database` (passwordEnv 모드) 또는 `authMode: dsnEnv, authEnv: <env name>` (dsnEnv 모드) 한 줄씩. **자격증명 값 자체는 절대 노출하지 않는다 — env 변수 이름만.**

## Do NOT

* **Do not register an RW account.** `agent-toolkit.json` 에는 `GRANT SELECT` 만 가진 read-only 계정만 둔다. RW 계정으로 연결하면 DB 쪽 1차 방어선이 사라진다.
* **Do not bypass the SQL guard.** 주석 (`-- DELETE …`, `/* DROP TABLE */`) 이나 문자열 리터럴 안에 키워드를 숨겨도 `assertReadOnlySql` 가 정규화 후 검사한다 — 우회 시도 자체가 거부 사유.
* **Do not concatenate multiple statements.** `SELECT 1; SELECT 2` 는 wire 단 (`multipleStatements: false`) + SQL guard 에서 모두 거부된다.
* **Do not paste DSN / passwords into chat.** 사용자가 실수로 DSN 평문을 보냈으면 한 번 경고하고 env 변수 이름만 사용하도록 안내.
* **Do not reuse `mysql_query` 결과를 외부 파일로 dump 하지 않는다.** Read-only 의 의미는 *agent-toolkit 안에서* 만 보장된다.
* **Do not invent a handle.** `mysql_envs` 결과에 없는 핸들이면 "이 핸들은 등록되지 않았습니다" 한 줄 + 등록된 핸들 목록을 보여 주고 멈춘다.
* **Do not write large data into the journal.** `journal_append` 에 row 본문을 그대로 박지 않는다 (PII 위험). 결정 / blocker / 의사 답변만 한 줄 요약으로 남긴다.

## Failure / error handling

* **`MysqlExecutorRegistry`: handle "X" not found** → `mysql_envs` 출력으로 사용 가능한 handle 을 안내, `agent-toolkit.json` 의 `mysql.connections` 에 추가하라고 한 줄.
* **environment variable Y is missing / empty** → 사용자에게 env 변수 이름을 그대로 인용하고 어디서 set 해야 하는지 안내. *값 자체는 묻지 않는다*.
* **DSN scheme must be "mysql:" or "mariadb:"** → DSN 환경변수의 scheme 만 인용 (비밀번호 부분은 자동으로 마스킹된 상태).
* **MySQL read-only guard: leading keyword "X" is not allowed** → 어떤 키워드가 거부됐는지 한 줄, "허용 키워드: SELECT / SHOW / DESCRIBE / DESC / EXPLAIN / WITH" 한 줄.
* **MySQL read-only guard: forbidden keyword "Y"** → 본문에 의도치 않게 포함된 키워드를 인용. column 이름이 우연히 SQL 키워드와 같다면 backtick 으로 wrap (`` `UPDATE` ``) 해서 다시 보내라고 안내.
* **mysql2: ER_ACCESS_DENIED_ERROR / ETIMEDOUT 등** → 메시지 첫 줄을 그대로 인용, env 변수 이름과 `agent-toolkit.json` 경로를 짚어 주고 멈춘다.
* **Empty result + `truncated: false`** → `[0 rows]` 한 줄로 명시하고, 사용자가 어디에서 row 가 사라졌는지 (조건절 / database 선택) 의심할 수 있도록 SQL 을 함께 인용.
