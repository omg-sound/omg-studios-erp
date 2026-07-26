"use strict";

// 촬영 3구간(반입·설치 / 촬영 / 철수, 2026-07-26) + 미장센 할증.
//
// 핵심 분리: **요금 시간 = 구간 합산**, **룸 점유·캘린더 = 반입 시작 ~ 철수 종료 전체**.
// 구간 사이에 빈 시간이 있어도 그 방은 계속 잡혀 있으므로 점유는 아우르는 한 덩어리다(사용자 확정).
// 점유를 span으로 두면 겹침 판정·캘린더 동기화·청구 후보 쿼리가 종전 구조 그대로 동작한다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const {
  createSession,
  updateSession,
  getSessionForUser,
  listSessionSegments,
  sessionBillableMinutes,
  sessionRateAmount,
  deleteSession,
  busySessionRanges,
} = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const projectId = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('촬영 프로젝트', 'session', 0)").run().lastInsertRowid);
const pkgId = db().prepare("SELECT id FROM rate_items WHERE name = '기본 패키지'").get().id;
const soloId = db().prepare("SELECT id FROM rate_items WHERE name = '솔로 녹음'").get().id;
const roomA = db().prepare("SELECT id FROM rooms WHERE name = 'Studio A'").get().id;

/** 기본 패키지 촬영: 반입 10–12 / 촬영 12–19 / 철수 19–20 = 600분. */
const SEGS = {
  seg_setup_start: "10:00", seg_setup_end: "12:00",
  seg_shoot_start: "12:00", seg_shoot_end: "19:00",
  seg_teardown_start: "19:00", seg_teardown_end: "20:00",
};

const base = (extra = {}) => ({
  session_type: "촬영",
  session_date: "2026-09-01",
  rate_item_id: String(pkgId),
  room_id: String(roomA),
  status: "완료",
  ...extra,
});

test("구간을 넣으면 점유 시간(start~end)이 span으로 파생된다 — 시작·종료를 따로 안 받는다", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS }));
  assert.equal(s.start_time, "10:00", "반입 시작");
  assert.equal(s.end_time, "20:00", "철수 종료");
  const segs = listSessionSegments(s.id);
  assert.deepEqual(segs.map((g) => g.kind), ["setup", "shoot", "teardown"], "config 순서 고정");
  assert.deepEqual(segs.map((g) => `${g.start_time}-${g.end_time}`), ["10:00-12:00", "12:00-19:00", "19:00-20:00"]);
  deleteSession(CHIEF, s.id);
});

test("요금 시간은 구간 합산 — 사이에 빈 시간이 있으면 점유(span)보다 짧다", () => {
  // 반입 10–12, 촬영 14–19(2시간 공백), 철수 19–20 → 합산 480분, 점유 600분.
  const s = createSession(CHIEF, projectId, base({
    ...SEGS, seg_shoot_start: "14:00",
  }));
  assert.equal(s.start_time, "10:00");
  assert.equal(s.end_time, "20:00", "점유는 아우르는 전체(방을 계속 잡고 있다)");
  assert.equal(sessionBillableMinutes(getSessionForUser(CHIEF, s.id)), 480, "요금은 실제 쓴 구간의 합");
  const calc = sessionRateAmount(getSessionForUser(CHIEF, s.id));
  assert.equal(calc.minutes, 480);
  assert.equal(calc.amount, 1000000, "600분 기본 이내 → 기본가");
  deleteSession(CHIEF, s.id);
});

test("합산이 기본 시간을 넘으면 초과가 붙는다(구간 기준)", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS, seg_shoot_end: "20:30", seg_teardown_start: "20:30", seg_teardown_end: "21:30" }));
  // 반입 120 + 촬영 510 + 철수 60 = 690분 → 1.5시간 초과 → 2시간 가산
  assert.equal(sessionBillableMinutes(getSessionForUser(CHIEF, s.id)), 690);
  const calc = sessionRateAmount(getSessionForUser(CHIEF, s.id));
  assert.equal(calc.amount, 1200000);
  assert.deepEqual(calc.lines.map((l) => l.label), ["기본 패키지", "초과 시간"]);
  deleteSession(CHIEF, s.id);
});

test("구간이 없는 세션은 종전대로 시작~종료 span이 요금 시간", () => {
  const s = createSession(CHIEF, projectId, {
    session_type: "녹음", session_date: "2026-09-02", rate_item_id: String(soloId),
    start_time: "14:00", duration_mode: "custom", custom_hours: "3.5", status: "완료",
  });
  assert.equal(listSessionSegments(s.id).length, 0);
  assert.equal(sessionBillableMinutes(getSessionForUser(CHIEF, s.id)), 210);
  assert.equal(sessionRateAmount(getSessionForUser(CHIEF, s.id)).amount, 300000);
  deleteSession(CHIEF, s.id);
});

