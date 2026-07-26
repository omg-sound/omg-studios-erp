"use strict";

// 룸 명칭 체계 + 과금 체계 개편 마이그레이션(pricing_rooms_v2, 2026-07-26).
//
// 이 테스트가 지키는 것은 **참조 보존**이다 — 룸·단가 항목을 지웠다 만들면 sessions.room_id·rate_item_id가
// 끊겨 기존 예약이 '장소 미지정'이 되고 청구 근거가 사라진다. 그래서 rename 전후로 id가 같은지를 못 박는다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const room = (name) => db().prepare("SELECT * FROM rooms WHERE name = ?").get(name);
const rate = (name) => db().prepare("SELECT * FROM rate_items WHERE name = ?").get(name);

test("룸: 4개 최상위 + Studio A 하위 2개 + Lounge", () => {
  for (const name of ["Studio A", "Studio B", "Studio C", "Lounge", "Control Room A", "Booth A"]) {
    assert.ok(room(name), `${name} 없음`);
  }
  const a = room("Studio A");
  assert.equal(room("Control Room A").parent_id, a.id, "Control Room A는 Studio A 하위");
  assert.equal(room("Booth A").parent_id, a.id, "Booth A는 Studio A 하위");
  assert.equal(a.parent_id, null, "Studio A는 최상위");
  assert.equal(room("Studio B").parent_id, null);
  assert.equal(room("Studio C").parent_id, null);
});

test("룸: 예약은 최상위 단위로만 — 하위 공간과 Lounge는 bookable=0", () => {
  assert.equal(room("Studio A").bookable, 1);
  assert.equal(room("Studio B").bookable, 1);
  assert.equal(room("Studio C").bookable, 1);
  assert.equal(room("Control Room A").bookable, 0, "Control Room A 단독 예약 불가");
  assert.equal(room("Booth A").bookable, 0, "Booth A 단독 예약 불가");
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

test("단가: 솔로 녹음 = 1프로 210분·30만 / 초과 60분·10만 (id 보존)", () => {
  const r = rate("솔로 녹음");
  assert.ok(r, "솔로 녹음 없음");
  assert.equal(r.id, 1, "'보컬 녹음' id를 이어받아야 한다(청구 근거 보존)");
  assert.equal(r.base_minutes, 210);
  assert.equal(r.base_price, 300000);
  assert.equal(r.extra_minutes, 60);
  assert.equal(r.extra_price, 100000);
  assert.equal(r.price_type, "fixed");
  assert.ok(!rate("보컬 녹음"), "옛 이름이 남아 있으면 중복");
});

test("단가: 드럼 · 합주 녹음 = 40만(35만에서 갱신, id 보존)", () => {
  const r = rate("드럼 · 합주 녹음");
  assert.ok(r, "드럼 · 합주 녹음 없음");
  assert.equal(r.id, 2);
  assert.equal(r.base_price, 400000);
  assert.equal(r.base_minutes, 210);
  assert.equal(r.price_type, "fixed");
  assert.ok(!rate("악기+보컬 녹음(그룹)"), "옛 이름이 남아 있으면 중복");
});

test("단가: 촬영 기본 패키지 = 총 10시간 100만 / 초과 60분 10만", () => {
  const r = rate("기본 패키지");
  assert.ok(r, "기본 패키지 없음");
  assert.equal(r.category, "스튜디오 촬영");
  assert.equal(r.base_minutes, 600, "반입 2h + 촬영 7h + 철수 1h");
  assert.equal(r.base_price, 1000000);
  assert.equal(r.extra_price, 100000);
  assert.equal(r.price_type, "fixed");
});

test("포스트는 rate_items가 아니라 task_types에 있다(믹싱=기준가·보컬튠=최소가)", () => {
  const t = (key) => db().prepare("SELECT * FROM task_types WHERE key = ?").get(key);
  assert.equal(t("Mixing").unit_price, 1000000);
  assert.equal(t("Mixing").price_type, "base", "작업량에 따라 차등 → 기준가");
  assert.equal(t("Vocal_Tuning").unit_price, 200000);
  assert.equal(t("Vocal_Tuning").price_type, "minimum", "작업량에 따라 상향 → 최소가");
  // 세션 폼에서 도달 불가한 죽은 데이터를 만들지 않았는지(믹싱이 두 카탈로그에 동시 존재하면 안 됨).
  assert.ok(!rate("믹싱"), "믹싱이 단가표에도 있으면 카탈로그가 두 벌");
  assert.ok(!rate("보컬튠"), "보컬튠이 단가표에도 있으면 카탈로그가 두 벌");
});

test("할증 마스터: 미장센 50% — 요율이 코드가 아니라 테이블에 있다", () => {
  const s = db().prepare("SELECT * FROM surcharges WHERE key = 'mise_en_scene'").get();
  assert.ok(s, "미장센 할증 없음");
  assert.equal(s.label, "미장센 할증");
  assert.equal(s.rate, 0.5);
  assert.equal(s.applies_to, "filming");
  assert.equal(s.active, 1);
});

test("멱등: 게이트가 두 번 돌아도 중복 행이 생기지 않는다", () => {
  const before = db().prepare("SELECT COUNT(*) n FROM rooms").get().n;
  const beforeRates = db().prepare("SELECT COUNT(*) n FROM rate_items").get().n;
  // 게이트 플래그를 지우고 재실행 = 배포 재기동 + 플래그 유실 최악 케이스.
  db().prepare("DELETE FROM admin_state WHERE key = 'pricing_rooms_v2'").run();
  init();
  assert.equal(db().prepare("SELECT COUNT(*) n FROM rooms").get().n, before);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM rate_items").get().n, beforeRates);
  assert.equal(room("Studio A").id, 1, "재실행 후에도 id 보존");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM surcharges").get().n, 1);
});

test("세션 구간 테이블: 세션 삭제 시 CASCADE로 함께 사라진다", () => {
  const d = db();
  const p = d.prepare("INSERT INTO projects (title) VALUES ('구간 테스트')").run();
  const s = d
    .prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time) VALUES (?, '촬영', '2026-08-01', '10:00', '20:00')")
    .run(p.lastInsertRowid);
  const ins = d.prepare("INSERT INTO session_segments (session_id, kind, start_time, end_time, sort_order) VALUES (?, ?, ?, ?, ?)");
  ins.run(s.lastInsertRowid, "setup", "10:00", "12:00", 0);
  ins.run(s.lastInsertRowid, "shoot", "12:00", "19:00", 1);
  ins.run(s.lastInsertRowid, "teardown", "19:00", "20:00", 2);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM session_segments WHERE session_id = ?").get(s.lastInsertRowid).n, 3);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(s.lastInsertRowid);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM session_segments WHERE session_id = ?").get(s.lastInsertRowid).n, 0);
});
