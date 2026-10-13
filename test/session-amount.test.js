"use strict";

// ── 청구 전엔 금액이 없다(2026-10-14 사용자 결정 — '미리 기입된 금액이 헷갈린다') ──
// 금액은 청구서 작성 화면에서 처음 정한다. 옛 데이터에 작업 금액(total_price)·세션 확정액(billing_amount)이
// 남아 있어도 청구 전 화면(대기함·작성 화면 기본값·프로젝트 금액·세션 줄·외주 참고)은 그 값을 읽지 않는다.
// 청구서를 발행하면 그때 정한 금액이 프로젝트 금액·세션 줄에 보인다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const { test, after } = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
after(() => cleanupDb(process.env.DB_PATH, db()));

const D = require("../src/data");
const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const PAYER = D.createCompany({ name: "금액없음기획사", biz_no: "123-45-60009" });

function seed(title) {
  const d = db();
  const pid = Number(d.prepare("INSERT INTO projects (title) VALUES (?)").run(title).lastInsertRowid);
  // 옛 데이터처럼 미리 적힌 금액이 남아 있는 세션·작업
  const sid = Number(d.prepare(
    "INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, billing_amount) VALUES (?, '녹음', '2026-07-01', '14:00', '17:30', '예정', 250000)"
  ).run(pid).lastInsertRowid);
  const tid = Number(d.prepare(
    "INSERT INTO track_tasks (project_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 1000000, 1000000, 'Pending', 0)"
  ).run(pid).lastInsertRowid);
  return { pid, sid, tid };
}

test("대기함·작성 화면: 옛 금액이 있어도 금액을 싣지 않는다(작성 화면 금액칸은 빈칸)", () => {
  const { pid, sid, tid } = seed("금액없음A");
  const { groups } = D.listBillableItems(CHIEF, { projectId: pid });
  const items = groups[0].items;
  assert.deepEqual(items.map((i) => i.key).sort(), [`s${sid}`, `t${tid}`].sort());
  assert.ok(items.every((i) => !("amount" in i)), "대기함 항목에 금액 없음");
  const { lines } = D.composeLinesForKeys([`s${sid}`, `t${tid}`]);
  assert.ok(lines.every((l) => l.amount == null), "작성 화면은 빈 금액칸으로 연다");
});

test("프로젝트 금액·세션 줄: 청구 전엔 0·금액 없음, 발행하면 정한 금액", () => {
  const { sessionProjectCard } = require("../src/views.sessions");
  const { pid, sid, tid } = seed("금액없음B");
  const proj = () => D.listProjects(CHIEF, {}).find((p) => p.id === pid);
  assert.equal(proj().task_total, 0, "미청구 작업 금액은 프로젝트 금액에 없다");
  assert.equal(proj().session_amount_total, 0, "미청구 세션 확정액도 없다");
  assert.doesNotMatch(sessionProjectCard(D.listSessionsForProject(CHIEF, pid).rows, { isAdmin: false }), /청구액/, "세션 줄에 금액 없음");

  D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "session", id: sid, amount: "300000" }, { kind: "task", id: tid, amount: "700000" }] });
  assert.equal(proj().task_total, 700000, "발행 때 정한 작업 금액");
  assert.equal(proj().session_amount_total, 300000, "발행 때 정한 세션 금액");
  assert.match(sessionProjectCard(D.listSessionsForProject(CHIEF, pid).rows, { isAdmin: false }), /청구액 ₩300,000/);
});

test("금액을 미리 저장하던 경로는 없다(작업·세션 금액 즉시 저장 폐지)", () => {
  assert.equal(D.setSessionAmount, undefined);
  assert.equal(D.setTaskAmount, undefined);
  const src = require("fs").readFileSync(require("path").join(__dirname, "../src/views.new.js"), "utf8");
  assert.doesNotMatch(src, /name="unit_price"/, "작업 만들기 폼에 금액 칸 없음");
});
