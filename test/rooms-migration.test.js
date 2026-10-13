"use strict";

// 룸 명칭 체계 마이그레이션(pricing_rooms_v2, 2026-07-26 — 새 DB에선 기본 룸 시드 역할).
// (같은 게이트의 단가표·작업 종류 단가 부분은 개편 4단계에서 테이블·컬럼과 함께 삭제됐다.)
//
// 이 테스트가 지키는 것은 **참조 보존**이다 — 룸을 지웠다 만들면 sessions.room_id가 끊겨 기존 예약이
// '장소 미지정'이 된다. 그래서 rename 전후로 id가 같은지를 못 박는다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const room = (name) => db().prepare("SELECT * FROM rooms WHERE name = ?").get(name);

// 계층 폐지(2026-07-28) — 시드는 평면 4개만 만들고, 하위로 만들어 뒀던 Control Room A·Booth A는
// rooms_drop_hierarchy_v1이 지운다(그 장소로 잡힌 세션이 있으면 지우지 않고 최상위로 전환).
test("룸: Studio A·B·C + Lounge 4개, 하위 룸은 없다", () => {
  for (const name of ["Studio A", "Studio B", "Studio C", "Lounge"]) {
    assert.ok(room(name), `${name} 없음`);
  }
  assert.ok(!room("Control Room A"), "Control Room A는 계층 폐지로 삭제됨");
  assert.ok(!room("Booth A"), "Booth A는 계층 폐지로 삭제됨");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM rooms WHERE parent_id IS NOT NULL").get().n, 0, "계층 행 없음");
});

test("룸: 예약 대상 — 작업 공간만 1, Lounge는 0", () => {
  assert.equal(room("Studio A").bookable, 1);
  assert.equal(room("Studio B").bookable, 1);
  assert.equal(room("Studio C").bookable, 1);
  assert.equal(room("Lounge").bookable, 0, "Lounge는 작업 공간이 아님");
});

test("룸: 금지 표기가 남아 있지 않다", () => {
  const names = db().prepare("SELECT name FROM rooms").all().map((r) => r.name);
  for (const banned of ["Hall", "Live Booth", "Lobby", "Room A", "Room B", "Room C", "A룸", "B룸", "C룸", "메인 룸"]) {
    assert.ok(!names.includes(banned), `금지 표기 '${banned}'가 남아 있음`);
  }
});

test("룸: '메인 룸'을 지우지 않고 이름만 바꿔 id를 보존한다(세션 room_id 유지)", () => {
  // 시드 룸은 id 1로 들어오고 마이그레이션은 rename만 하므로 Studio A가 그 id를 이어받아야 한다.
  assert.equal(room("Studio A").id, 1, "id가 바뀌면 기존 세션의 room_id 참조가 끊긴다");
});

test("멱등: 게이트가 두 번 돌아도 중복 행이 생기지 않는다", () => {
  const before = db().prepare("SELECT COUNT(*) n FROM rooms").get().n;
  // 게이트 플래그를 지우고 재실행 = 배포 재기동 + 플래그 유실 최악 케이스.
  db().prepare("DELETE FROM admin_state WHERE key = 'pricing_rooms_v2'").run();
  init();
  assert.equal(db().prepare("SELECT COUNT(*) n FROM rooms").get().n, before);
  assert.equal(room("Studio A").id, 1, "재실행 후에도 id 보존");
});

