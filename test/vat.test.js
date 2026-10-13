"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정(실 data/app.db 오염 방지) ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createInvoiceFromTasks, invoiceAmountsFromSupply, listProjects, getProjectForUser, createCompany } = require("../src/data");

init();

// 청구처는 이제 **항상 명시**해야 한다(2026-07-15 — 제작/운영 자동 파생 폐기, PAYER_REQUIRED).
const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const STAFF = { id: 2, role: "staff", email: "staff@omg.test" };
const PAYER = createCompany({ name: "청구처회사", biz_no: "123-45-67890" }); // 회사 청구처(세금계산서 정보 보유)

/** 프로젝트 + 트랙 + 작업(미청구) 시드. total_price 원하는 값으로. taskId 반환. */
function seedTask(totalPrice) {
  const pj = db()
    .prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)")
    .run("VAT 테스트 프로젝트");
  const projectId = Number(pj.lastInsertRowid);
  const tk = db()
    .prepare(
      `INSERT INTO track_tasks (project_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
    )
    .run(projectId, totalPrice, totalPrice);
  return { projectId, taskId: Number(tk.lastInsertRowid) };
}

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("VAT: 공급가 1,000,000 → tax 100,000 · 총액 1,100,000 저장", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.ok(inv, "인보이스가 생성되어야 한다");
  assert.strictEqual(inv.amount, 1_100_000, "amount = 공급가 + VAT");
  assert.strictEqual(inv.tax_amount, 100_000, "tax_amount = round(공급가 * 0.1)");
  assert.strictEqual(inv.amount - inv.tax_amount, 1_000_000, "공급가 = amount - tax");
});

test("VAT: 반올림 케이스 — 공급가 333,333 → tax 33,333 · 총액 366,666", () => {
  const { projectId, taskId } = seedTask(333_333); // 333333 * 0.1 = 33333.3 → round 33333
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.strictEqual(inv.tax_amount, 33_333);
  assert.strictEqual(inv.amount, 366_666);
});

test("VAT: 여러 작업 합산 후 과세 — 600,000 + 400,000 → tax 100,000 · 총액 1,100,000", () => {
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'task', 0)").run("합산 프로젝트");
  const projectId = Number(pj.lastInsertRowid);
  const mk = (price) =>
    Number(
      db()
        .prepare(
          `INSERT INTO track_tasks (project_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
           VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
        )
        .run(projectId, price, price).lastInsertRowid
    );
  const t1 = mk(600_000);
  const t2 = mk(400_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [t1, t2], issueDate: "2026-06-15" });
  assert.strictEqual(inv.tax_amount, 100_000);
  assert.strictEqual(inv.amount, 1_100_000);
});

test("청구 권한: 스태프(canBill)도 청구서 생성 가능(스태프 청구 허용)", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks(STAFF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.ok(inv, "스태프도 청구서 발행 가능");
  assert.strictEqual(inv.amount, 550_000); // 공급가 500,000 + VAT 50,000
});

test("청구 권한 가드: 무권한(로그인 역할 아님)은 청구 생성 불가(null)", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks({ id: 99, role: "none", email: "x@x.test" }, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.strictEqual(inv, null);
});

// ── 순수 VAT 공식 검증(소스 비의존): round(amount - amount/1.1) ──
// VAT 포함 총액에서 부가세 추출 공식. 대표 케이스가 정수로 떨어지는지 확인.
test("순수 공식 round(amount - amount/1.1): 대표 케이스", () => {
  const vat = (amount) => Math.round(amount - amount / 1.1);
  assert.strictEqual(vat(1_100_000), 100_000);
  assert.strictEqual(vat(0), 0);
  assert.strictEqual(vat(11_000), 1_000);
  assert.strictEqual(vat(550_000), 50_000);
});

// ── invoiceAmountsFromSupply 할인 헬퍼 ──
test("할인 헬퍼: 공급가 1,000,000 · 할인 100,000 → taxable 900,000 · tax 90,000 · total 990,000", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 100_000);
  assert.strictEqual(r.discount, 100_000);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 90_000);
  assert.strictEqual(r.total, 990_000);
});

