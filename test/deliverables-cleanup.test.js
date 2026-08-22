"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));
const D = require("../src/data");
const storage = require("../src/storage");

// ── 2026-08-22 감사 발견: 프로젝트 삭제가 자료 전달 실파일을 회수하지 않는다 ──
// deliverables는 project_id CASCADE라 DB 행은 지워지지만, 그때까지는 Drive/로컬의 실제 파일이 그대로
// 남아 참조 없는 고아 파일로 누적됐다(deleteParty의 첨부 회수와 같은 클래스, 프로젝트 경로만 빠져 있었다).
test("deleteProject: 자료 전달 첨부 실파일도 함께 회수한다(로컬 백엔드)", async () => {
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('삭제테스트', 'task', 0)").run().lastInsertRowid;
  const fileId = "delcleanup-" + Date.now();
  await fs.promises.writeFile(storage.localPath(fileId), "dummy");
  assert.ok(fs.existsSync(storage.localPath(fileId)), "테스트 파일 생성 확인");

  db()
    .prepare(
      "INSERT INTO deliverables (project_id, title, storage_backend, file_id, file_name) VALUES (?, '믹스 v1', 'local', ?, 'mix.wav')"
    )
    .run(proj, fileId);

  D.deleteProject(proj);
  assert.equal(db().prepare("SELECT 1 FROM deliverables WHERE project_id = ?").get(proj), undefined, "deliverables 행은 CASCADE로 삭제");

  // storage.remove는 fire-and-forget(비차단) — 실제 언링크가 끝날 때까지 짧게 대기.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(storage.localPath(fileId)), "로컬 실파일도 회수되어 고아로 남지 않는다");
});

test("deleteProject: 자료 전달이 없는 프로젝트는 그대로 정상 삭제된다(회귀 방지)", () => {
  const proj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('무자료삭제테스트', 'task', 0)").run().lastInsertRowid;
  assert.doesNotThrow(() => D.deleteProject(proj));
  assert.equal(db().prepare("SELECT 1 FROM projects WHERE id = ?").get(proj), undefined, "프로젝트 삭제 확인");
});
