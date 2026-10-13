"use strict";

// ── 세션 종류 '촬영' → '촬영 대관' + '작업 대관' 분리 회귀 잠금(2026-07-30 사용자 결정) ──
// 🏷 대관 = 스튜디오가 작업을 대행하지 않고 **자리를 내주는 거래**. 성격·단가대가 다른 두 거래라 나눈다
//    (촬영 3구간 입력은 개편 4단계에서 삭제됐지만 매출 '종류별 구성'에서 갈려 보이는 이점은 그대로다).
// ⚠️`sessions.session_type`은 **한글 문자열로 저장**되므로 상수만 바꾸면 기존 행이 목록에 없는 값이 되어
//    ①편집 폼에서 첫 값('녹음')으로 조용히 떨어지고 ②대관 청구 후보에서 빠진다 → 마이그레이션 + alias 필수.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { SESSION_TYPES, RENTAL_SESSION_TYPES, normalizeSessionType } = require("../src/config");

test("config: 대관이 두 종류로 갈려 있고 둘 다 시간제 청구 대상", () => {
  assert.ok(SESSION_TYPES.includes("촬영 대관"), "촬영 대관");
  assert.ok(SESSION_TYPES.includes("작업 대관"), "작업 대관");
  assert.ok(!SESSION_TYPES.includes("촬영"), "옛 '촬영' 제거");
  assert.ok(!SESSION_TYPES.includes("대관"), "중간 이름 '대관' 제거");
  for (const t of ["촬영 대관", "작업 대관"]) assert.ok(RENTAL_SESSION_TYPES.includes(t), `${t}은 대관 매출`);
});

test("정규화: 옛 이름('촬영')·중간 이름('대관')을 '촬영 대관'으로 흡수한다", () => {
  // 캐시된 폼·외부 호출·옛 링크가 옛 값을 보낼 수 있다. 그냥 normalize하면 목록에 없어 '녹음'이 되고,
  // 녹음 단가로 청구될 수 있는 조용한 오류가 된다.
  assert.equal(normalizeSessionType("촬영"), "촬영 대관");
  assert.equal(normalizeSessionType("대관"), "촬영 대관");
  assert.equal(normalizeSessionType("작업 대관"), "작업 대관");
  assert.equal(normalizeSessionType("믹싱"), "믹싱");
  assert.equal(normalizeSessionType(""), "녹음", "빈 값은 기본(첫 값)");
});

test("마이그레이션: 옛 '촬영'·'대관' 세션 행이 '촬영 대관'으로 갱신된다(한 단계·게이트 1회)", () => {
  const D = db();
  const pj = D.prepare("INSERT INTO projects (title, project_type, rate) VALUES ('개명 테스트', 'session', 0)").run().lastInsertRowid;
  // 정규화를 우회해 옛 값을 직접 심는다(마이그레이션 이전 데이터 재현).
  const ins = D.prepare("INSERT INTO sessions (project_id, session_type, session_date) VALUES (?, ?, '2026-08-01')");
  const old1 = ins.run(pj, "촬영").lastInsertRowid; // 프로덕션에 있는 값
  const old2 = ins.run(pj, "대관").lastInsertRowid; // 개발 DB에만 있던 중간 이름
  const keep = ins.run(pj, "믹싱").lastInsertRowid;

  D.prepare("DELETE FROM admin_state WHERE key = 'session_type_rental_split_v1'").run();
  init(); // 게이트를 지우고 재실행 → 이 마이그레이션만 다시 돈다

  const typeOf = (id) => D.prepare("SELECT session_type FROM sessions WHERE id = ?").get(id).session_type;
  assert.equal(typeOf(old1), "촬영 대관", "옛 '촬영'");
  assert.equal(typeOf(old2), "촬영 대관", "중간 '대관'");
  assert.equal(typeOf(keep), "믹싱", "다른 종류는 건드리지 않음");
  assert.ok(D.prepare("SELECT value FROM admin_state WHERE key = 'session_type_rental_split_v1'").get(), "게이트 재설정(1회성)");
});

test("일정 라벨: 대관 종류도 '{종류} 세션'(단가 항목명은 개편 4단계에서 사라짐)", () => {
  const { eventInputForSession } = require("../src/routes/sessions.routes");
  const ev = eventInputForSession(
    { id: 1, session_type: "촬영 대관", session_date: "2026-08-01", start_time: "10:00", end_time: "14:00", status: "예정" },
    { id: 1, title: "테스트", artist: "루나" },
  );
  assert.match(JSON.stringify(ev), /종류: 촬영 대관 세션/);
});
