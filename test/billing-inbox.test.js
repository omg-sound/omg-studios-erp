"use strict";

// ── 개편 3단계: 청구 대기함 · 직접 기입 청구서 (docs/redesign/03-billing-inbox.md) ──
// 잠그는 계약:
//  · 대기함 = 모든 프로젝트의 미청구 세션(대관)·작업. 내부 지원·믹싱/마스터링 세션·청구 안 함·이미 청구된 건 빠진다
//  · 청구서 = 라인 배열(세션·작업·자유 줄) + 직접 쓴 내용·금액. 단가표 산정 없음
//  · 여러 프로젝트를 섞으면 invoices.project_id = NULL, 프로젝트 화면·할인 배분은 라인에서 파생
//  · 발행 = 세션 완료·확정액 기록 / 작업 Completed·청구됨. 삭제하면 대기함으로 복원
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const D = require("../src/data");

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const d = db();
test.after(() => cleanupDb(process.env.DB_PATH, d));

const PAYER = D.createCompany({ name: "대기함기획사", biz_no: "123-45-60001" });
let seq = 0;
function project(title, extra = {}) {
  seq += 1;
  return Number(d.prepare("INSERT INTO projects (title, project_type, rate, artist, internal_support) VALUES (?, 'session', 0, ?, ?)").run(`${title}${seq}`, extra.artist || null, extra.internal ? 1 : 0).lastInsertRowid);
}
function session(pid, { date = "2026-10-02", type = "녹음", status = "완료", start = "14:00", end = "18:00", amount = null } = {}) {
  return Number(d.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, billing_amount) VALUES (?, ?, ?, ?, ?, ?, ?)").run(pid, type, date, start, end, status, amount).lastInsertRowid);
}
function task(pid, { song = null, type = "Mixing", status = "Completed", price = 0, workDate = null } = {}) {
  return D.createTask(CHIEF, pid, { task_type: type, song_title: song, status, unit_price: price ? String(price) : "", work_date: workDate }).id;
}

test("대기함: 모든 프로젝트의 미청구 세션·작업 — 내부 지원·후반작업 세션·청구 안 함·이미 청구된 건은 빠진다", () => {
  const a = project("대기A", { artist: "진혁" });
  const b = project("대기B");
  const internal = project("대기내부", { internal: true });
  const s1 = session(a, { date: "2026-10-01", amount: 300000 });
  session(a, { type: "믹싱" }); // 후반작업 세션 → 대기함 아님
  const t1 = task(b, { song: "타이틀" });
  session(internal);
  const waivedS = session(b, { date: "2026-10-03" });
  D.setSessionWaived(CHIEF, waivedS);

  const { groups, count } = D.listBillableItems(CHIEF, { q: "대기" });
  const keys = groups.flatMap((g) => g.items.map((i) => i.key));
  assert.ok(keys.includes(`s${s1}`) && keys.includes(`t${t1}`));
  assert.ok(!groups.some((g) => g.project.id === internal), "내부 지원 프로젝트 제외");
  assert.ok(!keys.includes(`s${waivedS}`), "청구 안 함은 기본 숨김");
  assert.equal(count, keys.length);
  assert.equal(groups.find((g) => g.project.id === a).items[0].amount, 300000, "적어 둔 확정액은 그대로");
  assert.equal(groups.find((g) => g.project.id === b).items.find((i) => i.kind === "task").amount, null, "작업 기본 단가 없음 — 금액 미정");

  const withWaived = D.listBillableItems(CHIEF, { q: "대기", showWaived: true });
  assert.ok(withWaived.groups.flatMap((g) => g.items).some((i) => i.key === `s${waivedS}` && i.waived), "'청구 안 함 보기'면 되돌리기용으로 보인다");
  // '지난 일정만'(개편 5단계 — 완료 상태 대신 날짜): 오늘 이후 세션만 빠지고 작업은 그대로(등록=수주).
  const futureS = session(a, { date: "2099-01-01", status: "예정" });
  const all = D.listBillableItems(CHIEF, { q: "대기" }).groups.flatMap((g) => g.items);
  assert.ok(all.find((i) => i.key === `s${futureS}`).future, "오늘 이후 세션 = future(화면이 흐리게·확인)");
  assert.ok(!all.find((i) => i.key === `s${s1}`).future, "지난 세션 = 보통");
  assert.ok(!all.find((i) => i.key === `t${t1}`).future, "작업은 늘 청구 가능");
  const pastOnly = D.listBillableItems(CHIEF, { q: "대기", pastOnly: true }).groups.flatMap((g) => g.items);
  assert.ok(!pastOnly.some((i) => i.key === `s${futureS}`), "지난 일정만 = 미래 세션 제외");
  assert.ok(pastOnly.some((i) => i.key === `t${t1}`), "작업은 남는다");
  d.prepare("DELETE FROM sessions WHERE id = ?").run(futureS);
  const ranged = D.listBillableItems(CHIEF, { q: "대기", from: "2026-10-02" });
  assert.ok(!ranged.groups.flatMap((g) => g.items).some((i) => i.key === `s${s1}`), "기간 필터(세션 날짜)");
});

