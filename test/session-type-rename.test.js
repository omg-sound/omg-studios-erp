"use strict";

// ── 세션 종류 '촬영' → '촬영 대관' + '작업 대관' 분리 회귀 잠금(2026-07-30 사용자 결정) ──
// 🏷 대관 = 스튜디오가 작업을 대행하지 않고 **자리를 내주는 거래**. 두 종류로 나눈 이유가 이 파일의 핵심이다:
//    폼의 갈림길이 **세션 종류 하나**라서, 한 종류로 묶으면 작업 대관(믹싱룸 대여)에도 촬영용 3구간
//    (반입·설치/촬영/철수)이 강제되고 시작–종료·소요 슬라이더가 숨는다. kind를 갈라 그 문제를 없앴다.
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

const { SESSION_TYPES, RENTAL_SESSION_TYPES, SESSION_TYPE_RATE_KIND, normalizeSessionType } = require("../src/config");

test("config: 대관이 두 종류로 갈려 있고 둘 다 시간제 청구 대상", () => {
  assert.ok(SESSION_TYPES.includes("촬영 대관"), "촬영 대관");
  assert.ok(SESSION_TYPES.includes("작업 대관"), "작업 대관");
  assert.ok(!SESSION_TYPES.includes("촬영"), "옛 '촬영' 제거");
  assert.ok(!SESSION_TYPES.includes("대관"), "중간 이름 '대관' 제거");
  for (const t of ["촬영 대관", "작업 대관"]) assert.ok(RENTAL_SESSION_TYPES.includes(t), `${t}은 대관 매출`);
});

test("🔒 3구간 폼은 촬영 대관에만 — 작업 대관은 시작–종료를 쓴다", () => {
  // 구간 노출은 이름이 아니라 kind에서 파생된다(views.sessions.js가 같은 필터를 쓴다).
  // 이 단정이 깨지면 작업 대관 예약에도 반입·설치/촬영/철수 칸이 뜨고 소요 슬라이더가 숨는다.
  const segmentTypes = SESSION_TYPES.filter((t) => SESSION_TYPE_RATE_KIND[t] === "filming");
  assert.deepEqual(segmentTypes, ["촬영 대관"], "구간 폼을 쓰는 종류는 촬영 대관 하나");
  assert.equal(SESSION_TYPE_RATE_KIND["작업 대관"], "workspace", "작업 대관은 별도 kind");
  assert.equal(SESSION_TYPE_RATE_KIND["녹음"], "recording");
  assert.equal(SESSION_TYPE_RATE_KIND["공연"], "performance");
});

test("요금표 분류가 config의 모든 kind를 받는다(안 받으면 그 종류의 단가 select이 영영 빈다)", () => {
  // 허용목록(KINDS)은 비공개 상수라 **공개 API로 행동을 검증**한다: 허용 안 된 kind는 조용히
  // 'recording'으로 떨어지므로, 그러면 '작업 대관' 세션 폼에 붙을 분류가 없어 단가를 못 고른다.
  const { createRateCategory, rateCategoryKind } = require("../src/data");
  const configKinds = [...new Set(Object.values(SESSION_TYPE_RATE_KIND))];
  for (const k of configKinds) {
    const name = `계약검사-${k}`;
    const cat = createRateCategory({ name, kind: k });
    assert.equal(cat.kind, k, `분류가 kind=${k}를 그대로 받아야 한다(폴백되면 그 세션 종류가 단가를 못 쓴다)`);
    assert.equal(rateCategoryKind(name), k, "조회도 같은 kind");
  }
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

test("일정 라벨: 종류와 단가 항목명이 겹치면 항목명만 쓴다", () => {
  // '촬영 대관 · 촬영 대관'·'녹음 · 솔로 녹음'처럼 같은 말이 두 번 나오던 것(2026-07-30).
  const { eventInputForSession } = require("../src/routes/sessions.routes");
  assert.ok(typeof eventInputForSession === "function", "라우트가 캘린더 입력 빌더를 노출");
  const { createRateItem } = require("../src/data");
  const item = createRateItem({ rate_name: "촬영 대관", category: "스튜디오 촬영", base_hours: "4", base_price: "400000", extra_hours: "1", extra_price: "100000" });
  const ev = eventInputForSession(
    { id: 1, session_type: "촬영 대관", session_date: "2026-08-01", start_time: "10:00", end_time: "14:00", rate_item_id: item.id, status: "예정" },
    { id: 1, title: "테스트", artist: "루나" },
  );
  const text = JSON.stringify(ev);
  assert.ok(text.includes("촬영 대관"), "항목명 표기");
  assert.ok(!text.includes("촬영 대관 · 촬영 대관"), "종류+항목명 중복 없음");
});
