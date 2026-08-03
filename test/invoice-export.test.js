"use strict";

// ── 청구 내역 CSV(세무사·홈택스 제출용, 2026-08-03 사용자 요청) ──
// 매출 CSV(공급가·발생 기준 분석)와 달리 이쪽 축은 **계산서 발행·입금 현황**이다.
// 🔒 핵심 불변식: **화면 목록과 CSV가 같은 함수로 걸러진다**. 갈리면 "화면엔 12건인데 파일엔 30건"이 되고,
//    무엇이 빠졌는지 사람이 알 수 없어 그 파일을 신고 자료로 쓸 수 없다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { init, db } = require("../src/db");
init();

const { invoiceCsv, INVOICE_CSV_HEADERS } = require("../src/data");
const { filteredInvoices, periodPresets } = require("../src/routes/invoices.routes");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

// 거래처 2곳: 스냅샷을 가진 법인 + 스냅샷 없는(레거시) 개인
const orgId = Number(db().prepare("INSERT INTO parties (kind, name, biz_no, owner_name, email) VALUES ('company','(주)뮤직팜','123-45-67890','홍길동','tax@mp.kr')").run().lastInsertRowid);
const personId = Number(db().prepare("INSERT INTO parties (kind, name, cash_receipt_no, is_artist) VALUES ('person','루나','010-1234-5678',1)").run().lastInsertRowid);
const projectId = Number(db().prepare("INSERT INTO projects (title, project_type, rate, artist) VALUES ('루나 1집','session',0,'루나')").run().lastInsertRowid);

const mkInvoice = ({ no, payer, amount, tax, paid, taxStatus, issued, snapshot }) =>
  Number(db().prepare(
    `INSERT INTO invoices (project_id, payer_id, payer_snapshot, title, invoice_number, amount, tax_amount, discount_amount, paid_amount, status, issued_date, tax_status)
     VALUES (?,?,?,?,?,?,?,0,?, '발행', ?, ?)`
  ).run(projectId, payer, snapshot || null, "청구", no, amount, tax, paid, issued, taxStatus).lastInsertRowid);

// 발행 시점 스냅샷(그 뒤 상호가 바뀌어도 신고 근거는 발행 당시 값)
const SNAP = JSON.stringify({ name: "뮤직팜(구 상호)", biz_no: "999-88-77777", owner_name: "김대표", email: "old@mp.kr" });
mkInvoice({ no: "OMG-202601-001", payer: orgId, amount: 1100000, tax: 100000, paid: 1100000, taxStatus: "입금완료", issued: "2026-01-15", snapshot: SNAP });
mkInvoice({ no: "OMG-202602-001", payer: personId, amount: 500000, tax: 0, paid: 200000, taxStatus: "계산서 발행", issued: "2026-02-20" });
mkInvoice({ no: "OMG-202604-001", payer: orgId, amount: 330000, tax: 30000, paid: 0, taxStatus: "계산서 미발행", issued: "2026-04-05" });

const csvRows = (rows) => invoiceCsv(rows).trim().split("\r\n").slice(1).map((l) => l.split(","));

test("invoiceCsv: 세무 제출에 필요한 칸이 다 있다(사업자번호·현금영수증번호를 나눠서)", () => {
  assert.deepEqual(INVOICE_CSV_HEADERS, [
    "발행일", "청구번호", "거래처", "구분", "사업자번호", "현금영수증번호", "대표자",
    "프로젝트", "아티스트", "공급가", "VAT", "할인", "합계", "계산서상태", "입금액", "미수금", "발행이메일",
  ]);
});

test("invoiceCsv: 거래처 정보는 발행 시점 스냅샷이 우선", () => {
  const all = filteredInvoices(CHIEF, {});
  const r = csvRows(all).find((c) => c[1] === "OMG-202601-001");
  assert.equal(r[2], "뮤직팜(구 상호)", "지금 상호가 아니라 발행 당시 상호");
  assert.equal(r[4], "999-88-77777", "사업자번호도 발행 당시 값 — 신고 근거는 그때 것이다");
  assert.equal(r[6], "김대표");
});