test("후반작업 세션 알림: 날짜가 된 믹싱 세션만 있고 작업·청구서가 없는 프로젝트는 postprod로", () => {
  const p = project("후반알림");
  session(p, { type: "믹싱", status: "완료" });
  const r = D.listBillableItems(CHIEF, { q: "후반알림" });
  assert.equal(r.groups.length, 0, "대기함엔 없다(작업으로 청구)");
  assert.ok(r.postprod.some((x) => x.id === p), "대신 알림 목록에");
  // 상태와 무관하게 날짜가 지난 믹싱 세션이면 알림(개편 5단계 — 완료 버튼 없음) — 미래 세션·작업 있는 프로젝트는 제외
  const forgot = project("후반알림예정");
  session(forgot, { type: "믹싱", status: "예정", date: "2026-01-10" });
  const upcoming = project("후반알림미래");
  session(upcoming, { type: "믹싱", status: "예정", date: "2099-01-10" });
  const withTask = project("후반알림작업");
  session(withTask, { type: "믹싱", status: "예정", date: "2026-01-10" });
  task(withTask, { song: "곡" });
  const ids = D.listBillableItems(CHIEF, { q: "후반알림" }).postprod.map((x) => x.id);
  assert.ok(ids.includes(forgot), "지난 예정 믹싱 = 알림");
  assert.ok(!ids.includes(upcoming), "앞으로 잡힌 세션은 아직");
  assert.ok(!ids.includes(withTask), "작업이 있으면 그 작업이 대기함에 오른다");
});

