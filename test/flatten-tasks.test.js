"use strict";

// ── 개편 2단계: 곡 계층 제거 후의 작업 계약 — docs/redesign/02-flatten-tasks.md ──
//  · 곡명 줄마다 작업 하나 / 곡 이름 바꾸기(청구된 작업은 그대로) / 곡명 없는 작업은 프로젝트 이름으로 표시
// (평탄화 이행 tasks_flatten_v1 자체의 검증은 개편 4단계에서 이행 코드와 함께 삭제 — 운영 DB는 이미 이행됐다.)
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
