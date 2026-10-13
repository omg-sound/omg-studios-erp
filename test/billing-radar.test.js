"use strict";

// ── 격리 DB 셋업: src/* require 이전에 환경변수부터 설정 ──
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const { createSession, setSessionStatus, setSessionWaived, listProjects, listBillableSessionsForProject, splitProjectTabs, hasPostprodSessionNeedingBilling } = require("../src/data");

init();

/**
 * '청구 빠뜨림 방지 엔진'이 실제로 청구를 빠뜨리던 두 경로 — 2026-07-23 기능성 평가.
 *
 * ① **단가 항목 미선택 완료 대관 세션**이 청구 후보와 미청구 집계 **양쪽에서 동시에** 사라져,
 *    프로젝트가 조용히 '완료' 탭으로 넘어갔다(매출이 소리 없이 빠짐).
 *    → 후보 목록에 **흐리게** 남기고(billing=null) 미청구 집계에도 넣는다. 탈출구는 '청구 안 함'(waived).
 * ② **진행 중 프로젝트의 미청구 완료 세션**은 다가오는 세션이 1건만 있어도 '청구 필요'에서 통째로 빠졌다
 *    (`is_completed`가 `upcoming_cnt===0`을 요구) → 장기 앨범일수록 청구가 늦어졌다.
 *    → 탭 3분류(상호배타)는 그대로 두고, `unbilled_cnt`를 **완료 여부와 무관하게** 신호로 쓴다(배지·대시보드).
 */

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };

const roomA = Number(db().prepare("INSERT INTO rooms (name, active) VALUES ('A룸',1)").run().lastInsertRowid);
let seq = 0;
function seedProject(title) {
  seq += 1;
  return Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES (?, 'session', 0)").run(`${title}${seq}`).lastInsertRowid);
}

/** 대관 세션 1건. */
function seedSession(projectId, { date, done = true }) {
  const s = createSession(CHIEF, projectId, {
    session_type: "녹음",
    session_date: date,
    start_time: "14:00",
    end_time: "18:00",
    room_id: roomA,
  });
  if (done) setSessionStatus(CHIEF, s.id, "완료");
  return s;
}

const projectRow = (id) => listProjects(CHIEF, {}).find((p) => p.id === id);

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// ── ① 단가 항목 미선택 세션 ──

test("단가 미선택 완료 대관 세션이 청구 후보에 남는다(수동 금액 — 개편 1단계)", () => {
  const pid = seedProject("단가미선택");
  const s = seedSession(pid, { date: "2026-11-03" });

  const { rows } = listBillableSessionsForProject(CHIEF, pid);
  assert.strictEqual(rows.length, 1, "후보 목록에서 사라지면 사용자가 이유를 알 길이 없다");
  assert.strictEqual(rows[0].id, s.id);
  assert.ok(rows[0].billing && rows[0].billing.manual, "단가 없음 = 수동 금액(청구 폼에서 직접 입력)");
  assert.strictEqual(rows[0].billing.amount, 0, "확정액이 없으면 0 — 금액은 사람이 쓴다");
});

test("단가 미선택 세션을 입력 금액으로 바로 청구한다 — 라인 = 날짜 · 세션 종류, '조정 금액' 표기 없음", () => {
  const { createInvoiceFromTasks, createCompany, listInvoiceItemsForInvoice } = require("../src/data");
  const payer = createCompany({ name: "수동청구처", biz_no: "123-45-67891" });
  const pid = seedProject("수동청구");
  const s = seedSession(pid, { date: "2026-11-05" });

  assert.throws(
    () => createInvoiceFromTasks(CHIEF, { projectId: pid, clientId: payer, sessionIds: [s.id], issueDate: "2026-11-06" }),
    /TASK_AMOUNT_REQUIRED/,
    "금액을 안 쓰면 0원 — 확인 없이는 발행되지 않는다",
  );
  const inv = createInvoiceFromTasks(CHIEF, {
    projectId: pid, clientId: payer, sessionIds: [s.id], issueDate: "2026-11-06",
    sessionAmounts: { [s.id]: "350,000" },
  });
  assert.ok(inv, "단가 항목 없이도 발행된다");
  const items = listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.strictEqual(items.length, 1, "수동 금액은 기본가·초과로 쪼개지 않는다");
  assert.strictEqual(items[0].amount, 350000);
  assert.match(items[0].description, /녹음/);
  assert.doesNotMatch(items[0].description, /조정 금액/, "처음부터 사람이 쓴 금액이라 '조정'이 아니다");
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 0, "청구 후 미청구 집계에서 빠진다");
});