test("겹침 판정은 점유 span 기준 — 구간 공백 시간에도 그 룸은 잡혀 있다", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS, seg_shoot_start: "14:00" })); // 공백 12–14시
  const busy = busySessionRanges("2026-09-01", { room: String(roomA) });
  const mine = busy.find((b) => b.id === s.id);
  assert.ok(mine, "점유 구간에 잡힌다");
  assert.equal(mine.start, 600, "10:00");
  assert.equal(mine.end, 1200, "20:00 — 공백을 포함한 전체");
  deleteSession(CHIEF, s.id);
});

test("종일 체크는 구간을 지운다(시간이 없는 일정에 구간은 성립하지 않는다)", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS }));
  assert.equal(listSessionSegments(s.id).length, 3);
  const u = updateSession(CHIEF, s.id, base({ ...SEGS, all_day: "1" }));
  assert.equal(u.all_day, 1);
  assert.equal(u.start_time, null);
  assert.equal(listSessionSegments(s.id).length, 0, "종일이면 구간 없음");
  deleteSession(CHIEF, s.id);
});

test("구간 칸이 없는 요청은 기존 구간을 건드리지 않는다(구간 모르는 폼의 저장이 지우지 않게)", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS }));
  assert.equal(listSessionSegments(s.id).length, 3);
  // 구간 필드를 아예 안 보내고 메모만 바꿔 저장(다른 화면·API 경로 모사).
  updateSession(CHIEF, s.id, base({ start_time: "10:00", duration_mode: "custom", custom_hours: "10", memo: "메모만" }));
  assert.equal(listSessionSegments(s.id).length, 3, "구간 유지");
  deleteSession(CHIEF, s.id);
});

test("한쪽만 채운 구간은 저장하지 않는다(입력 중인 칸)", () => {
  const s = createSession(CHIEF, projectId, base({
    seg_setup_start: "10:00", seg_setup_end: "12:00",
    seg_shoot_start: "12:00", seg_shoot_end: "19:00",
    seg_teardown_start: "19:00", seg_teardown_end: "", // 종료 미입력
  }));
  assert.deepEqual(listSessionSegments(s.id).map((g) => g.kind), ["setup", "shoot"]);
  assert.equal(s.end_time, "19:00", "span은 저장된 구간까지");
  deleteSession(CHIEF, s.id);
});

test("자정을 넘기는 구간도 span이 이어진다", () => {
  const s = createSession(CHIEF, projectId, base({
    session_date: "2026-09-03",
    seg_setup_start: "20:00", seg_setup_end: "22:00",
    seg_shoot_start: "22:00", seg_shoot_end: "02:00",
    seg_teardown_start: "02:00", seg_teardown_end: "03:00",
  }));
  assert.equal(s.start_time, "20:00");
  assert.equal(s.end_time, "03:00", "다음 날 새벽 — end < start(야간 표현)");
  assert.equal(sessionBillableMinutes(getSessionForUser(CHIEF, s.id)), 420, "2h + 4h + 1h");
  deleteSession(CHIEF, s.id);
});

test("미장센 할증: 체크하면 대관비의 50%가 가산되고 사유가 남는다", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS, surcharge_key: "mise_en_scene", surcharge_memo: "세트 제작·조명 연출" }));
  const row = getSessionForUser(CHIEF, s.id);
  assert.equal(row.surcharge_key, "mise_en_scene");
  assert.equal(row.surcharge_memo, "세트 제작·조명 연출");
  const calc = sessionRateAmount(row);
  assert.equal(calc.amount, 1500000, "100만 + 할증 50만");
  assert.equal(calc.surcharge.label, "미장센 할증");
  deleteSession(CHIEF, s.id);
});

test("할증 체크를 풀면 사유도 함께 지운다(할증 없는데 사유만 남지 않게)", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS, surcharge_key: "mise_en_scene", surcharge_memo: "세트 제작" }));
  const u = updateSession(CHIEF, s.id, base({ ...SEGS, surcharge_memo: "세트 제작" })); // 체크 해제
  assert.equal(u.surcharge_key, null);
  assert.equal(u.surcharge_memo, null);
  assert.equal(sessionRateAmount(u).amount, 1000000);
  deleteSession(CHIEF, s.id);
});

test("마스터에 없는 할증 key는 무시한다(폼이 보낸 문자열을 그대로 믿지 않는다)", () => {
  const s = createSession(CHIEF, projectId, base({ ...SEGS, surcharge_key: "made_up", surcharge_memo: "임의" }));
  assert.equal(getSessionForUser(CHIEF, s.id).surcharge_key, null);
  deleteSession(CHIEF, s.id);
});
