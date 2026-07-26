"use strict";

// 세션 목록 조회의 **쿼리 수가 행 수에 비례하지 않는다**(N+1 금지) — 2026-07-27 가드로 승격.
//
// 이 경로에서 N+1이 두 번 생겼다:
//  ① 2026-07-09 감사 L9 — 행마다 rate_items를 단건 조회 → `withBilling`이 1회 로드하도록 고침.
//  ② 2026-07-26 촬영 구간·할증 도입 — `sessionRateAmount`가 행마다 `listSessionSegments`+
//     `getSurcharge`를 부르며 되살아났다(실측 200행에 307쿼리 = 행당 1.5).
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
const rateId = (name) => db().prepare("SELECT id FROM rate_items WHERE name = ?").get(name).id;

/** 세션 N개를 시드한다. 절반은 구간 3개 + 할증이 걸린 촬영(가장 비싼 경로). */
function seedProject(n) {
  const d = db();
  const solo = rateId("솔로 녹음");
  const pkg = rateId("기본 패키지");
  const pj = Number(d.prepare("INSERT INTO projects (title, artist, project_type, rate) VALUES ('배치', '루나', 'session', 0)").run().lastInsertRowid);
  const ins = d.prepare(
    `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id, surcharge_key)
     VALUES (?, ?, ?, '10:00', ?, '완료', ?, ?)`
  );
  const seg = d.prepare("INSERT INTO session_segments (session_id, kind, start_time, end_time, sort_order) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < n; i++) {
    const filming = i % 2 === 1;
    const day = String(10 + (i % 18)).padStart(2, "0");
    const id = Number(ins.run(pj, filming ? "촬영" : "녹음", `2099-08-${day}`, filming ? "20:00" : "13:30", filming ? pkg : solo, filming ? "mise_en_scene" : null).lastInsertRowid);
    if (filming) {
      seg.run(id, "setup", "10:00", "12:00", 0);
      seg.run(id, "shoot", "12:00", "19:00", 10);
      seg.run(id, "teardown", "19:00", "20:00", 20);
    }
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
      "행당 조회가 생기면 여기서 걸린다 — withBilling(ids)에 id를 넘겨 배치 로드하라."
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

test("배치 경로가 단건 경로와 같은 금액을 낸다(구간 합산·할증 반영)", () => {
  // 배치로 주입한 구간·할증이 단건 조회 결과와 어긋나면 목록 금액만 조용히 틀려진다.
  const pj = seedProject(4);
  const rows = listSessionsForProject(CHIEF, pj).rows;
  const { sessionRateAmount } = require("../src/data");
  for (const row of rows) {
    const single = sessionRateAmount(db().prepare("SELECT * FROM sessions WHERE id = ?").get(row.id));
    assert.equal(row.billing.amount, single.amount, `세션 ${row.id} 금액 불일치(배치 ${row.billing.amount} vs 단건 ${single.amount})`);
    assert.equal(row.billing.minutes, single.minutes, `세션 ${row.id} 요금 시간 불일치`);
    assert.equal(!!row.billing.surcharge, !!single.surcharge, `세션 ${row.id} 할증 반영 불일치`);
  }
  // 촬영 행은 구간 합산(600분) + 할증이 실제로 걸려 있어야 이 테스트가 의미가 있다.
  const filming = rows.find((r) => r.session_type === "촬영");
  assert.equal(filming.billing.minutes, 600, "구간 합산이 배치 경로에서도 동작");
  assert.equal(filming.billing.amount, 1500000, "기본 패키지 100만 + 미장센 50%");
});
