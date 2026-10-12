"use strict";

// ── 개편 2단계: 곡 계층 제거(작업 평탄화) — docs/redesign/02-flatten-tasks.md ──
// 잠그는 계약:
//  · 마이그레이션(tasks_flatten_v1)이 id·청구 라인 연결을 보존한다 — 외래키가 켜진 채 DROP하면
//    invoice_items.task_id(ON DELETE SET NULL)가 전부 지워진다(이 테스트가 그 사고를 잡는다)
//  · 곡 아티스트는 프로젝트 아티스트와 다를 때만 남는다(옛 곡 생성이 복사해 둔 값은 비운다)
//  · 작업 없는 빈 곡은 프로젝트 메모 끝에 '곡: …'으로 보존(이미 있으면 다시 안 붙임)
//  · 검사가 어긋나면 롤백하고 기동을 멈춘다
//  · 곡명 줄마다 작업 하나 / 곡 이름 바꾸기(청구된 작업은 그대로) / 곡명 없는 작업은 프로젝트 이름으로 표시
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const D = require("../src/data");
const { tracksSection } = require("../src/views.projects");

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const d = db();

test.after(() => cleanupDb(process.env.DB_PATH, d));

/** 이미 평탄화된 DB를 옛 구조(track_id)로 되돌려 데이터를 심는다 — 운영 DB가 배포 직전 갖고 있는 모양. */
function restoreLegacyShape() {
  d.exec("PRAGMA foreign_keys = OFF;");
  d.prepare("DELETE FROM invoice_items WHERE task_id IS NOT NULL").run(); // 앞 테스트의 라인이 사라질 작업을 가리키지 않게
  d.exec("DROP TABLE track_tasks;");
  d.exec(`CREATE TABLE track_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES project_tracks(id) ON DELETE CASCADE,
    task_type TEXT NOT NULL, billing_type TEXT NOT NULL DEFAULT 'Fixed_Per_Track', quantity REAL NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 0, total_price INTEGER NOT NULL DEFAULT 0, engineer_name TEXT,
    status TEXT NOT NULL DEFAULT 'Pending', is_invoiced INTEGER NOT NULL DEFAULT 0,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL, worker_paid INTEGER NOT NULL DEFAULT 0, worker_paid_date TEXT,
    worker_rate INTEGER NOT NULL DEFAULT 0, engineer_id INTEGER, waived INTEGER NOT NULL DEFAULT 0, billing_memo TEXT, work_date TEXT
  );`);
  d.exec("PRAGMA foreign_keys = ON;");
  d.prepare("DELETE FROM admin_state WHERE key = 'tasks_flatten_v1'").run();
}

