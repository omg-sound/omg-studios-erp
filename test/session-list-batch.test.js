"use strict";

// 세션 목록 조회의 **쿼리 수가 행 수에 비례하지 않는다**(N+1 금지) — 2026-07-27 가드로 승격.
//
// 이 경로에서 N+1이 두 번 생겼다(2026-07-09 행마다 단가표 조회, 2026-07-26 행마다 촬영 구간 조회 —
// 둘 다 개편 4단계에서 기능째 사라졌지만 같은 클래스가 다시 생기지 않게 가드는 남긴다).
// 정책(CLAUDE.md 함정 #21): 같은 실수 클래스가 2번 나오면 '조심'이 아니라 기계 검사로 승격한다.
// 그래서 여기서는 **절대 시간이 아니라 쿼리 수의 스케일링**을 본다(느린 머신에서도 결정적).

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { listSessionsForProject, upcomingSessions } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
/** 세션 N개를 시드한다. 절반은 녹음, 절반은 촬영 대관. */
function seedProject(n) {
  const d = db();
  const pj = Number(d.prepare("INSERT INTO projects (title, artist, project_type, rate) VALUES ('배치', '루나', 'session', 0)").run().lastInsertRowid);
  const ins = d.prepare(
    `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status)
     VALUES (?, ?, ?, '10:00', ?, '완료')`
  );
  for (let i = 0; i < n; i++) {
    const filming = i % 2 === 1;
    const day = String(10 + (i % 18)).padStart(2, "0");
    ins.run(pj, filming ? "촬영 대관" : "녹음", `2099-08-${day}`, filming ? "20:00" : "13:30");
  }
  return pj;
}

/** fn 실행 중 발생한 쿼리 실행 횟수. prepare된 statement의 get/all/run을 센다. */
function countQueries(fn) {
  const d = db();
  const origPrepare = d.prepare.bind(d);
  let runs = 0;
  d.prepare = (sql) => {
    const st = origPrepare(sql);
    for (const m of ["get", "all", "run"]) {
      const orig = st[m] && st[m].bind(st);
      if (orig) st[m] = (...args) => { runs += 1; return orig(...args); };
    }
    return st;
  };
  try {
    const out = fn();
    return { runs, out };
  } finally {
    d.prepare = origPrepare;
  }
}

test("프로젝트 세션 탭: 행이 10배로 늘어도 쿼리 수는 그대로다", () => {
  const small = seedProject(10);
  const big = seedProject(100);
  const a = countQueries(() => listSessionsForProject(CHIEF, small));
  const b = countQueries(() => listSessionsForProject(CHIEF, big));
  assert.equal(a.out.rows.length, 10);
  assert.equal(b.out.rows.length, 100);
  assert.equal(
    b.runs,
    a.runs,
    `행 수와 무관해야 한다(10행 ${a.runs}쿼리 / 100행 ${b.runs}쿼리). ` +
      "행당 조회가 생기면 여기서 걸린다 — id IN (...) 배치 조회로 바꿔라."
  );
  // 절대 상한도 둔다(조회가 조금씩 늘어나는 것도 잡히게). 현재 6~9회 수준.
  assert.ok(b.runs <= 12, `쿼리 ${b.runs}회 — 상한 12 초과. 새 조회를 배치로 바꿨는지 확인하라.`);
});

test("전역 다가오는 세션 목록도 상수 쿼리", () => {
  const a = countQueries(() => upcomingSessions(CHIEF, { limit: 5 }));
  const b = countQueries(() => upcomingSessions(CHIEF, { limit: 100 }));
  assert.ok(b.out.length > a.out.length, "limit이 커지면 행이 더 나와야(시드 확인)");
  assert.equal(b.runs, a.runs, `행 수와 무관해야 한다(${a.out.length}행 ${a.runs}쿼리 / ${b.out.length}행 ${b.runs}쿼리)`);
  assert.ok(b.runs <= 8, `쿼리 ${b.runs}회 — 상한 8 초과`);
});

test("목록 경로가 단건 경로와 같은 금액을 낸다(확정액)", () => {
  // 배치로 붙인 billing이 단건 조회 결과와 어긋나면 목록 금액만 조용히 틀려진다.
  const pj = seedProject(4);
  db().prepare("UPDATE sessions SET billing_amount = 250000 WHERE project_id = ? AND session_type = '촬영 대관'").run(pj);
  const rows = listSessionsForProject(CHIEF, pj).rows;
  const { sessionRateAmount } = require("../src/data");
  for (const row of rows) {
    const single = sessionRateAmount(db().prepare("SELECT * FROM sessions WHERE id = ?").get(row.id));
    if (!single) { assert.equal(row.billing, null); continue; }
    assert.equal(row.billing.amount, single.amount, `세션 ${row.id} 금액 불일치(배치 ${row.billing.amount} vs 단건 ${single.amount})`);
    assert.equal(row.billing.minutes, single.minutes, `세션 ${row.id} 시간 불일치`);
  }
  const filming = rows.find((r) => r.session_type === "촬영 대관");
  assert.equal(filming.billing.amount, 250000, "확정액 그대로");
  assert.equal(filming.billing.fixed, true);
});
