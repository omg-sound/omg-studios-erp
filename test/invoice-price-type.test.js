"use strict";

// 청구 화면의 가격 유형 반영(2026-07-26): fixed=기본가 잠금 / base·minimum=자동 입력 후 수정 + 조정 사유.
//
// ⚠️ 잠금은 **산정치가 정해졌을 때만** 건다. 가격 유형이 fixed라도 카탈로그 단가가 0인 항목
// ('금액 미정' 정액 세션·단가 미정 작업 종류)은 청구 시 입력해야 하므로 잠그면 아예 청구가 불가능해진다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { unbilledInvoiceForm } = require("../src/views.projects");
const { listUnbilledTasksForProject, listBillableSessionsForProject, updateTaskType, listTaskTypes, createRateItem, getProjectForUser } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const rateId = (name) => db().prepare("SELECT id FROM rate_items WHERE name = ?").get(name).id;
const ttId = (key) => listTaskTypes({ includeInactive: true }).find((t) => t.key === key).id;

const projectId = Number(db().prepare("INSERT INTO projects (title, artist, project_type, rate) VALUES ('유형 프로젝트', '루나', 'session', 0)").run().lastInsertRowid);
const trackId = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '타이틀곡', 'Music')").run(projectId).lastInsertRowid);

function addTask(taskKey, price) {
  return Number(
    db()
      .prepare(
        `INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced)
         VALUES (?, ?, 'Fixed_Per_Track', 1, ?, ?, 'Completed', 0)`
      )
      .run(trackId, taskKey, price, price).lastInsertRowid
  );
}
function addSession(rate, { start = "14:00", end = "18:00" } = {}) {
  return Number(
    db()
      .prepare(
        `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id)
         VALUES (?, '녹음', '2026-09-10', ?, ?, '완료', ?)`
      )
      .run(projectId, start, end, rate).lastInsertRowid
  );
}

/** 청구 생성 폼 HTML(그 프로젝트의 현재 후보 기준). */
function renderForm() {
  const project = getProjectForUser(CHIEF, projectId);
  const tasks = listUnbilledTasksForProject(CHIEF, projectId).rows;
  const sessions = listBillableSessionsForProject(CHIEF, projectId).rows;
  return unbilledInvoiceForm(project, tasks, sessions);
}

/** name으로 금액 input 태그 한 조각을 뽑는다. */
function inputFor(html, name) {
  const m = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
  return m ? m[0] : "";
}

test("고정(fixed) 세션 항목: 금액칸 잠금 + '초과·할증 자동' 안내", () => {
  addSession(rateId("솔로 녹음"));
  const html = renderForm();
  const inp = inputFor(html, "session_amount_1");
  assert.match(inp, /readonly/, "고정 항목은 사람이 손댈 값이 없다");
  assert.match(html, /고정 · 초과·할증 자동/);
  assert.doesNotMatch(html, /name="session_billing_memo_1"/, "잠긴 칸에 조정 사유를 묻지 않는다");
});

test("기준가(base) 작업: 금액 자동 입력 + 수정 가능 + 조정 사유 칸", () => {
  const id = addTask("Mixing", 0); // 카탈로그 기본단가(100만)가 자동 적용된다
  const html = renderForm();
  const inp = inputFor(html, `task_amount_${id}`);
  assert.match(inp, /value="1000000"/, "기준가 자동 입력");
  assert.doesNotMatch(inp, /readonly/, "위아래로 조정 가능");
  assert.doesNotMatch(inp, /data-line-min/, "기준가는 하한이 없다");
  assert.doesNotMatch(html, /기준가 — 조정 가능/, "기준가는 안내 문구 없음(2026-07-28 사용자 요청 — 그냥 고칠 수 있는 칸이라 설명 불필요)");
  assert.match(html, new RegExp(`name="task_billing_memo_${id}"`), "조정 사유 칸");
});

test("최소가(minimum) 작업: 하한(data-line-min)이 걸린다", () => {
  const id = addTask("Vocal_Tuning", 0); // 최소가 20만
  const html = renderForm();
  const inp = inputFor(html, `task_amount_${id}`);
  assert.match(inp, /value="200000"/);
  assert.match(inp, /data-line-min="200000"/, "그 아래로는 못 내린다");
  assert.doesNotMatch(inp, /readonly/);
  assert.match(html, /최소가 — 상향만/);
});

test("고정이라도 카탈로그 단가가 0이면 잠그지 않는다(금액 미정 — 청구 시 입력)", () => {
  // 단가 미정 작업 종류(기본단가 0·fixed) — 잠그면 아예 청구할 수 없다.
  updateTaskType(ttId("Audio_Editing"), { label: "오디오 편집", billing_type: "Fixed_Per_Track", unit_price: "0", price_type: "fixed", is_quick: "1" });
  const id = addTask("Audio_Editing", 0);
  const html = renderForm();
  const inp = inputFor(html, `task_amount_${id}`);
  assert.doesNotMatch(inp, /readonly/, "금액 미정 항목은 입력할 수 있어야 한다");
});

test("정액·금액 미정 세션 항목도 잠기지 않는다", () => {
  const flat = createRateItem({ rate_name: "플레이백 세션", category: "공연", base_hours: "", base_price: "", extra_hours: "1", extra_price: "" });
  const sid = Number(
    db()
      .prepare(
        `INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id)
         VALUES (?, '공연', '2026-09-11', '18:00', '20:00', '완료', ?)`
      )
      .run(projectId, flat.id).lastInsertRowid
  );
  const html = renderForm();
  const inp = inputFor(html, `session_amount_${sid}`);
  assert.doesNotMatch(inp, /readonly/, "산정 0원(금액 미정)은 청구 시 입력");
});