test("할인 헬퍼: 정률 10% — 공급가 1,000,000 · 할인 100,000 동일 결과", () => {
  const discount = Math.round(1_000_000 * 10 / 100);
  const r = invoiceAmountsFromSupply(1_000_000, discount);
  assert.strictEqual(r.discount, 100_000);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 90_000);
  assert.strictEqual(r.total, 990_000);
});

test("할인 헬퍼 clamp: 할인 > 공급가 → 공급가로 제한(taxable=0·tax=0·total=0)", () => {
  const r = invoiceAmountsFromSupply(500_000, 999_999);
  assert.strictEqual(r.discount, 500_000, "할인은 공급가로 clamp");
  assert.strictEqual(r.taxable, 0);
  assert.strictEqual(r.tax, 0);
  assert.strictEqual(r.total, 0);
});

test("할인 헬퍼 clamp: 음수 할인 → 0(clamp)", () => {
  const r = invoiceAmountsFromSupply(500_000, -100_000);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.taxable, 500_000);
  assert.strictEqual(r.tax, 50_000);
  assert.strictEqual(r.total, 550_000);
});

test("할인 포함 createInvoiceFromTasks: 공급가 1,000,000 · 할인 100,000 → amount=990,000 · tax=90,000 · discount_amount=100,000", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15", discount: 100_000 });
  assert.ok(inv, "인보이스가 생성되어야 한다");
  assert.strictEqual(inv.discount_amount, 100_000, "discount_amount 저장");
  assert.strictEqual(inv.tax_amount, 90_000, "VAT = 900,000 * 0.1");
  assert.strictEqual(inv.amount, 990_000, "총액 = 900,000 + 90,000");
});

// ── 정률(%) 서버 폴백(감사 L2) — 정액 미입력 + %만 오면 서버가 공급가 기준 산정(JS-off 안전망) ──
test("정률 폴백: discount 없이 discountPct=10 → 서버가 공급가*10% 산정(할인 100,000)", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15", discountPct: "10" });
  assert.strictEqual(inv.discount_amount, 100_000, "정액 미입력 시 %로 산정");
  assert.strictEqual(inv.amount, 990_000);
});

test("정률 폴백: 정액(discount)이 있으면 % 무시(정액 우선)", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15", discount: 50_000, discountPct: "10" });
  assert.strictEqual(inv.discount_amount, 50_000, "정액이 있으면 %는 무시");
});

test("정률 폴백: %도 정액도 없으면 할인 0", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15" });
  assert.strictEqual(inv.discount_amount, 0);
  assert.strictEqual(inv.amount, 1_100_000);
});

// ── 부가세 토글(vatIncluded=false = 현금/부가세 미포함) ──
test("VAT off: 부가세 미포함(현금) — tax 0, total=공급가", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 0, false);
  assert.strictEqual(r.tax, 0, "현금 거래는 VAT 0");
  assert.strictEqual(r.total, 1_000_000, "총액 = 공급가");
});

test("VAT off + 할인: 공급가 1,000,000 · 할인 100,000 → taxable 900,000 · tax 0 · total 900,000", () => {
  const r = invoiceAmountsFromSupply(1_000_000, 100_000, false);
  assert.strictEqual(r.taxable, 900_000);
  assert.strictEqual(r.tax, 0);
  assert.strictEqual(r.total, 900_000);
});

test("createInvoiceFromTasks vatIncluded=false: 현금 청구 — tax_amount 0 · amount=공급가", () => {
  const { projectId, taskId } = seedTask(500_000);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15", vatIncluded: false });
  assert.ok(inv);
  assert.strictEqual(inv.tax_amount, 0);
  assert.strictEqual(inv.amount, 500_000);
});