test("invoiceCsv: 스냅샷 없는 레거시 건은 현재 거래처 값으로 채운다(빈칸으로 두지 않는다)", () => {
  const r = csvRows(filteredInvoices(CHIEF, {})).find((c) => c[1] === "OMG-202604-001");
  assert.equal(r[4], "123-45-67890", "현재 사업자번호로 폴백 — 비면 세무사가 상호로 되짚어야 한다");
  assert.equal(r[2], "(주)뮤직팜");
});

test("invoiceCsv: 구분은 발행 경로 — 사업자번호가 있으면 사업자, 개인은 현금영수증 칸으로", () => {
  const rows = csvRows(filteredInvoices(CHIEF, {}));
  const org = rows.find((c) => c[1] === "OMG-202604-001");
  const person = rows.find((c) => c[1] === "OMG-202602-001");
  assert.equal(org[3], "사업자");
  assert.equal(person[3], "개인");
  assert.equal(person[5], "010-1234-5678", "개인은 현금영수증 번호 칸");
  assert.equal(person[4], "", "사업자번호 칸은 비운다(두 축을 섞지 않는다)");
});

test("invoiceCsv: 금액은 공급가·VAT·합계·입금·미수가 따로 — 미수 = 합계 − 입금", () => {
  const r = csvRows(filteredInvoices(CHIEF, {})).find((c) => c[1] === "OMG-202602-001");
  assert.equal(r[9], "500000", "공급가(VAT 제외)");
  assert.equal(r[12], "1000000".slice(0, 0) + "500000", "합계(VAT 포함)");
  assert.equal(r[14], "200000", "입금액");
  assert.equal(r[15], "300000", "미수금");
});

test("filteredInvoices: 기간은 발행일 기준 — 분기로 자르면 그 안의 건만", () => {
  const q1 = filteredInvoices(CHIEF, { from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(q1.map((i) => i.invoice_number).sort(), ["OMG-202601-001", "OMG-202602-001"]);
  const q2 = filteredInvoices(CHIEF, { from: "2026-04-01", to: "2026-06-30" });
  assert.deepEqual(q2.map((i) => i.invoice_number), ["OMG-202604-001"]);
});

test("filteredInvoices: 기간+상태+검색이 함께 걸린다(화면 조건 그대로)", () => {
  const r = filteredInvoices(CHIEF, { from: "2026-01-01", to: "2026-12-31", filter: "todo" });
  assert.deepEqual(r.map((i) => i.invoice_number), ["OMG-202604-001"], "발행 필요 = 계산서 미발행");
  assert.equal(filteredInvoices(CHIEF, { q: "202602" }).length, 1, "청구번호 부분 검색");
  assert.equal(filteredInvoices(CHIEF, { q: "202602", from: "2026-04-01" }).length, 0, "기간 밖이면 검색해도 안 나온다");
});

test("filteredInvoices: 기간을 걸면 발행일 없는 건은 빠진다(어느 기간에도 못 넣는다)", () => {
  const noDate = mkInvoice({ no: "OMG-NODATE", payer: orgId, amount: 100, tax: 0, paid: 0, taxStatus: "계산서 미발행", issued: null });
  assert.ok(filteredInvoices(CHIEF, {}).some((i) => i.id === noDate), "기간 없으면 포함");
  assert.ok(!filteredInvoices(CHIEF, { from: "2026-01-01", to: "2026-12-31" }).some((i) => i.id === noDate), "기간 걸면 제외");
  db().prepare("DELETE FROM invoices WHERE id = ?").run(noDate);
});

test("periodPresets: 전체 + 이번/지난 분기 + 올해/작년, 분기는 3개월 경계로 잡힌다", () => {
  const ps = periodPresets();
  assert.equal(ps[0].range, null, "첫 항목은 '전체'(조건 없음)");
  const q = ps[1].range;
  assert.match(q.from, /^\d{4}-(01|04|07|10)-01$/, "분기 시작은 1·4·7·10월 1일");
  assert.match(q.to, /^\d{4}-(03|06|09|12)-(30|31)$/, "분기 끝은 3·6·9·12월 말일");
  assert.ok(q.from < q.to);
});
