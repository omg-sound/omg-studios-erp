"use strict";

const { db } = require("../db");

/**
 * 트랜잭션 실행(개편 1단계, 2026-10-13). 이미 트랜잭션 안이면 **새로 열지 않고 그대로 실행**한다 —
 * 바깥(예: `/new`의 프로젝트 생성 + 세션 생성)이 커밋·롤백을 맡는다. SQLite는 BEGIN 중첩이 불가라
 * 이 판단 없이 createSession을 바깥 트랜잭션 안에서 부르면 "cannot start a transaction" 오류가 난다.
 */
function withTx(fn) {
  const d = db();
  if (d.inTransaction) return fn();
  d.exec("BEGIN IMMEDIATE;");
  try {
    const out = fn();
    d.exec("COMMIT;");
    return out;
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

module.exports = { withTx };
