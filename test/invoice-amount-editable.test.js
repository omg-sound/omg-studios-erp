"use strict";

// 청구 화면 금액칸 계약(2026-07-29 — 가격 유형 폐기).
//
// 옛 '가격 유형'(fixed=잠금 / base / minimum=상향만)은 없앴다. 실제 운영에서 협의 감액이 늘 생기는데
// 잠긴 칸은 그때마다 카탈로그를 고치러 가게 만들었고, 같은 감액을 '금액 수정'과 '청구서 할인' 두 경로로
// 할 수 있어 어느 쪽으로 잡았는지에 따라 기록이 갈렸다.
// → 금액은 **언제나 수정 가능**하고, 조정 사유 메모는 **항상** 받는다(청구 생성 시 근거로 스냅샷).
// (이 파일은 옛 test/invoice-price-type.test.js를 대체한다.)

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { unbilledInvoiceForm } = require("../src/views.projects");
const { listUnbilledTasksForProject, listBillableSessionsForProject, listTaskTypes, getProjectForUser } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const projectId = Number(db().prepare("INSERT INTO projects (title, artist, project_type, rate) VALUES ('금액칸 프로젝트', '루나', 'session', 0)").run().lastInsertRowid);
const trackId = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '타이틀곡', 'Music')").run(projectId).lastInsertRowid);
const rateId = db().prepare("SELECT id FROM rate_items LIMIT 1").get().id;

// 작업 1건 + 세션 1건(단가 있음) — 금액이 산정되는 정상 후보를 만든다.
db().prepare(
  `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
   VALUES (?, ?, 'Fixed_Per_Track', 1, 200000, 200000, 'Completed', 0)`
).run(trackId, listTaskTypes()[0].key);
db().prepare(
  `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id)
   VALUES (?, '녹음', '2026-09-10', '14:00', '18:00', '완료', ?)`
).run(projectId, rateId);

function renderForm() {
  const project = getProjectForUser(CHIEF, projectId);
  const tasks = listUnbilledTasksForProject(CHIEF, projectId).rows;
  const sessions = listBillableSessionsForProject(CHIEF, projectId).rows;
  return unbilledInvoiceForm(project, tasks, sessions);
}

test("금액칸: readonly·하한(data-line-min) 없이 항상 수정 가능", () => {
  const html = renderForm();
  const amountInputs = html.match(/<input[^>]*data-line-input[^>]*>/g) || [];
  assert.ok(amountInputs.length >= 2, "작업·세션 금액칸이 렌더된다");
  assert.ok(!html.includes("data-line-min"), "최소가 하한 속성 없음");
  for (const tag of amountInputs) assert.ok(!/readonly/.test(tag), `금액칸이 잠기지 않는다: ${tag.slice(0, 90)}`);
});

test("조정 사유 메모는 모든 금액칸에 함께 나온다(옛 유형별 노출 폐지)", () => {
  const html = renderForm();
  assert.match(html, /name="session_billing_memo_\d+"/, "세션 행 조정 사유");
  assert.match(html, /name="task_billing_memo_\d+"/, "작업 행 조정 사유");
});

test("옛 가격 유형 잔재가 화면에 없다", () => {
  const html = renderForm();
  for (const stale of ["고정 · 초과", "최소가 — 상향만", "price_type"]) {
    assert.ok(!html.includes(stale), `옛 가격 유형 잔재 '${stale}' 없음`);
  }
});