test("단가 미선택 완료 대관 세션이 미청구 집계에 잡힌다 — 프로젝트가 '완료'로 새지 않는다", () => {
  const pid = seedProject("단가미선택집계");
  seedSession(pid, { date: "2026-11-08" });

  const p = projectRow(pid);
  assert.strictEqual(Number(p.unbilled_cnt), 1, "미청구 집계에서 빠지면 프로젝트가 조용히 완료 탭으로 간다");
  assert.strictEqual(p.is_completed, true, "다가오는 세션·미완료 작업 없음 = 완료 상태 자체는 맞다");
  const { billing } = splitProjectTabs([p]);
  assert.strictEqual(billing.length, 1, "'청구 필요' 탭에 남아야 한다");
});

test("'청구 안 함'(무료 처리)이 탈출구 — 미청구 집계에서 빠진다", () => {
  const pid = seedProject("단가미선택무료");
  const s = seedSession(pid, { date: "2026-11-13" });
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 1);

  setSessionWaived(CHIEF, s.id);
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 0, "무료 처리하면 더 이상 '필요'하지 않다");
  const { rows } = listBillableSessionsForProject(CHIEF, pid);
  assert.strictEqual(rows.length, 1, "되돌릴 수 있게 폼에는 계속 노출(waived 배지)");
  assert.strictEqual(rows[0].waived, 1);
});

test("비대관 세션(믹싱)은 여전히 청구 후보가 아니다 — 후반작업은 곡·콘텐츠로 청구(회귀)", () => {
  const pid = seedProject("믹싱세션");
  const s = createSession(CHIEF, pid, { session_type: "믹싱", session_date: "2026-11-23", start_time: "14:00", end_time: "18:00", room_id: roomA });
  setSessionStatus(CHIEF, s.id, "완료");

  assert.strictEqual(listBillableSessionsForProject(CHIEF, pid).rows.length, 0, "믹싱은 여전히 청구 후보 목록 대상이 아니다(곡·콘텐츠로 청구)");
  // 완료된 믹싱 세션 + 작업 0 + 청구서 0 = '청구 미착수'(2026-07-24 신설) → unbilled_cnt=1로 잡혀야
  // 조용히 '완료' 탭으로 새지 않는다(아래 ③ 후반작업 청구 레이더 케이스와 동일 시나리오).
  assert.strictEqual(Number(projectRow(pid).unbilled_cnt), 1);
});

// ── ② 진행 중 프로젝트의 미청구 완료 세션 ──

test("다가오는 세션이 있어도 완료 세션의 미청구는 unbilled_cnt에 잡힌다", () => {
  const pid = seedProject("장기앨범");
  seedSession(pid, { date: "2026-11-28" }); // 완료·미청구
  createSession(CHIEF, pid, { session_type: "녹음", session_date: "2099-12-31", start_time: "14:00", end_time: "18:00", room_id: roomA }); // 다가오는 예정

  const p = projectRow(pid);
  assert.strictEqual(p.is_completed, false, "다가오는 세션이 있으니 프로젝트는 진행 중");
  assert.ok(Number(p.unbilled_cnt) >= 1, "그래도 청구할 게 있다는 신호는 살아 있어야 한다(배지·대시보드가 이걸 쓴다)");

  // 탭 3분류는 상호배타 유지 — 진행 중에 남고 청구 필요 탭엔 안 뜬다(사용자 결정).
  const { active, billing, done } = splitProjectTabs([p]);
  assert.strictEqual(active.length, 1, "진행 중 탭에 남는다");
  assert.strictEqual(billing.length, 0, "탭 정의는 바꾸지 않는다");
  assert.strictEqual(done.length, 0);
});

// ── 뷰 계약 ──
const { projectListRow } = require("../src/views.projects");

const listRow = (over) => projectListRow(
  { id: 1, title: "장기앨범", artist: "루나", client_name: "뮤직팜", manager_name: "김엔지니어", created_at: "2026-07-01 10:00:00", task_total: 0, session_amount_total: 0, ...over },
  { sessions: [], tracks: [], taskTypes: [] },
  { tab: over && over.__tab ? over.__tab : "active" }
);

test("projectListRow: 진행 중 탭에서도 '청구 필요 N' 배지가 뜬다", () => {
  assert.match(listRow({ unbilled_cnt: 3 }), /청구 필요 3/, "진행 중 프로젝트의 미청구가 목록에서 보여야 한다");
  assert.doesNotMatch(listRow({ unbilled_cnt: 0 }), /청구 필요/, "미청구 0이면 배지 없음");
});

// ── 모바일 레이아웃 계약(2026-07-23 사용자 리포트 — 실측 후 수정) ──
// 한 줄 flex에 [체크박스·라벨·'청구 안 함'·금액칸 112px]를 다 넣으면 390px에서 라벨에 42px만 남고,
// 한글은 음절 단위로 줄바꿈돼 행 높이가 221px로 부풀었다(실측). 구조가 되돌아가면 같은 증상이 재발한다.
// ⚠️ jsdom엔 레이아웃이 없어 폭은 못 잰다 — 여기선 **마크업 계약**만 잠그고, 실제 폭은 브라우저 실측으로 확인했다.
// ── ③ 후반작업(믹싱/마스터링) 세션 청구 레이더 (2026-07-24) ──

