"use strict";

// ── 대시보드 '내 할 일'(개인 렌즈) 회귀 잠금(2026-07-22) ──
// myTodo(user): 담당자 행이 있는 사람의 담당 다가오는 세션 + 미완료 작업.
// 완료 작업·과거/취소 세션·waived·담당자 없는 계정 제외.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const { myTodo } = require("../src/data");

const D = db();
// 하우스 엔지니어(로그인 user_id=1) + 담당자 행.
D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (1, 'eng@x.com', 'staff', '김엔지', 1)").run();
const mid = D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('김엔지', 1, 1)").run().lastInsertRowid;
// user_id 없는 계정(대표) — 담당자 행 없음.
D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (2, 'owner@x.com', 'owner', '대표', 1)").run();

const proj = D.prepare("INSERT INTO projects (title, project_type, artist, rate) VALUES ('루나 1집', 'session', '루나', 0)").run().lastInsertRowid;
const track = D.prepare("INSERT INTO project_tracks (project_id, title, artist) VALUES (?, '월광', '루나')").run(proj).lastInsertRowid;

// 내 미완료 작업 + 완료/waived(제외 대상).
const openTask = D.prepare("INSERT INTO track_tasks (track_id, task_type, status, engineer_id, waived) VALUES (?, 'Mixing', 'Pending', ?, 0)").run(track, mid).lastInsertRowid;
D.prepare("INSERT INTO track_tasks (track_id, task_type, status, engineer_id, waived) VALUES (?, 'Mastering', 'Completed', ?, 0)").run(track, mid); // 완료=제외
D.prepare("INSERT INTO track_tasks (track_id, task_type, status, engineer_id, waived) VALUES (?, 'VocalTune', 'Pending', ?, 1)").run(track, mid); // waived=제외

// 내 담당 다가오는 세션(session_engineers 배정) + 과거 세션(제외).
const futSess = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2099-01-01', '예정')").run(proj).lastInsertRowid;
D.prepare("INSERT INTO session_engineers (session_id, manager_id) VALUES (?, ?)").run(futSess, mid);
const pastSess = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2000-01-01', '예정')").run(proj).lastInsertRowid;
D.prepare("INSERT INTO session_engineers (session_id, manager_id) VALUES (?, ?)").run(pastSess, mid);

test("myTodo: 담당 미완료 작업만(완료·waived 제외)", () => {
  const t = myTodo({ id: 1 });
  assert.ok(t, "담당자 있는 계정은 객체 반환");
  assert.equal(t.name, "김엔지");
  assert.deepEqual(t.tasks.map((x) => x.id), [openTask], "미완료 1건만");
});

test("myTodo: 담당 다가오는 세션만(과거 제외)", () => {
  const t = myTodo({ id: 1 });
  assert.deepEqual(t.sessions.map((x) => x.id), [futSess], "미래 예정 1건만");
  assert.equal(t.sessions[0].artist, "루나");
});

test("myTodo: 담당자 행 없는 계정(대표)은 null → 섹션 숨김", () => {
  assert.equal(myTodo({ id: 2 }), null);
});

test("myTodo: 존재하지 않는 user·빈 user는 null", () => {
  assert.equal(myTodo({ id: 999 }), null);
  assert.equal(myTodo(null), null);
  assert.equal(myTodo({}), null);
});

test("myTodo: 레거시 engineer_name(다대다 배정 없음)도 내 세션으로 잡힌다", () => {
  const s2 = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status, engineer_name) VALUES (?, '믹싱', '2099-02-02', '예정', '김엔지')").run(proj).lastInsertRowid;
  const t = myTodo({ id: 1 });
  assert.ok(t.sessions.some((x) => x.id === s2), "engineer_name 매칭 세션 포함");
});

// ── 대표의 '내 할 일' = 계산서 발행 · 입금 확인(2026-08-02 사용자 결정) ──
// 🔒 분류가 청구 목록 필터칩(invoiceTaxTab)과 갈리면 카드 건수와 도착지 목록 건수가 어긋난다 — 그 정합을 잠근다.
const { invoiceTodo } = require("../src/data");
const OWNER = { id: 2, role: "owner" };
const CHIEF = { id: 1, role: "chief" };

D.prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('미발행분', 4000000, 0, '발행', '계산서 미발행')").run();
D.prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('발행됨·미입금', 1000000, 0, '발행', '계산서 발행')").run();
D.prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('발행됨·부분납', 1000000, 300000, '발행', '계산서 발행')").run();
D.prepare("INSERT INTO invoices (title, amount, paid_amount, status, tax_status) VALUES ('끝난 건', 5000000, 5000000, '발행', '입금완료')").run();

test("invoiceTodo: 계산서 발행 필요 = 미발행분 총액 / 입금 확인 = 발행됨의 잔금", () => {
  const t = invoiceTodo(OWNER);
  assert.ok(t, "대표는 객체 반환");
  assert.deepEqual(t.bill, { count: 1, amount: 4000000 }, "발행 필요는 총액");
  // 입금 확인 = 잔금(부분납 반영): 1,000,000 + (1,000,000 - 300,000) = 1,700,000
  assert.deepEqual(t.collect, { count: 2, amount: 1700000 }, "입금 확인은 잔금");
});

test("invoiceTodo: 입금완료 건은 어느 쪽에도 안 센다", () => {
  const t = invoiceTodo(OWNER);
  assert.equal(t.bill.count + t.collect.count, 3, "전체 4건 중 입금완료 1건 제외");
});

test("invoiceTodo: 대표가 아니면 null → 청구 줄 자체를 안 그린다", () => {
  assert.equal(invoiceTodo(CHIEF), null, "치프 제외(사용자 결정)");
  assert.equal(invoiceTodo({ id: 3, role: "staff" }), null);
  assert.equal(invoiceTodo(null), null);
});
