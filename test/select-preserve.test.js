"use strict";

// ── PM 기록 보존 회귀 잠금(2026-08-02 사용자 결정 '기록은 기록이다 — PM이었던 기록이 남아도 된다') ──
// managerSelect는 활성 담당자만 옵션으로 냈다. 퇴사·비활성 처리된 사람이 PM인 프로젝트는 폼이 '미지정'으로
// 열리고, 정보 탭에서 **다른 항목만 고쳐 저장해도 manager_id가 null**이 됐다(라우트가 빈 값을 null로 저장).
// 목록의 PM 컬럼은 active를 안 봐 이름이 그대로 보이던 터라 '목록엔 있는데 상세는 미지정'이기도 했다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { projectForm } = require("../src/views.projects");
const { sessionsSection } = require("../src/views.sessions");
const { listProjectManagers } = require("../src/data");

const D = db();
const activeId = D.prepare("INSERT INTO project_managers (name, active) VALUES ('현직엔지', 1)").run().lastInsertRowid;
const goneId = D.prepare("INSERT INTO project_managers (name, active) VALUES ('퇴사엔지', 0)").run().lastInsertRowid;
const projId = D.prepare("INSERT INTO projects (title, project_type, artist, rate, manager_id) VALUES ('루나 1집','session','루나',0,?)").run(goneId).lastInsertRowid;
const project = () => D.prepare("SELECT * FROM projects WHERE id = ?").get(projId);
const selectOf = (html) => (html.match(/<select name="manager_id"[\s\S]*?<\/select>/) || [""])[0];

test("전제: 비활성 담당자는 활성 목록에 없다", () => {
  assert.ok(!listProjectManagers().some((m) => m.id === goneId), "활성 목록엔 없음");
  assert.ok(listProjectManagers({ includeInactive: true }).some((m) => m.id === goneId), "비활성 포함이면 있음");
});

test("PM이 비활성이어도 폼이 그 기록을 보존한다('(목록에 없음)' 옵션)", () => {
  const sel = selectOf(projectForm(project()));
  assert.match(sel, new RegExp(`<option value="${goneId}" selected>퇴사엔지 \\(목록에 없음\\)</option>`), "보존 옵션이 선택된 채로");
  assert.ok(!/<option value="" selected/.test(sel), "'미지정'이 선택되지 않는다");
});

// 🔒 이게 결함의 본체 — 폼이 보존 옵션을 selected로 내야 제출값이 살아남는다.
// (라우트: manager_id: b.manager_id ? Number(b.manager_id) : null)
test("보존 옵션 덕에 저장해도 PM이 지워지지 않는다(폼 제출값 재현)", () => {
  const sel = selectOf(projectForm(project()));
  const submitted = (sel.match(/<option value="([^"]*)" selected/) || [])[1]; // 브라우저가 보낼 값
  assert.equal(submitted, String(goneId), "제출값 = 원래 PM id");
  const saved = submitted ? Number(submitted) : null; // 라우트와 동일한 변환
  assert.equal(saved, goneId, "저장해도 그대로");
});

test("활성 PM은 종전 그대로(보존 옵션 없이 선택만)", () => {
  D.prepare("UPDATE projects SET manager_id = ? WHERE id = ?").run(activeId, projId);
  const sel = selectOf(projectForm(project()));
  assert.match(sel, new RegExp(`<option value="${activeId}" selected>현직엔지</option>`));
  assert.ok(!/목록에 없음/.test(sel), "보존 옵션은 필요할 때만 나온다");
  D.prepare("UPDATE projects SET manager_id = ? WHERE id = ?").run(goneId, projId);
});

test("PM 미지정 프로젝트는 '미지정'이 그대로(과잉 동작 방지)", () => {
  const p2 = D.prepare("INSERT INTO projects (title, project_type, artist, rate) VALUES ('무PM','session','태연',0)").run().lastInsertRowid;
  const sel = selectOf(projectForm(D.prepare("SELECT * FROM projects WHERE id = ?").get(p2)));
  assert.ok(!/목록에 없음/.test(sel), "보존 옵션 없음");
  assert.ok(!/selected/.test(sel.replace(/<option value="" [^>]*>/, "")), "선택된 담당자 없음");
});

test("세션 탭 PM 표기도 비활성 PM의 이름을 보여준다(정보 탭과 어긋나지 않게)", () => {
  const html = sessionsSection({ project: project(), rows: [], isAdmin: true, managers: listProjectManagers(), rateItems: [], rooms: [] });
  assert.match(html, /퇴사엔지/, "활성 목록에 없어도 이름을 되짚어 표기");
});

