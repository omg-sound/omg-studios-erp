"use strict";

// ── 대표(owner)도 작업 담당자가 된다 회귀 잠금(2026-08-02 사용자 결정) ──
// 이전엔 syncUserToManager가 role==='owner'면 담당자 행을 만들지 않고 있던 행도 비활성시켜,
// 대표를 PM(projects.manager_id)·예약 담당자·담당 엔지니어·작업 담당자 어디에도 고를 수 없었다
// (DB를 직접 고쳐도 대표가 로그인하는 순간 active=0으로 되돌아갔다).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const { syncUserToManager, findUserById } = require("../src/auth");
const { listProjectManagers } = require("../src/data");
const { projectForm } = require("../src/views.projects");

const D = db();
const mgrOf = (userId) => D.prepare("SELECT * FROM project_managers WHERE user_id = ?").get(userId);

test("대표 로그인 → 작업 담당자 행이 활성으로 생성된다", () => {
  D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (9, 'boss@x.com', 'owner', '박광현', 1)").run();
  syncUserToManager(findUserById(9));
  const m = mgrOf(9);
  assert.ok(m, "대표에게도 담당자 행이 생긴다");
  assert.strictEqual(m.active, 1);
  assert.strictEqual(m.name, "박광현");
});

test("대표가 다시 로그인해도 비활성으로 되돌아가지 않는다", () => {
  syncUserToManager(findUserById(9));
  assert.strictEqual(mgrOf(9).active, 1);
});

test("옛 데이터로 비활성 상태인 대표 담당자 행은 로그인 시 되살아난다", () => {
  D.prepare("UPDATE project_managers SET active = 0 WHERE user_id = 9").run(); // 옛 동작이 남긴 상태
  syncUserToManager(findUserById(9));
  assert.strictEqual(mgrOf(9).active, 1);
});

test("대표가 담당자 목록·PM 선택지에 나온다", () => {
  assert.ok(listProjectManagers().some((m) => m.name === "박광현"), "listProjectManagers(활성만)에 포함");
  // 이 목록이 곧 PM·예약 담당자·담당 엔지니어 select의 선택지다(views.projects.managerSelect / views.sessions.managerOptions).
  const html = projectForm({ p: {} });
  assert.match(html, /<select name="manager_id"[\s\S]*?박광현[\s\S]*?<\/select>/);
});

test("비활성 계정·이름 없는 계정은 역할과 무관하게 여전히 제외된다", () => {
  D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (10, 'quit@x.com', 'owner', '퇴임대표', 0)").run();
  syncUserToManager(findUserById(10));
  assert.strictEqual(mgrOf(10), undefined, "비활성 계정은 담당자 행을 만들지 않는다");

  D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (11, 'noname@x.com', 'staff', '', 1)").run();
  syncUserToManager(findUserById(11));
  assert.strictEqual(mgrOf(11), undefined, "이름 없는 계정은 담당자 행을 만들지 않는다");
});