/** 믹싱 세션 1건. done=true면 완료 처리. */
function seedMixSession(projectId, { date = "2026-07-01", done = true } = {}) {
  const s = createSession(CHIEF, projectId, {
    session_type: "믹싱",
    session_date: date,
    start_time: "14:00",
    end_time: "18:00",
    room_id: roomA,
  });
  if (done) setSessionStatus(CHIEF, s.id, "완료");
  return s;
}

/** 프로젝트에 작업 1건 직접 삽입(직접 INSERT = 이 파일 셋업 스타일). 반환=taskId. */
function seedTask(projectId, { waived = 0, invoiced = 0 } = {}) {
  return Number(
    db()
      .prepare("INSERT INTO track_tasks (project_id, task_type, billing_type, quantity, unit_price, total_price, status, waived, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 0, 0, 'Completed', ?, ?)")
      .run(projectId, waived, invoiced).lastInsertRowid
  );
}

test("믹싱 세션만 완료 + 작업 0 + 청구서 0 → 청구 필요(완료로 안 감)", () => {
  const pid = seedProject("믹스레이더");
  seedMixSession(pid, { done: true });
  const p = projectRow(pid);
  assert.ok(p.is_completed, "다가오는 세션·미완료 작업 없음 → is_completed");
  assert.ok(p.unbilled_cnt > 0, "후반작업 청구 미착수 → unbilled_cnt>0");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.billing.length, 1, "청구 필요 탭에 있어야");
  assert.equal(tabs.done.length, 0, "완료 탭엔 없어야");
});