test("여러 프로젝트를 한 청구서로: project_id NULL · 양쪽 프로젝트에서 보임 · 제목 기본값 · 자유 줄", () => {
  const a = project("섞기A", { artist: "가수A" });
  const b = project("섞기B", { artist: "가수B" });
  const s1 = session(a, { date: "2026-10-05", status: "예정" });
  const t1 = task(b, { song: "곡B", status: "Pending" });
  const inv = D.createInvoice(CHIEF, {
    payerId: PAYER, issueDate: "2026-10-31",
    lines: [
      { kind: "task", id: t1, description: "", amount: "200,000" },
      { kind: "session", id: s1, description: "", amount: "300000" },
      { kind: "free", description: "계약금", amount: "100000", date: "2026-10-01" },
      { kind: "free", description: "", amount: "" }, // 빈 자유 줄은 무시
    ],
  });
  assert.equal(inv.project_id, null, "여러 프로젝트 = NULL");
  assert.equal(inv.title, "대기함기획사 10월 청구", "제목 기본값");
  assert.equal(inv.amount, 660000, "공급가 600,000 + VAT");
  const rows = D.listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.deepEqual(rows.map((r) => (r.session_id ? "s" : r.task_id ? "t" : "f")), ["s", "t", "f"], "세션 → 작업 → 자유 줄");
  assert.match(rows[0].description, /10월 5일 · 가수A · 녹음/);
  assert.match(rows[1].description, /^곡B - /);
  assert.equal(rows[2].description, "계약금");
  // 발행 = 청구됨 + 확정액. 상태는 바꾸지 않는다(개편 5단계 — 완료 개념 없음)
  const s = d.prepare("SELECT status, billing_amount FROM sessions WHERE id = ?").get(s1);
  assert.deepEqual([s.status, s.billing_amount], ["예정", 300000]);
  const t = d.prepare("SELECT status, is_invoiced, total_price FROM track_tasks WHERE id = ?").get(t1);
  assert.deepEqual([t.status, t.is_invoiced, t.total_price], ["Pending", 1, 200000]);
  // 두 프로젝트 화면 모두에서 보인다
  for (const pid of [a, b]) assert.ok(D.listInvoicesForProject(CHIEF, pid).rows.some((r) => r.id === inv.id), `프로젝트 ${pid} 청구 탭`);
  assert.deepEqual(D.projectsForInvoice(inv.id).map((p) => p.id).sort(), [a, b].sort());
  assert.match(D.getInvoiceForUser(CHIEF, inv.id).project_title, /^여러 프로젝트 \(2\)$/);
  // 대기함에서 빠진다
  const keys = D.listBillableItems(CHIEF, { q: "섞기" }).groups.flatMap((g) => g.items.map((i) => i.key));
  assert.ok(!keys.includes(`s${s1}`) && !keys.includes(`t${t1}`));
  // 삭제하면 돌아온다
  D.deleteInvoice(CHIEF, inv.id);
  const back = D.listBillableItems(CHIEF, { q: "섞기" }).groups.flatMap((g) => g.items.map((i) => i.key));
  assert.ok(back.includes(`s${s1}`) && back.includes(`t${t1}`), "청구서 삭제 = 대기함 복원");
});

test("할인 배분: 여러 프로젝트 청구서의 할인은 라인 금액 비례로 각 프로젝트에", () => {
  const a = project("할인A");
  const b = project("할인B");
  const s1 = session(a);
  const t1 = task(b);
  D.createInvoice(CHIEF, { payerId: PAYER, discount: 100000, lines: [{ kind: "session", id: s1, amount: "300000" }, { kind: "task", id: t1, amount: "100000" }] });
  const rows = D.listProjects(CHIEF, {});
  assert.equal(rows.find((r) => r.id === a).invoice_discount_total, 75000);
  assert.equal(rows.find((r) => r.id === b).invoice_discount_total, 25000);
  // 한 프로젝트 청구서(자유 줄 없음)는 할인 전액 — 종전과 같은 결과
  const c = project("할인C");
  const s2 = session(c);
  D.createInvoice(CHIEF, { payerId: PAYER, discount: 50000, lines: [{ kind: "session", id: s2, amount: "300000" }] });
  assert.equal(D.listProjects(CHIEF, {}).find((r) => r.id === c).invoice_discount_total, 50000);
});

test("검증: 청구처 필수 · 빈 금액은 확인 필요 · 같은 항목 두 번 · 이미 청구됨 · 내용 없는 자유 줄", () => {
  const p = project("검증");
  const s1 = session(p);
  assert.throws(() => D.createInvoice(CHIEF, { lines: [{ kind: "session", id: s1, amount: "1" }] }), /PAYER_REQUIRED/);
  assert.throws(() => D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "session", id: s1, amount: "" }] }), /TASK_AMOUNT_REQUIRED/);
  assert.throws(() => D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "session", id: s1, amount: "1" }, { kind: "session", id: s1, amount: "1" }] }), /TASK_NOT_BILLABLE/);
  assert.throws(() => D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "free", description: "", amount: "1000" }] }), /LINE_DESC_REQUIRED/);
  assert.throws(() => D.createInvoice(CHIEF, { payerId: PAYER, lines: [] }), /TASK_IDS_REQUIRED/);
  const ok = D.createInvoice(CHIEF, { payerId: PAYER, confirmZero: true, lines: [{ kind: "session", id: s1, amount: "" }] });
  assert.equal(ok.amount, 0, "확인하면 0원 발행(무료 협의)");
  assert.throws(() => D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "session", id: s1, amount: "1" }] }), /TASK_NOT_BILLABLE/, "이미 청구된 세션");
  assert.equal(D.createInvoice({ id: 9, role: "guest" }, { payerId: PAYER, lines: [{ kind: "free", description: "x", amount: "1" }] }), null, "권한 없음");
});