test("마이그레이션: id·청구 라인 연결 보존, 곡 아티스트는 다를 때만, 빈 곡은 메모로", () => {
  restoreLegacyShape();
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate, artist, memo) VALUES ('컴필', 'session', 0, '루나', '기존 메모\n곡: 이미적음')").run().lastInsertRowid);
  const trSame = Number(d.prepare("INSERT INTO project_tracks (project_id, title, artist) VALUES (?, '타이틀', '루나')").run(pid).lastInsertRowid);
  const trDiff = Number(d.prepare("INSERT INTO project_tracks (project_id, title, artist) VALUES (?, '피처링곡', '게스트')").run(pid).lastInsertRowid);
  d.prepare("INSERT INTO project_tracks (project_id, title) VALUES (?, '빈곡A')").run(pid);
  d.prepare("INSERT INTO project_tracks (project_id, title) VALUES (?, '이미적음')").run(pid); // 메모에 이미 있음 → 다시 안 붙임
  const t1 = Number(d.prepare("INSERT INTO track_tasks (id, track_id, task_type, total_price, is_invoiced, worker_paid) VALUES (501, ?, 'Mixing', 300000, 1, 1)").run(trSame).lastInsertRowid);
  const t2 = Number(d.prepare("INSERT INTO track_tasks (id, track_id, task_type, total_price) VALUES (502, ?, 'Mastering', 100000)").run(trDiff).lastInsertRowid);
  const inv = Number(d.prepare("INSERT INTO invoices (project_id, title, amount, status) VALUES (?, '청구', 330000, '발행')").run(pid).lastInsertRowid);
  d.prepare("INSERT INTO invoice_items (invoice_id, task_id, track_title, description, amount) VALUES (?, ?, '타이틀', '타이틀 - 믹싱', 300000)").run(inv, t1);

  init(); // 게이트를 지웠으니 flattenTasks가 다시 돈다

  const cols = d.prepare("PRAGMA table_info(track_tasks)").all().map((c) => c.name);
  assert.ok(cols.includes("project_id") && cols.includes("song_title") && cols.includes("song_artist"));
  assert.ok(!cols.includes("track_id"), "track_id 제거");
  const a = d.prepare("SELECT * FROM track_tasks WHERE id = ?").get(t1);
  const b = d.prepare("SELECT * FROM track_tasks WHERE id = ?").get(t2);
  assert.equal(a.project_id, pid, "id 보존 + 곡의 프로젝트");
  assert.equal(a.song_title, "타이틀");
  assert.equal(a.song_artist, null, "프로젝트 아티스트를 복사해 둔 값은 비운다(프로젝트를 따라감)");
  assert.equal(a.is_invoiced, 1);
  assert.equal(a.worker_paid, 1);
  assert.equal(b.song_artist, "게스트", "다른 아티스트는 남긴다");
  assert.equal(d.prepare("SELECT task_id FROM invoice_items WHERE invoice_id = ?").get(inv).task_id, t1,
    "청구 라인 ↔ 작업 연결 보존(외래키 켠 채 DROP하면 SET NULL로 지워진다)");
  const memo = d.prepare("SELECT memo FROM projects WHERE id = ?").get(pid).memo;
  assert.equal(memo, "기존 메모\n곡: 이미적음\n곡: 빈곡A", "빈 곡은 메모 끝에, 이미 적힌 곡명은 다시 안 붙임");
  assert.equal(d.pragma("foreign_keys", { simple: true }), 1, "외래키는 다시 켜진다");

  init(); // 다시 켜도 아무 일 없음(게이트)
  assert.equal(d.prepare("SELECT memo FROM projects WHERE id = ?").get(pid).memo, memo, "두 번째 기동은 무변경");
});

test("마이그레이션: 곡을 잃은 작업이 있으면 롤백하고 기동을 멈춘다(반쯤 옮긴 채 서비스하지 않음)", () => {
  restoreLegacyShape();
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('고아', 'session', 0)").run().lastInsertRowid);
  const tr = Number(d.prepare("INSERT INTO project_tracks (project_id, title) VALUES (?, '곡')").run(pid).lastInsertRowid);
  d.exec("PRAGMA foreign_keys = OFF;");
  d.prepare("INSERT INTO track_tasks (track_id, task_type) VALUES (?, 'Mixing')").run(tr);
  d.prepare("INSERT INTO track_tasks (track_id, task_type) VALUES (999999, 'Mixing')").run(); // 곡 없는 작업
  d.exec("PRAGMA foreign_keys = ON;");

  assert.throws(() => init(), /tasks_flatten_v1.*실패/);
  const cols = d.prepare("PRAGMA table_info(track_tasks)").all().map((c) => c.name);
  assert.ok(cols.includes("track_id"), "롤백 — 옛 구조 그대로");
  assert.ok(!d.prepare("SELECT 1 FROM admin_state WHERE key = 'tasks_flatten_v1'").get(), "게이트도 안 찍힘(다음 배포에서 재시도)");
  assert.equal(d.pragma("foreign_keys", { simple: true }), 1, "실패해도 외래키는 다시 켜진다");

  // 정리 — 고아 작업을 지우면 정상 진행
  d.prepare("DELETE FROM track_tasks WHERE track_id = 999999").run();
  init();
  assert.ok(d.prepare("SELECT 1 FROM admin_state WHERE key = 'tasks_flatten_v1'").get());
});

