"use strict";

// 룸(장소) 관리 — 이름 수정·순서 이동·계층·예약 대상(2026-07-26).
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

test("예약 대상만 조회 — 하위 공간·Lounge는 세션 폼 장소 목록에서 빠진다", () => {
  const names = listRooms({ bookableOnly: true }).map((r) => r.name);
  assert.ok(names.includes("Studio A"));
  assert.ok(names.includes("Studio B"));
  assert.ok(names.includes("Studio C"));
  assert.ok(!names.includes("Control Room A"), "Control Room A 단독 예약 불가");
  assert.ok(!names.includes("Booth A"), "Booth A 단독 예약 불가");
  assert.ok(!names.includes("Lounge"), "Lounge는 작업 공간이 아님");
  // 전체 목록에는 여전히 있다(관리 화면은 계층을 보여줘야 하므로).
  assert.equal(listRooms({ includeInactive: true }).length >= 6, true);
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

test("하위 룸은 예약 대상이 될 수 없다 — 상위를 지정하면 체크와 무관하게 제외", () => {
  const a = byName("Studio A");
  const booth = byName("Booth A");
  const r = updateRoom(booth.id, { room_name: "Booth A", parent_id: String(a.id), bookable: "1" });
  assert.equal(r.parent_id, a.id);
  assert.equal(r.bookable, 0, "하위 공간에 예약 대상 체크가 먹으면 규칙이 깨진다");
});

test("자기 자신을 상위로 두거나 2단을 넘기면 최상위로 떨어진다(계층 꼬임 방지)", () => {
  const a = byName("Studio A");
  const booth = byName("Booth A");
  // 자기 자신
  assert.equal(updateRoom(a.id, { room_name: "Studio A", parent_id: String(a.id), bookable: "1" }).parent_id, null);
  // 이미 하위인 룸(Booth A)을 상위로 지정 → 3단이 되므로 무시
  const nested = createRoom({ room_name: "임시 하위", parent_id: String(booth.id) });
  assert.equal(nested.parent_id, null, "하위의 하위는 만들지 않는다");
  deleteRoom(nested.id);
});

test("순서 이동은 같은 상위 안에서만 — 하위 공간이 다른 스튜디오 밑으로 튀지 않는다", () => {
  const order = () => listRooms({ includeInactive: true, bookableOnly: true }).map((r) => r.name);
  const before = order();
  const b = byName("Studio B");
  moveRoom(b.id, "up"); // Studio A와 자리 교환
  const after = order();
  assert.deepEqual(after.slice(0, 2), [before[1], before[0]], "이웃과 자리 교환");
  moveRoom(byName("Studio B").id, "down"); // 원복
  assert.deepEqual(order(), before);
  // 하위 공간은 상위가 달라 서로 섞이지 않는다.
  const cr = byName("Control Room A");
  assert.equal(getRoom(cr.id).parent_id, byName("Studio A").id);
  moveRoom(cr.id, "up");
  assert.equal(getRoom(cr.id).parent_id, byName("Studio A").id, "이동 후에도 상위 불변");
});

test("경계에서 이동은 무동작(첫 항목 ↑ · 마지막 ↓)", () => {
  const tops = listRooms({ includeInactive: true }).filter((r) => !r.parent_id);
  const first = tops[0];
  const before = listRooms({ includeInactive: true }).map((r) => r.id);
  moveRoom(first.id, "up");
  assert.deepEqual(listRooms({ includeInactive: true }).map((r) => r.id), before);
});

test("삭제: 하위 룸의 parent_id도 정리한다(유령 참조 방지)", () => {
  const parent = createRoom({ room_name: "임시 스튜디오", bookable: "1" });
  const child = createRoom({ room_name: "임시 부스", parent_id: String(parent.id) });
  assert.equal(getRoom(child.id).parent_id, parent.id);
  deleteRoom(parent.id);
  assert.equal(getRoom(parent.id), null);
  assert.equal(getRoom(child.id).parent_id, null, "상위가 사라지면 하위는 최상위로");
  assert.equal(getRoom(child.id).bookable, 0, "예약 대상 여부는 사람이 다시 정한다");
  deleteRoom(child.id);
});
