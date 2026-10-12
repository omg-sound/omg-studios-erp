"use strict";

// ── 세션 확정 청구액(2026-07-14 사용자 요청) ──
// 청구 폼에서 고친 세션 금액이 폼 안에서만 살아 있다가 새로고침하면 사라지던 문제.
// 개편 3단계(2026-10-13)부터 단가표 산정이 없어 세션 금액 = 이 확정액뿐(없으면 '미정', 청구서에서 입력).
// 작업(total_price 즉시 저장)과 대칭으로 sessions.billing_amount에 즉시 저장한다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const { test, after } = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
after(() => cleanupDb(process.env.DB_PATH, db()));

const D = require("../src/data");
const user = { id: 1, role: "chief" };

function seed() {
  const d = db();
  const rate = d
    .prepare("INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, active) VALUES (?,?,?,?,?,?,1)")
    .run("보컬녹음", "스튜디오 녹음", 210, 300000, 60, 100000).lastInsertRowid;
  const pid = d.prepare("INSERT INTO projects (title) VALUES (?)").run("세션 금액 테스트").lastInsertRowid;
  const sid = d
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(pid, "녹음", "2026-07-01", "14:00", "17:30", "완료", rate).lastInsertRowid; // 3.5h = 1Pro = 300,000
  return { pid, sid, rate };
}

test("세션 금액: 확정액을 저장하면 그 값이 쓰이고, 다시 조회해도 유지된다(폼 밖 영속)", () => {
  const { pid, sid } = seed();
  D.setSessionAmount(user, sid, 250000);

  const s = D.getSessionForUser(user, sid);
  assert.strictEqual(s.billing_amount, 250000, "DB에 저장");
  const b = D.sessionRateAmount(s);
  assert.strictEqual(b.amount, 250000, "산정 대신 확정액");
  assert.strictEqual(b.fixed, true);

  // 청구 폼의 후보 목록(다른 기기·새로고침 경로)도 확정액으로 보인다.
  const billable = D.listBillableSessionsForProject(user, pid);
  const row = billable.rows.find((r) => r.id === sid);
  assert.strictEqual(row.billing.amount, 250000);

  // 프로젝트 목록 금액(미청구 세션 합계)에도 반영.
  const p = D.listProjects(user, {}).find((x) => x.id === pid);
  assert.strictEqual(p.session_amount_total, 250000);
});

test("세션 금액: 확정액은 '확정 청구액'으로 표시(단가표 산정치와 구분)", () => {
  // 확정액은 세션 시간·단가를 바꿔도 유지되므로, 표시가 '예상 청구액'이면 단가표 산정치로 오인한다.
  const { sessionProjectCard } = require("../src/views.sessions"); // sessionRow는 내부 전용 — 카드로 렌더
  const { pid, sid } = seed();
  // billing(산정·확정)은 목록 조회가 붙여준다(단건 getSession은 원본 행만).
  const render = () => sessionProjectCard(D.listSessionsForProject(user, pid).rows, { isAdmin: false });

  const before = render();
  assert.match(before, /청구액 미정/, "확정액 전엔 '미정'(단가표 산정치 없음 — 개편 3단계)");

  D.setSessionAmount(user, sid, 250000);
  const after = render();
  assert.match(after, /확정 청구액[\s\S]*250,000/);
  assert.doesNotMatch(after, /예상 청구액/);
});

test("세션 금액: 이미 청구된 세션은 변경 거부(SESSION_INVOICED)", () => {
  const { pid, sid } = seed();
  const inv = db().prepare("INSERT INTO invoices (project_id, title, amount, status) VALUES (?,?,?,?)").run(pid, "청구", 330000, "발행").lastInsertRowid;
  db().prepare("INSERT INTO invoice_items (invoice_id, session_id, description, quantity, unit_price, amount) VALUES (?,?,?,1,300000,300000)").run(inv, sid, "세션");

  assert.throws(() => D.setSessionAmount(user, sid, 111111), /SESSION_INVOICED/);
  assert.strictEqual(db().prepare("SELECT billing_amount FROM sessions WHERE id = ?").get(sid).billing_amount, null, "값 안 바뀜");
});

test("세션 금액(개편 3단계): 0원도 확정액, 비우면 '미정'(0) — 프로젝트 예산은 확정액만 합산(종일 포함)", () => {
  const { pid, sid } = seed();
  D.setSessionAmount(user, sid, 0);
  assert.strictEqual(D.sessionRateAmount(D.getSessionForUser(user, sid)).fixed, true, "0원도 유효한 확정액(무료 협의)");
  D.setSessionAmount(user, sid, null);
  const cleared = D.sessionRateAmount(D.getSessionForUser(user, sid));
  assert.strictEqual(cleared.fixed, false);
  assert.strictEqual(cleared.amount, 0, "빈 값 = 미정(산정치로 돌아가지 않는다)");
  const ad = db().prepare("INSERT INTO sessions (project_id, session_type, session_date, end_date, all_day, status, billing_amount) VALUES (?, '녹음', '2026-07-02', '2026-07-03', 1, '완료', 400000)").run(pid).lastInsertRowid;
  assert.ok(ad);
  const p = D.listProjects(user, {}).find((x) => x.id === pid);
  assert.strictEqual(p.session_amount_total, 400000, "확정액이 있는 종일 세션만 예산에 — 미정 세션은 0");
});
