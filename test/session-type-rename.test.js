"use strict";

// ── 세션 종류 '촬영' → '대관' 개명 회귀 잠금(2026-07-30 사용자 결정) ──
// 스튜디오가 촬영을 대행하는 게 아니라 공간을 대관하므로 종류명을 바꿨다(무엇을 위한 대관인지는 단가 항목
// 이름으로 표현 — 예 '촬영 대관'). ⚠️`sessions.session_type`은 **한글 문자열로 저장**되므로 상수만 바꾸면
// 기존 행이 목록에 없는 값이 되어 ①편집 폼에서 첫 값('녹음')으로 조용히 떨어지고 ②대관 청구 후보에서 빠진다.
// 그래서 마이그레이션(`session_type_filming_to_rental_v1`)과 옛 이름 흡수(정규화 alias)가 함께 있어야 한다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { SESSION_TYPES, RENTAL_SESSION_TYPES, SESSION_TYPE_RATE_KIND, normalizeSessionType } = require("../src/config");

test("config: 종류 목록·대관 매출·단가 kind가 모두 '대관'을 쓴다('촬영' 잔존 없음)", () => {
  assert.ok(SESSION_TYPES.includes("대관"), "세션 종류에 대관");
  assert.ok(!SESSION_TYPES.includes("촬영"), "옛 '촬영' 제거");
  assert.ok(RENTAL_SESSION_TYPES.includes("대관"), "대관 매출 세션에 포함");
  assert.equal(SESSION_TYPE_RATE_KIND["대관"], "filming", "단가 kind 매핑(요금표 분류 연결·구간 노출의 근거)");
  assert.equal(SESSION_TYPE_RATE_KIND["촬영"], undefined, "옛 키 제거");
});

test("정규화: 옛 이름 '촬영'이 들어오면 '대관'으로 흡수한다(첫 값으로 떨어지지 않게)", () => {
  // 캐시된 폼·외부 호출·옛 링크가 '촬영'을 보낼 수 있다. 그냥 normalize하면 목록에 없어 '녹음'이 된다 —
  // 녹음 단가로 청구될 수 있는 조용한 오류라 alias로 막는다.
  assert.equal(normalizeSessionType("촬영"), "대관");
  assert.equal(normalizeSessionType("대관"), "대관");
  assert.equal(normalizeSessionType("믹싱"), "믹싱");
  assert.equal(normalizeSessionType(""), "녹음", "빈 값은 기본(첫 값)");
});

test("마이그레이션: 기존 '촬영' 세션 행이 '대관'으로 갱신된다(게이트 1회)", () => {
  const D = db();
  const pj = D.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('개명 테스트', 'session', 0)").run().lastInsertRowid;
  // 정규화를 우회해 옛 값을 직접 심는다(마이그레이션 이전 데이터 재현).
  const legacy = D.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time) VALUES (?, '촬영', '2026-08-01', '10:00', '14:00')").run(pj).lastInsertRowid;
  const keep = D.prepare("INSERT INTO sessions (project_id, session_type, session_date) VALUES (?, '믹싱', '2026-08-02')").run(pj).lastInsertRowid;

  // 게이트를 지우고 다시 init → 마이그레이션만 재실행된다(다른 게이트는 done이라 무동작).
  D.prepare("DELETE FROM admin_state WHERE key = 'session_type_filming_to_rental_v1'").run();
  init();

  assert.equal(D.prepare("SELECT session_type FROM sessions WHERE id = ?").get(legacy).session_type, "대관", "옛 촬영 세션 갱신");
  assert.equal(D.prepare("SELECT session_type FROM sessions WHERE id = ?").get(keep).session_type, "믹싱", "다른 종류는 건드리지 않음");
  assert.ok(D.prepare("SELECT value FROM admin_state WHERE key = 'session_type_filming_to_rental_v1'").get(), "게이트 재설정(1회성)");
});
