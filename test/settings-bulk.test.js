"use strict";

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const D = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("bulkUpdateRooms: 이름·체크박스 갱신, 미전송 체크박스=해제(0)", () => {
  const other = D.createRoom({ room_name: "벌크미참여", bookable: "1" });
  const r1 = D.createRoom({ room_name: "벌크룸1", bookable: "1", is_external: "1" });
  D.bulkUpdateRooms({
    [`room_name_${r1.id}`]: "벌크룸1-개명",
    // bookable·is_external 미전송 = 체크 해제
  });
  const after = db().prepare("SELECT * FROM rooms WHERE id=?").get(r1.id);
  assert.equal(after.name, "벌크룸1-개명");
  assert.equal(after.bookable, 0, "미전송 체크박스 = 0");
  assert.equal(after.is_external, 0, "미전송 체크박스 = 0");
  assert.equal(db().prepare("SELECT name FROM rooms WHERE id=?").get(other.id).name, "벌크미참여", "미참여 행 불변");
});

test("bulkUpdateTaskTypes: 갱신 + sort_order 보존(updateTaskType의 100 리셋 잠복 버그 방어)", () => {
  D.createTaskType({ label: "벌크작업1" });
  D.createTaskType({ label: "벌크작업2" });
  const t1 = db().prepare("SELECT * FROM task_types WHERE label='벌크작업1'").get();
  db().prepare("UPDATE task_types SET sort_order=770 WHERE id=?").run(t1.id); // 사용자가 ↑↓로 잡아둔 순서 가정
  D.bulkUpdateTaskTypes({
    [`label_${t1.id}`]: "벌크작업1-개명",
    // is_quick 미전송 = 해제
  });
  const after = db().prepare("SELECT * FROM task_types WHERE id=?").get(t1.id);
  assert.equal(after.label, "벌크작업1-개명");
  assert.equal(after.is_quick, 0, "미전송 체크박스 = 0");
  assert.equal(after.sort_order, 770, "sort_order 보존 — 미전송 시 100 리셋되면 안 됨");
});
