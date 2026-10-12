"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// ── 2026-08-22 감사: 여러 행을 한 요청에서 반복 처리하는 라우트가 트랜잭션 없이 루프했다 ──
// 중간 실패 시 일부만 반영된 상태로 남을 수 있었다. 실서버 없이 소스 계약으로 회귀를 잠근다
// (bulk-tax-status가 이미 쓰는 BEGIN IMMEDIATE…COMMIT/ROLLBACK 패턴과 통일됐는지 확인).
test("tracks.js: 작업 다건 생성(createTasks — 곡명 줄마다 작업)이 한 트랜잭션으로 묶인다(개편 2단계)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "data", "tracks.js"), "utf8");
  const start = src.indexOf("function createTasks(");
  const block = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(block, /return withTx\(\(\) => \{/, "withTx로 감싼다(바깥 트랜잭션이 있으면 그쪽에 합류)");
  assert.match(block, /for \(const t of titles\)/, "줄마다 생성이 트랜잭션 블록 안");
});

test("workers.routes.js: 일괄 지급 처리(POST /:id/payout-all)가 한 트랜잭션으로 묶인다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "workers.routes.js"), "utf8");
  const start = src.indexOf('router.post("/:id/payout-all"');
  const block = src.slice(start, start + 1200);
  assert.match(block, /d\.exec\("BEGIN IMMEDIATE"\)/, "트랜잭션 시작");
  assert.match(block, /d\.exec\("COMMIT"\)/, "성공 시 커밋");
  assert.match(block, /ROLLBACK/, "실패 시 롤백");
  assert.match(block, /tasks\.forEach\(\(t\) => setTaskPayout/, "작업 지급이 트랜잭션 블록 안");
  assert.match(block, /sessionPayouts\.forEach\(\(s\) => setSessionEngineerPayout/, "세션 지급도 같은 블록 안");
});
