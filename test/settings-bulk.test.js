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

test("bulkUpdateRateItems: 여러 행 동시 갱신·미참여 행 불변·임의 id 무시·이름 비운 행만 건너뜀", () => {
  const a = D.createRateItem({ rate_name: "벌크A", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000", extra_price: "100000" });
  const b = D.createRateItem({ rate_name: "벌크B", category: "스튜디오 녹음", base_hours: "4", base_price: "400000", extra_price: "100000" });
  const c = D.createRateItem({ rate_name: "벌크C", category: "스튜디오 녹음", base_hours: "2", base_price: "200000", extra_price: "100000" });
  const r = D.bulkUpdateRateItems({
    [`rate_name_${a.id}`]: "벌크A2", [`category_${a.id}`]: "스튜디오 녹음", [`base_hours_${a.id}`]: "5", [`base_price_${a.id}`]: "500,000", [`extra_hours_${a.id}`]: "1", [`extra_price_${a.id}`]: "100000", [`price_type_${a.id}`]: "base",
    [`rate_name_${b.id}`]: "", [`category_${b.id}`]: "스튜디오 녹음", [`base_hours_${b.id}`]: "4", [`base_price_${b.id}`]: "400000", [`extra_hours_${b.id}`]: "1", [`extra_price_${b.id}`]: "100000", [`price_type_${b.id}`]: "fixed",
    "rate_name_99999": "유령", "base_price_99999": "1",
  });
  assert.equal(r.updated, 1, "참여+유효 행만 갱신");
  assert.equal(r.skipped, 1, "이름 비운 행은 건너뜀");
  const a2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(a.id);
  assert.equal(a2.name, "벌크A2");
  assert.equal(a2.base_minutes, 300, "5시간 → 300분");
  assert.equal(a2.base_price, 500000, "콤마 금액 파싱");
  assert.equal(a2.price_type, "base");
  const b2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(b.id);
  assert.equal(b2.name, "벌크B", "건너뛴 행은 원값 유지");
  const c2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(c.id);
  assert.equal(c2.name, "벌크C", "미참여(필드 없는) 행 불변");
  assert.equal(db().prepare("SELECT COUNT(*) c FROM rate_items WHERE name='유령'").get().c, 0, "임의 id 주입 무시(행 생성 없음)");
});

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
  D.createTaskType({ label: "벌크작업1", billing_type: "Fixed_Per_Track", unit_price: "100000" });
  D.createTaskType({ label: "벌크작업2", billing_type: "Fixed_Per_Track", unit_price: "200000" });
  const t1 = db().prepare("SELECT * FROM task_types WHERE label='벌크작업1'").get();
  db().prepare("UPDATE task_types SET sort_order=770 WHERE id=?").run(t1.id); // 사용자가 ↑↓로 잡아둔 순서 가정
  D.bulkUpdateTaskTypes({
    [`label_${t1.id}`]: "벌크작업1-개명", [`billing_type_${t1.id}`]: "Fixed_Per_Track", [`unit_price_${t1.id}`]: "150,000", [`price_type_${t1.id}`]: "minimum",
    // is_quick 미전송 = 해제
  });
  const after = db().prepare("SELECT * FROM task_types WHERE id=?").get(t1.id);
  assert.equal(after.label, "벌크작업1-개명");
  assert.equal(after.unit_price, 150000);
  assert.equal(after.price_type, "minimum");
  assert.equal(after.is_quick, 0, "미전송 체크박스 = 0");
  assert.equal(after.sort_order, 770, "sort_order 보존 — 미전송 시 100 리셋되면 안 됨");
});