// ── 0원 항목 청구(2026-07-05 사용자 결정 — 무료로 해준 작업도 기록·청구서에 남길 수 있게) ──
// confirmZero 없이는 여전히 차단(TASK_AMOUNT_REQUIRED), 확인 후(confirmZero:true)에만 허용.
test("0원 항목: confirmZero 없으면 TASK_AMOUNT_REQUIRED로 차단", () => {
  const { projectId, taskId } = seedTask(0);
  assert.throws(() => createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-07-05" }), /TASK_AMOUNT_REQUIRED/);
});

test("0원 항목: confirmZero:true면 0원 그대로 청구 생성(공급가·총액 0)", () => {
  const { projectId, taskId } = seedTask(0);
  const inv = createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-07-05", confirmZero: true });
  assert.ok(inv, "확인 후에는 0원 청구 생성");
  assert.strictEqual(inv.amount, 0);
  assert.strictEqual(inv.tax_amount, 0);
});

// ── 청구 항목 정렬(2026-07-05 사용자 리포트 '청구 생성 후에도 날짜순이 아니다',
//    2026-08-22 사용자 리포트 '녹음·믹싱이 산발적으로 섞여 있다'로 유형 우선순위 도입) ──
// 세션은 session_date로 날짜순 정렬, 작업은 유형 그룹으로 세션 뒤에 묶이고 그 안에서는 등록 순서(id) 유지.
// 작업의 item_date(등록일=created_at)는 더 이상 전체 정렬 기준으로 쓰이지 않는다 — 실제 작업 순서와 무관한
// 값이라 날짜 하나로만 정렬하면 등록 시점에 따라 세션 사이사이에 무작위로 끼어들었기 때문(ITEM_ORDER_SQL 참조).
test("청구 항목 정렬: 세션은 날짜순으로 먼저, 작업은 뒤에 묶인다(세션 날짜가 작업 등록일보다 늦어도)", () => {
  const { listInvoiceItemsForInvoice } = require("../src/data");
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('정렬테스트', 'task', 0)").run();
  const pid = Number(pj.lastInsertRowid);
  const tk = db()
    .prepare(
      `INSERT INTO track_tasks (project_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced, created_at)
       VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 300000, 300000, 'Completed', 0, '2026-08-01 10:00:00')`
    )
    .run(pid);
  const taskId = Number(tk.lastInsertRowid);
  // 세션 날짜(8/10)가 작업 등록일(8/1)보다 **늦다** — 옛 순수 날짜순이면 작업이 먼저 와야 하지만,
  // 유형 우선순위(세션 먼저)가 날짜 순서를 뒤집는다는 것을 이 케이스로 증명한다.
  const sess = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, billing_amount)
       VALUES (?, '녹음', '2026-08-10', '10:00', '13:30', '완료', 300000)`
    )
    .run(pid);
  const sessionId = Number(sess.lastInsertRowid);

  const inv = createInvoiceFromTasks(CHIEF, { projectId: pid, taskIds: [taskId], sessionIds: [sessionId], clientId: PAYER, issueDate: "2026-08-15" });
  assert.ok(inv);
  const bundle = listInvoiceItemsForInvoice(CHIEF, inv.id);
  assert.strictEqual(bundle.rows.length, 2);
  assert.strictEqual(bundle.rows[0].session_id, sessionId, "세션이 날짜(8/10 > 작업 등록일 8/1)와 무관하게 먼저");
  assert.strictEqual(bundle.rows[0].item_date, "2026-08-10");
  assert.strictEqual(bundle.rows[1].task_id, taskId, "작업은 세션보다 이른 등록일이어도 세션 뒤로 밀린다");
  assert.strictEqual(bundle.rows[1].item_date, "2026-08-01");
});

// ── 청구 항목 유형 우선순위: task_id·session_id 둘 다 없는 수동/레거시 라인은 옛 순수 날짜순을 유지한다 ──
// (2026-08-22 추가 — invoiceItemsByInvoiceIds가 이 케이스를 이미 검증하지만, 생성 경로가 아니라 읽기 경로만
//  건드리므로 여기서도 직접 원본 SQL 순서를 짚어 회귀를 잠근다.)
test("청구 항목 정렬: task_id·session_id 둘 다 없는 수동 라인은 item_date 순수 날짜순", () => {
  const { listInvoiceItemsForInvoice } = require("../src/data");
  const inv = db().prepare("INSERT INTO invoices (title, amount, status, payer_id) VALUES ('수동청구서', 100, '발행', ?)").run(PAYER);
  const invoiceId = Number(inv.lastInsertRowid);
  const ins = db().prepare(
    "INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount, item_date) VALUES (?,?,1,?,?,?)"
  );
  ins.run(invoiceId, "나중", 50, 50, "2026-08-01");
  ins.run(invoiceId, "먼저", 50, 50, "2026-07-01");
  const bundle = listInvoiceItemsForInvoice(CHIEF, invoiceId);
  assert.strictEqual(bundle.rows.length, 2);
  assert.strictEqual(bundle.rows[0].description, "먼저", "수동 라인은 유형 그룹 없이 날짜순 그대로");
  assert.strictEqual(bundle.rows[1].description, "나중");
});

// ── 같은 날짜에 세션이 둘이면 시작 시간으로 구분한다(2026-08-22 사용자 리포트 '8/16 항목이 두 번 나와
//    중복처럼 보인다' — 설명 문구가 완전히 같아 클라이언트가 오류로 오해하기 쉬웠다) ──
test("청구 항목: 같은 날짜에 세션이 둘이면 설명에 시작 시간을 덧붙여 구분한다", () => {
  const pj = db().prepare("INSERT INTO projects (title, project_type, artist, rate) VALUES ('동일날짜테스트', 'task', '테스트아티스트', 0)").run();
  const pid = Number(pj.lastInsertRowid);
  const s1 = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, billing_amount)
       VALUES (?, '녹음', '2026-08-16', '10:00', '13:30', '완료', 300000)`
    )
    .run(pid);
  const s2 = db()
    .prepare(
      `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, billing_amount)
       VALUES (?, '녹음', '2026-08-16', '15:00', '18:30', '완료', 300000)`
    )
    .run(pid);
  const s1Id = Number(s1.lastInsertRowid), s2Id = Number(s2.lastInsertRowid);
  const inv = createInvoiceFromTasks(CHIEF, { projectId: pid, sessionIds: [s1Id, s2Id], clientId: PAYER, issueDate: "2026-08-20" });
  assert.ok(inv);
  const { listInvoiceItemsForInvoice } = require("../src/data");
  const bundle = listInvoiceItemsForInvoice(CHIEF, inv.id);
  const desc1 = bundle.rows.find((r) => r.session_id === s1Id).description;
  const desc2 = bundle.rows.find((r) => r.session_id === s2Id).description;
  assert.ok(desc1.includes("10:00"), `10시 세션 라인에 시작 시간 표기: ${desc1}`);
  assert.ok(desc2.includes("15:00"), `15시 세션 라인에 시작 시간 표기: ${desc2}`);
  assert.notStrictEqual(desc1, desc2, "두 세션의 라인 설명이 서로 달라야 한다(중복처럼 보이지 않게)");
});

