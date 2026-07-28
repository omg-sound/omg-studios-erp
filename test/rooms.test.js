"use strict";

// 룸(장소) 관리 — 이름 수정·순서 이동·예약 대상(2026-07-26 / 계층은 2026-07-28 폐지).
//
// 핵심은 **이름 수정이 id를 보존한다**는 것. 이전에는 추가·삭제만 있어서 오타를 고치려면 지웠다 만들어야 했고,
// deleteRoom이 sessions.room_id를 NULL로 밀기 때문에 그 장소로 잡힌 세션이 전부 '장소 미지정'이 됐다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { listRooms, getRoom, createRoom, updateRoom, moveRoom, deleteRoom } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const byName = (name) => listRooms({ includeInactive: true }).find((r) => r.name === name);

test("예약 대상만 조회 — Lounge는 세션 폼 장소 목록에서 빠진다", () => {
  const names = listRooms({ bookableOnly: true }).map((r) => r.name);
  assert.ok(names.includes("Studio A"));
  assert.ok(names.includes("Studio B"));
  assert.ok(names.includes("Studio C"));
  assert.ok(!names.includes("Lounge"), "Lounge는 작업 공간이 아님");
  // 전체 목록에는 예약 대상이 아닌 장소도 나온다(관리 화면에서 고쳐야 하므로).
  assert.ok(listRooms({ includeInactive: true }).some((r) => r.name === "Lounge"));
});

// 계층 폐지(2026-07-28): 시드가 하위 룸을 만들지 않고, 마이그레이션이 남아 있던 하위 행을 지운다.
test("계층 폐지 — 하위 룸(Control Room A·Booth A)이 없고 parent_id를 가진 행도 없다", () => {
  const all = listRooms({ includeInactive: true });
  assert.ok(!all.some((r) => r.name === "Control Room A"), "Control Room A 삭제됨");
  assert.ok(!all.some((r) => r.name === "Booth A"), "Booth A 삭제됨");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM rooms WHERE parent_id IS NOT NULL").get().n, 0, "계층 행 없음");
});

test("계층 폐지 — parent_id를 보내도 무시한다(레거시 폼·직접 제출 대비)", () => {
  const a = byName("Studio A");
  const r = createRoom({ room_name: "임시 계층테스트", parent_id: String(a.id), bookable: "1" });
  assert.equal(r.parent_id, null, "상위 지정 무시");
  assert.equal(r.bookable, 1, "상위가 있다고 예약 대상이 꺼지지 않는다(옛 강제 0 규칙 폐지)");
  deleteRoom(r.id);
});

test("이름 수정은 id를 보존한다 — 그 장소로 잡힌 세션이 유지된다", () => {
  const d = db();
  const a = byName("Studio A");
  const p = d.prepare("INSERT INTO projects (title) VALUES ('룸 테스트')").run();
  const s = d
    .prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, room_id) VALUES (?, '녹음', '2026-08-02', '14:00', '18:00', ?)")
    .run(p.lastInsertRowid, a.id);
  updateRoom(a.id, { room_name: "Studio A (본실)", bookable: "1" });
  const after = getRoom(a.id);
  assert.equal(after.name, "Studio A (본실)");
  assert.equal(d.prepare("SELECT room_id FROM sessions WHERE id = ?").get(s.lastInsertRowid).room_id, a.id, "세션 참조 유지");
  updateRoom(a.id, { room_name: "Studio A", bookable: "1" }); // 되돌리기(뒤 테스트가 이름으로 찾는다)
  assert.equal(getRoom(a.id).name, "Studio A");
});

test("이름을 비우면 저장하지 않는다(ROOM_NAME_REQUIRED)", () => {
  const a = byName("Studio A");
  assert.throws(() => updateRoom(a.id, { room_name: "  " }), /ROOM_NAME_REQUIRED/);
  assert.equal(getRoom(a.id).name, "Studio A", "실패 시 기존 이름 유지");
});

test("순서 이동 — 이웃과 자리 교환(전체 목록 한 축)", () => {
  const order = () => listRooms({ includeInactive: true, bookableOnly: true }).map((r) => r.name);
  const before = order();
  const b = byName("Studio B");
  moveRoom(b.id, "up"); // Studio A와 자리 교환
  assert.deepEqual(order().slice(0, 2), [before[1], before[0]], "이웃과 자리 교환");
  moveRoom(byName("Studio B").id, "down"); // 원복
  assert.deepEqual(order(), before);
});

test("경계에서 이동은 무동작(첫 항목 ↑ · 마지막 ↓)", () => {
  const all = listRooms({ includeInactive: true });
  const before = all.map((r) => r.id);
  moveRoom(all[0].id, "up");
  assert.deepEqual(listRooms({ includeInactive: true }).map((r) => r.id), before);
  moveRoom(all[all.length - 1].id, "down");
  assert.deepEqual(listRooms({ includeInactive: true }).map((r) => r.id), before);
});

test("삭제: 그 장소로 잡힌 세션은 '장소 미지정'이 된다(room_id NULL)", () => {
  const d = db();
  const room = createRoom({ room_name: "임시 스튜디오", bookable: "1" });
  const p = d.prepare("INSERT INTO projects (title) VALUES ('룸 삭제 테스트')").run();
  const s = d
    .prepare("INSERT INTO sessions (project_id, session_type, session_date, room_id) VALUES (?, '녹음', '2026-08-03', ?)")
    .run(p.lastInsertRowid, room.id);
  deleteRoom(room.id);
  assert.equal(getRoom(room.id), null);
  assert.equal(d.prepare("SELECT room_id FROM sessions WHERE id = ?").get(s.lastInsertRowid).room_id, null);
});