test("곡·콘텐츠 작업이 생기면 후반작업 항이 꺼진다(작업 기반 분류가 이어받음)", () => {
  const pid = seedProject("믹스작업생김");
  seedMixSession(pid, { date: "2026-07-05", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  seedTask(pid, { waived: 0, invoiced: 0 }); // 미청구 작업
  const p = projectRow(pid);
  // 후반작업 항은 꺼지지만(작업 존재), 미청구 작업이 unbilled_cnt를 채운다 → 여전히 청구 필요
  assert.ok(p.unbilled_cnt > 0);
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.billing.length, 1);
});

test("작업을 '청구 안 함'(waive) 하면 완료로 간다", () => {
  const pid = seedProject("믹스무료");
  seedMixSession(pid, { date: "2026-07-10", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  seedTask(pid, { waived: 1, invoiced: 0 }); // 작업 존재(후반작업 항 꺼짐) + waived(작업 항 0)
  const p = projectRow(pid);
  assert.equal(p.unbilled_cnt, 0, "작업 존재로 후반작업 항 꺼짐 + waived로 작업 항 0");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.done.length, 1, "완료 탭");
});

test("예정(미래) 믹싱 세션만 있으면 미가산(조기 청구 필요 방지)", () => {
  const pid = seedProject("믹스예정");
  seedMixSession(pid, { date: "2999-01-01", done: false }); // 미래·예정
  const p = projectRow(pid);
  // 다가오는 예정 세션이 있으니 is_completed=false → 진행 중, 후반작업 항 미가산
  assert.equal(p.is_completed, false, "다가오는 세션 있음 → 진행 중");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.active.length, 1, "진행 중 탭");
  assert.equal(Number(p.unbilled_cnt), 0, "미래 예정 후반작업 세션은 후반작업 항에 미가산(조기 배지 방지)");
});

// ── ④ 청구 탭 안내 문구 (2026-07-25) ──

test("hasPostprodSessionNeedingBilling: unbilled_cnt 후반작업 항과 정합", () => {
  const pid = seedProject("헬퍼정합");
  seedMixSession(pid, { date: "2026-07-15", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  assert.equal(hasPostprodSessionNeedingBilling(pid), true, "세션만·작업0·청구서0 → true");
  seedTask(pid, { waived: 0, invoiced: 0 });
  assert.equal(hasPostprodSessionNeedingBilling(pid), false, "작업 생기면 false(청구 준비 시작)");
});

test("hasPostprodSessionNeedingBilling: 완료 아닌 세션(미래·지난 예정)은 false", () => {
  const future = seedProject("헬퍼예정미래");
  seedMixSession(future, { date: "2998-01-01", done: false });
  assert.equal(hasPostprodSessionNeedingBilling(future), false, "미래 예정 세션은 완료 아니라 제외");
  const past = seedProject("헬퍼예정지난");
  seedMixSession(past, { date: "2020-06-01", done: false });
  assert.equal(hasPostprodSessionNeedingBilling(past), false, "지난 예정 세션도 완료 아니라 제외(날짜 게이트 제거 후)");
});

test("projectBillingSummary(개편 3단계 — 프로젝트 청구 탭): 후보 0 + 후반작업 플래그 → 안내 문구, 대기함 링크", () => {
  const { projectBillingSummary } = require("../src/views.billing");
  const proj = { id: 77, title: "x", internal_support: 0 };
  const withFlag = projectBillingSummary({ project: proj, items: [], postprod: true });
  assert.match(withFlag, /작업을 만들어야 청구할 수 있습니다/);
  const noFlag = projectBillingSummary({ project: proj, items: [], postprod: false });
  assert.doesNotMatch(noFlag, /작업을 만들어야/);
  const withItems = projectBillingSummary({ project: proj, items: [{ kind: "session", label: "10월 2일 · 녹음", done: true, amount: null, waived: false }] });
  assert.match(withItems, /href="\/invoices\/inbox\?project=77"/, "청구서는 대기함에서 — 이 프로젝트로 걸러 연다");
  assert.match(withItems, /금액 미정/);
  assert.match(projectBillingSummary({ project: { ...proj, internal_support: 1 } }), /내부 지원/);
});

// ── ⑤ 내부 지원 프로젝트(청구 대상 아님, 2026-08-26) ──

test("internal_support=1: 완료 후반작업 세션 + 미청구 작업 있어도 unbilled_cnt=0, done 탭으로 분류", () => {
  const pid = seedProject("내부지원후반");
  db().prepare("UPDATE projects SET internal_support=1 WHERE id=?").run(pid);
  seedMixSession(pid, { date: "2026-07-20", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  seedTask(pid, { waived: 0, invoiced: 0 });
  const p = projectRow(pid);
  assert.equal(Number(p.unbilled_cnt), 0, "내부 지원 프로젝트는 미청구 신호가 항상 0");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.done.length, 1, "완료 탭(청구 필요 아님)으로 분류");
  assert.equal(tabs.billing.length, 0, "청구 필요 탭엔 안 들어감");
});

test("internal_support=1: hasPostprodSessionNeedingBilling 자체는 그대로 true(호출부에서 게이트)", () => {
  const pid = seedProject("내부지원안내");
  db().prepare("UPDATE projects SET internal_support=1 WHERE id=?").run(pid);
  seedMixSession(pid, { date: "2026-07-21", done: true }); // roomA 시간 겹침 방지 — 다른 날짜
  assert.equal(hasPostprodSessionNeedingBilling(pid), true, "이 함수 자체는 internal_support를 모른다 — 라우트(projects.routes.js)가 p.internal_support로 게이트");
});

// ── ④ 세션 완료 판정 버튼 기준 (2026-07-25) ──

test("지난 예정 세션(완료 안 누름)은 진행 중에 머문다(전엔 완료/청구필요로 샜음)", () => {
  const pid = seedProject("버튼기준지난예정");
  seedMixSession(pid, { date: "2020-03-01", done: false }); // 지난 날짜·예정(완료 안 누름)
  const p = projectRow(pid);
  assert.equal(p.is_completed, false, "예정 세션 있으면 완료 아님(sess_scheduled>0)");
  assert.equal(Number(p.unbilled_cnt), 0, "완료 안 눌렀으니 청구 배지도 안 뜸(postprod status='완료'만)");
  const tabs = splitProjectTabs([p]);
  assert.equal(tabs.active.length, 1, "진행 중 탭");
  assert.equal(tabs.done.length, 0);
  assert.equal(tabs.billing.length, 0);
});

test("지난 예정 세션을 완료 처리하면 청구 필요로 간다(믹싱·작업0)", () => {
  const pid = seedProject("버튼기준완료전이");
  const s = seedMixSession(pid, { date: "2020-04-01", done: false });
  setSessionStatus(CHIEF, s.id, "완료"); // 명시적 완료
  const p = projectRow(pid);
  assert.equal(p.is_completed, true, "예정 세션 0(전부 완료) → 완료 판정 가능");
  assert.ok(Number(p.unbilled_cnt) > 0, "완료 믹싱 세션+작업0 → 후반작업 항 가산");
  assert.equal(splitProjectTabs([p]).billing.length, 1, "청구 필요 탭");
});

test("취소 세션은 완료 판정을 막지 않는다", () => {
  const pid = seedProject("버튼기준취소");
  const s = seedMixSession(pid, { date: "2020-05-01", done: false });
  db().prepare("UPDATE sessions SET status='취소' WHERE id=?").run(s.id); // 취소 처리
  const p = projectRow(pid);
  assert.equal(p.is_completed, true, "취소는 예정이 아니라 진행을 막지 않음(작업도 없으니 완료 판정)");
});