// ── 전수 점검(2026-08-02): 같은 불변식이 필요한 나머지 자리 ──
// "선택지가 필터된 목록에서 나오는 select은 현재값이 목록에 없어도 보존한다."
// 보존 안 하면 폼이 빈 값을 제출하고 서버가 그대로 null로 저장한다(실측으로 확인한 결함 클래스).
// ⚠️서버는 이 값들을 `WHERE id = ?`로만 조회한다(active를 안 본다) → 보존된 값은 정상 저장된다.
const { tracksSection } = require("../src/views.projects");
const { sessionBookingFields } = require("../src/views.sessions");
const { bookingDefaultsSection } = require("../src/views.settings");
const { listTracksForProject, listRateItems, listRooms } = require("../src/data");
const USER = { id: 1, role: "chief" };
const selNamed = (html, name) => (html.match(new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`)) || [""])[0];

test("작업 담당 엔지니어: 비활성 담당자 배정이 보존된다(정산·원천세 근거)", () => {
  const track = D.prepare("INSERT INTO project_tracks (project_id, title) VALUES (?, '월광')").run(projId).lastInsertRowid;
  // 지급까지 끝난 작업 — PAYOUT_LOCKED는 '삭제'만 막고 이 UPDATE 경로는 막지 않는다.
  const task = D.prepare("INSERT INTO track_tasks (track_id, task_type, status, engineer_id, engineer_name, worker_rate, worker_paid) VALUES (?, 'Mixing', 'Pending', ?, '퇴사엔지', 300000, 1)").run(track, goneId).lastInsertRowid;
  const b = listTracksForProject(USER, projId); // 반환 = { project, tracks }
  const html = tracksSection({ project: b.project, tracks: b.tracks, isAdmin: true, managers: listProjectManagers(), expandTaskId: task });
  const sel = selNamed(html, "engineer_id");
  assert.match(sel, new RegExp(`<option value="${goneId}" selected[^>]*>퇴사엔지 \\(목록에 없음\\)`), "배정이 selected로 살아 있다");
  // data-external은 외주 지급단가 칸 노출을 가른다 — 보존 옵션도 담당자 행에서 되짚어 세운다.
  assert.match(sel, new RegExp(`<option value="${goneId}" selected data-external="1"`), "외주 여부(user_id)까지 복원");
});

test("세션 담당 엔지니어: 비활성 담당자 배정이 보존된다(PAYOUT_LOCKED 막다른 길 방지)", () => {
  const sess = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status, start_time, end_time) VALUES (?, '녹음', '2099-01-01', '예정', '14:00', '18:00')").run(projId).lastInsertRowid;
  D.prepare("INSERT INTO session_engineers (session_id, manager_id) VALUES (?, ?)").run(sess, goneId);
  const s = D.prepare("SELECT * FROM sessions WHERE id = ?").get(sess);
  const html = sessionBookingFields(s, listProjectManagers(), listRateItems(), listRooms());
  assert.match(html, new RegExp(`<option value="${goneId}" selected[^>]*>퇴사엔지 \\(목록에 없음\\)`));
});

test("세션 단가 항목: 비활성 단가가 보존된다(청구 근거·기준시간까지)", () => {
  const cat = D.prepare("SELECT name FROM rate_categories LIMIT 1").get();
  const goneRate = D.prepare("INSERT INTO rate_items (name, category, base_minutes, base_price, active, sort_order) VALUES ('폐지단가', ?, 210, 500000, 0, 99)").run(cat ? cat.name : null).lastInsertRowid;
  const sess = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status, start_time, end_time, rate_item_id) VALUES (?, '녹음', '2099-02-02', '예정', '14:00', '18:00', ?)").run(projId, goneRate).lastInsertRowid;
  const s = D.prepare("SELECT * FROM sessions WHERE id = ?").get(sess);
  const sel = selNamed(sessionBookingFields(s, listProjectManagers(), listRateItems(), listRooms()), "rate_item_id");
  assert.match(sel, new RegExp(`<option value="${goneRate}" data-minutes="210" selected>폐지단가 \\(사용 안 함\\)`), "이름 + 기준시간(1Pro 계산)까지 살린다");
});

test("예약 기본값: 비활성 담당자 설정이 보존된다(설정 저장만으로 비워지지 않게)", () => {
  D.prepare("INSERT OR REPLACE INTO admin_state (key, value) VALUES ('default_booker', '퇴사엔지')").run();
  const sel = selNamed(bookingDefaultsSection(), "default_booker");
  assert.match(sel, /<option value="퇴사엔지" selected>퇴사엔지 \(목록에 없음\)/);
});

test("과잉 보존 방지: 값이 목록에 있거나 비어 있으면 보존 옵션을 만들지 않는다", () => {
  const s = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, status) VALUES (?, '녹음', '2099-03-03', '예정')").run(projId).lastInsertRowid;
  const row = D.prepare("SELECT * FROM sessions WHERE id = ?").get(s);
  const html = sessionBookingFields(row, listProjectManagers(), listRateItems(), listRooms());
  assert.ok(!/목록에 없음|사용 안 함/.test(selNamed(html, "rate_item_id")), "단가 미지정 세션");
  assert.ok(!/목록에 없음/.test(selNamed(html, "engineer_ids")), "엔지니어 미배정 세션");
});