// ── 프로젝트 목록·상세 금액의 청구서 할인 차감(2026-07-05 사용자 리포트: 할인 적용 전 금액이 표시되던 버그) ──
// projectAmount(라우트) = task_total + session_amount_total − invoice_discount_total.
// 데이터 파생을 잠근다: 라인(작업·세션) 연결된 from-tasks 청구서 할인만 합산.
// 수동 청구서(라인 무연결)는 프로젝트 버짓에 라인 자체가 안 잡히므로 그 할인을 빼면 이중 차감 — 제외.
test("프로젝트 금액 할인 차감: from-tasks 청구서 할인만 invoice_discount_total로 파생", () => {
  const { projectId, taskId } = seedTask(1_000_000);
  createInvoiceFromTasks(CHIEF, { projectId, clientId: PAYER, taskIds: [taskId], issueDate: "2026-06-15", discount: 150_000 });
  // 수동 청구서(항목 무연결) 할인 990,000 — 파생에 포함되면 안 됨.
  db()
    .prepare(
      "INSERT INTO invoices (project_id, title, amount, tax_amount, discount_amount, status, issued_date) VALUES (?, '수동 청구', 110000, 10000, 990000, '발행', '2026-06-15')"
    )
    .run(projectId);
  const row = listProjects(CHIEF, {}).find((p) => p.id === projectId);
  assert.strictEqual(Number(row.task_total), 1_000_000, "확정 라인 합은 할인 전 그대로");
  assert.strictEqual(Number(row.invoice_discount_total), 150_000, "라인 연결 청구서 할인만 파생(수동 제외)");
  const one = getProjectForUser(CHIEF, projectId);
  assert.strictEqual(Number(one.invoice_discount_total), 150_000, "단건 조회(상세)도 동일 파생");
});