test("작성 화면 라인: 고른 키만(청구 불가 건은 skipped), 같은 날짜 세션은 시작 시간으로 구분, 다일 종일은 기간", () => {
  const p = project("작성", { artist: "루나" });
  const a = session(p, { date: "2026-10-07", start: "10:00", end: "12:00" });
  const b = session(p, { date: "2026-10-07", start: "15:00", end: "18:00" });
  const multi = Number(d.prepare("INSERT INTO sessions (project_id, session_type, session_date, end_date, all_day, status) VALUES (?, '녹음', '2026-09-01', '2026-09-04', 1, '완료')").run(p).lastInsertRowid);
  const r = D.composeLinesForKeys([`s${a}`, `s${b}`, `s${multi}`, "s999999", "garbage"]);
  assert.equal(r.skipped, 2);
  const label = (id) => r.lines.find((l) => l.id === id).label;
  assert.match(label(a), /10월 7일 10:00 · 루나 · 녹음/);
  assert.match(label(b), /10월 7일 15:00/);
  assert.match(label(multi), /9월 1일~9월 4일 · 루나 · 녹음/);
  assert.equal(r.projects.length, 1);
  // 설명을 비워 발행해도 같은 규칙(자동 설명)
  const inv = D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "session", id: a, amount: "1" }, { kind: "session", id: b, amount: "1" }] });
  const descs = D.listInvoiceItemsForInvoice(CHIEF, inv.id).rows.map((x) => x.description);
  assert.notEqual(descs[0], descs[1], "같은 날짜 두 세션이 중복처럼 보이지 않게");
});

test("매출 상세: 청구서 단위 그대로 — 작업 종류·세부·항목 수가 라인에서 파생된다", () => {
  const p = project("매출파생");
  const s1 = session(p);
  const inv = D.createInvoice(CHIEF, { payerId: PAYER, issueDate: "2026-10-10", lines: [{ kind: "session", id: s1, amount: "300000" }, { kind: "free", description: "출장비", amount: "50000" }] });
  d.prepare("UPDATE invoices SET tax_status = '계산서 발행' WHERE id = ?").run(inv.id);
  const row = D.revenueForPayer(PAYER).invoices.find((r) => r.id === inv.id);
  assert.ok(row, "청구처 상세에 노출");
  assert.equal(row.supply, 350000, "자유 줄도 매출(공급가)에 포함");
  assert.equal(row.work_kind, "녹음");
});

test("작업을 청구해도 세션 상태는 그대로 — 진행/완료는 날짜가 정한다(개편 5단계)", () => {
  const p = project("후반날짜");
  const past = session(p, { type: "믹싱", status: "예정", date: "2026-01-05" });
  const future = session(p, { type: "마스터링", status: "예정", date: "2099-01-01" });
  const t1 = task(p, { song: "곡" });
  D.createInvoice(CHIEF, { payerId: PAYER, lines: [{ kind: "task", id: t1, amount: "100000" }] });
  const st = (id) => d.prepare("SELECT status FROM sessions WHERE id = ?").get(id).status;
  assert.equal(st(past), "예정", "상태를 바꾸지 않는다");
  assert.equal(st(future), "예정");
  assert.equal(D.listProjects(CHIEF, {}).find((r) => r.id === p).is_completed, false, "미래 세션이 남아 있으니 진행 중");
  d.prepare("DELETE FROM sessions WHERE id = ?").run(future);
  const row = D.listProjects(CHIEF, {}).find((r) => r.id === p);
  assert.equal(row.is_completed, true, "미래 세션이 없으면 활동 끝남");
  assert.equal(Number(row.unbilled_cnt), 0, "작업이 청구됐으니 완료 탭");
});