test("createTasks: 곡명 줄마다 작업 하나(빈 줄·중복 제외), 없으면 곡명 없는 작업 1건", () => {
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('일괄', 'session', 0)").run().lastInsertRowid);
  const many = D.createTasks(CHIEF, pid, { task_type: "Mixing", song_title: " 곡 1 \n\n곡  2\n곡 1" });
  assert.deepEqual(many.map((t) => t.song_title), ["곡 1", "곡 2"], "공백 정리 + 중복 제외");
  const none = D.createTasks(CHIEF, pid, { task_type: "Mastering", song_title: "" });
  assert.equal(none.length, 1);
  assert.equal(none[0].song_title, null);
  assert.equal(D.createTasks(CHIEF, 987654, { task_type: "Mixing", song_title: "x" }), null, "없는 프로젝트");
});

test("곡 묶음: 같은 곡명끼리 첫 등장 순서로 묶고, 곡명 없는 작업은 프로젝트 이름으로 표시", () => {
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('묶음앨범', 'session', 0)").run().lastInsertRowid);
  D.createTask(CHIEF, pid, { task_type: "Mixing", song_title: "B곡" });
  D.createTask(CHIEF, pid, { task_type: "Mixing", song_title: "A곡" });
  D.createTask(CHIEF, pid, { task_type: "Mastering", song_title: "B곡" });
  D.createTask(CHIEF, pid, { task_type: "Mixing" });
  const { groups } = D.listTaskGroupsForProject(CHIEF, pid);
  assert.deepEqual(groups.map((g) => [g.title, g.tasks.length]), [["B곡", 2], ["A곡", 1], ["묶음앨범", 1]]);
  const html = tracksSection({ project: { id: pid, title: "묶음앨범" }, groups, isAdmin: true, managers: [] });
  assert.match(html, /묶음앨범<span[^>]*>\(곡명 없음\)/, "곡명 없는 묶음 표시");
  assert.match(html, /name="song_title" value="B곡"/, "빠른 추가가 그 곡명으로 작업을 만든다");
});

test("곡 이름 바꾸기: 미청구 작업만 바뀌고 청구된 작업 수를 알려준다", () => {
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('개명', 'session', 0)").run().lastInsertRowid);
  const a = D.createTask(CHIEF, pid, { task_type: "Mixing", song_title: "오타곡" });
  const b = D.createTask(CHIEF, pid, { task_type: "Mastering", song_title: "오타곡" });
  d.prepare("UPDATE track_tasks SET is_invoiced = 1 WHERE id = ?").run(b.id);
  const r = D.renameSong(CHIEF, pid, "오타곡", " 바른곡 ");
  assert.deepEqual([r.changed, r.locked], [1, 1]);
  assert.equal(d.prepare("SELECT song_title FROM track_tasks WHERE id = ?").get(a.id).song_title, "바른곡");
  assert.equal(d.prepare("SELECT song_title FROM track_tasks WHERE id = ?").get(b.id).song_title, "오타곡", "청구된 작업은 그대로(스냅샷 잠금)");
});

test("청구: 곡명 없는 작업의 라인은 '프로젝트 이름 - 종류'", () => {
  const payer = D.createCompany({ name: "평탄화청구처", biz_no: "123-45-67899" });
  const pid = Number(d.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('라인앨범', 'session', 0)").run().lastInsertRowid);
  const t = D.createTask(CHIEF, pid, { task_type: "Mixing", unit_price: "200000" });
  const inv = D.createInvoiceFromTasks(CHIEF, { projectId: pid, clientId: payer, taskIds: [t.id], issueDate: "2026-11-01" });
  const items = D.listInvoiceItemsForInvoice(CHIEF, inv.id).rows;
  assert.match(items[0].description, /^라인앨범 - /);
  assert.equal(items[0].track_title, "라인앨범");
});
