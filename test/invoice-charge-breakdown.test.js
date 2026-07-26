"use strict";

// 청구서에 요금 근거를 항목별로 분리 표시(2026-07-26 사용자 지시): 기본가 / 초과 N시간 / 할증.
//
// 라인이 여러 개로 늘어나므로 **다운스트림 정합**이 핵심이다 —
// 라인 합 = 청구서 공급가, 세션 청구 잠금(session_id 역참조), 매출 집계, 삭제 시 미청구 복원.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const {
  createInvoiceFromTasks,
  deleteInvoice,
  listInvoiceItemsForInvoice,
  isSessionInvoiced,
  createCompany,
  setSessionAmount,
} = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const PAYER = createCompany({ name: "촬영청구처", biz_no: "111-22-33333" });

const rateId = (name) => db().prepare("SELECT id FROM rate_items WHERE name = ?").get(name).id;

let seq = 0;
/** 프로젝트 + 완료 대관 세션 1건. minutes는 start~end로 표현. */
function seedSession({ type = "녹음", rate = "솔로 녹음", start = "14:00", end = "18:00", surcharge = null } = {}) {
  seq += 1;
  const pj = db().prepare("INSERT INTO projects (title, artist, project_type, rate) VALUES (?, '루나', 'session', 0)").run(`근거${seq}`);
  const projectId = Number(pj.lastInsertRowid);
  const s = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id, surcharge_key)
       VALUES (?, ?, '2026-08-10', ?, ?, '완료', ?, ?)`
    )
    .run(projectId, type, start, end, rateId(rate), surcharge);
  return { projectId, sessionId: Number(s.lastInsertRowid) };
}

test("초과가 없으면 라인 1개(종전과 동일)", () => {
  const { projectId, sessionId } = seedSession({ start: "14:00", end: "17:30" }); // 210분 = 정확히 1프로
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.equal(items.length, 1);
  assert.match(items[0].description, /8월 10일 · 루나 · 솔로 녹음/, "첫 라인은 종전 형식 유지");
  assert.match(items[0].description, /기본 3시간 30분 포함/, "근거가 붙는다");
  assert.equal(items[0].amount, 300000);
});

test("초과가 있으면 기본가·초과 시간이 각각 한 라인 — 합계는 그대로", () => {
  const { projectId, sessionId } = seedSession({ start: "10:00", end: "21:40" }); // 700분 = 3프로 + 1시간 10분
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.equal(items.length, 2, "기본가 + 초과");
  assert.equal(items[0].amount, 900000);
  assert.match(items[0].description, /기본 3시간 30분 × 3/);
  assert.equal(items[1].amount, 200000);
  assert.match(items[1].description, /초과 시간 · 1시간 10분 초과 → 2시간 × ₩100,000/);
  assert.equal(items[1].quantity, 2, "수량 = 초과 시간 수");
  assert.equal(items[1].unit_price, 100000);
  // 청구서 공급가 = 라인 합(VAT는 그 위에 붙는다).
  const supply = inv.amount - inv.tax_amount;
  assert.equal(items.reduce((s, i) => s + i.amount, 0), supply);
  // 모든 라인이 같은 세션을 가리켜야 잠금·복원·정렬이 성립한다.
  assert.ok(items.every((i) => i.session_id === sessionId), "라인 전부 session_id 스냅샷");
  assert.ok(items.every((i) => i.item_date === "2026-08-10"), "정렬 날짜도 동일");
});

test("미장센 할증이 걸리면 할증도 별도 라인(촬영 100만 → 150만)", () => {
  const { projectId, sessionId } = seedSession({ type: "촬영", rate: "기본 패키지", start: "10:00", end: "20:00", surcharge: "mise_en_scene" });
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.equal(items.length, 2);
  assert.equal(items[0].amount, 1000000);
  assert.match(items[1].description, /미장센 할증 · 기본가의 50%/);
  assert.equal(items[1].amount, 500000);
  assert.equal(inv.amount - inv.tax_amount, 1500000);
});

test("금액을 조정하면 라인을 쪼개지 않는다(조정 총액을 되쪼개면 거짓 근거)", () => {
  const { projectId, sessionId } = seedSession({ start: "10:00", end: "21:40" }); // 산정 110만
  const inv = createInvoiceFromTasks(CHIEF, {
    projectId,
    clientId: PAYER,
    sessionIds: [sessionId],
    sessionAmounts: { [sessionId]: "1000000" }, // 협의로 100만
    issueDate: "2026-08-10",
  });
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.equal(items.length, 1, "조정했으면 한 줄");
  assert.equal(items[0].amount, 1000000);
  assert.equal(inv.amount - inv.tax_amount, 1000000);
});

test("확정 청구액(billing_amount)이 있으면 그 금액 한 줄 + 조정 사유가 근거로 들어간다", () => {
  const { projectId, sessionId } = seedSession({ start: "10:00", end: "21:40" });
  setSessionAmount(CHIEF, sessionId, 950000);
  db().prepare("UPDATE sessions SET billing_memo = ? WHERE id = ?").run("장기 고객 협의가", sessionId);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 950000);
  assert.match(items[0].description, /장기 고객 협의가/, "조정 사유가 청구 근거로 남는다");
});

test("세션 잠금·복원: 라인이 여러 개여도 청구 잠금과 삭제 복원이 동작", () => {
  const { projectId, sessionId } = seedSession({ start: "10:00", end: "21:40" });
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  assert.equal(listInvoiceItemsForInvoice(CHIEF, inv.id).rows.length, 2);
  assert.equal(isSessionInvoiced(sessionId), true, "라인이 2개여도 잠긴다");
  deleteInvoice(CHIEF, inv.id);
  assert.equal(isSessionInvoiced(sessionId), false, "삭제하면 미청구로 복원");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM invoice_items WHERE session_id = ?").get(sessionId).n, 0, "라인 전부 삭제");
});

test("매출 상세의 '항목 수'는 라인 수가 아니라 일(세션·작업) 수로 센다", () => {
  const { projectId, sessionId } = seedSession({ start: "10:00", end: "21:40" }); // 라인 2개짜리 세션 1건
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, sessionIds: [sessionId], issueDate: "2026-08-10" });
  db().prepare("UPDATE invoices SET tax_status = '계산서 발행' WHERE id = ?").run(inv.id);
  const { revenueForPayer } = require("../src/data");
  const detail = revenueForPayer(PAYER);
  const row = detail.invoices.find((r) => r.id === inv.id);
  assert.ok(row, "청구처 상세에 노출");
  assert.equal(row.item_count, 1, "세션 하나가 '2개 항목'으로 보이면 안 된다");
  assert.equal(row.work_kind, "녹음");
});
