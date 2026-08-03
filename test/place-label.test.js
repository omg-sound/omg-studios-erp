"use strict";

// ── 외부 일정 캘린더 제목의 장소 라벨(2026-08-03 사용자 요청) ──
// 규칙: 국내 장소=이름 / 국내 주소=동네+번지(구 제외) / 해외=국가+도시(국가 먼저).
// 설계·근거 = docs/superpowers/specs/2026-08-03-external-session-title-location-design.md
//
// 아래 FIXTURES는 **운영 키로 실제 조회한 응답**(2026-08-03, 표본 7건)을 그대로 줄인 것이다.
// 규칙이 응답 구조에 통째로 의존하므로(어느 필드에서 무엇을 꺼내는지) 실측을 박아 두지 않으면
// 조립 순서를 누가 바꿔도 아무도 모른다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { init, db } = require("../src/db");
init();

const { placeLabel } = require("../src/lib/place-label");
const { eventInputForSession } = require("../src/routes/sessions.routes");
const { createSession, updateSession, getSessionForUser } = require("../src/data");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const c = (types, longText, shortText) => ({ types, longText, shortText: shortText || longText });

const FIXTURES = {
  잠실실내체육관: {
    types: ["gym", "sports_activity_location", "health", "point_of_interest", "establishment"],
    displayName: { text: "잠실실내체육관" },
    shortFormattedAddress: "송파구 올림픽로 25 내2문",
    addressComponents: [
      c(["point_of_interest", "establishment"], "내2문"),
      c(["premise"], "25"),
      c(["sublocality_level_4", "sublocality", "political"], "올림픽로"),
      c(["sublocality_level_1", "sublocality", "political"], "송파구"),
      c(["administrative_area_level_1", "political"], "서울특별시"),
      c(["country", "political"], "대한민국", "KR"),
    ],
  },
  장충체육관: {
    types: ["arena", "event_venue", "point_of_interest", "establishment"],
    displayName: { text: "장충체육관" },
    shortFormattedAddress: "중구 동호로 241",
    addressComponents: [
      c(["premise"], "241"),
      c(["sublocality_level_4", "sublocality", "political"], "동호로"),
      c(["sublocality_level_1", "sublocality", "political"], "중구"),
      c(["administrative_area_level_1", "political"], "서울특별시"),
      c(["country", "political"], "대한민국", "KR"),
    ],
  },
  도로명: {
    types: ["street_address"],
    displayName: { text: "27-3" }, // ⚠️ 주소 유형은 displayName이 번지 조각뿐이다
    shortFormattedAddress: "용산구 이태원로15길 27-3",
    addressComponents: [
      c(["premise"], "27-3"),
      c(["sublocality_level_4", "sublocality", "political"], "이태원로15길"),
      c(["sublocality_level_1", "sublocality", "political"], "용산구"),
      c(["administrative_area_level_1", "political"], "서울특별시"),
      c(["country", "political"], "대한민국", "KR"),
    ],
  },
  지번: {
    types: ["street_address"],
    displayName: { text: "181-53" },
    shortFormattedAddress: "용산구 이태원동 181-53",
    addressComponents: [
      c(["premise"], "181-53"),
      c(["sublocality_level_2", "sublocality", "political"], "이태원동"),
      c(["sublocality_level_1", "sublocality", "political"], "용산구"),
      c(["administrative_area_level_1", "political"], "서울특별시"),
      c(["country", "political"], "대한민국", "KR"),
    ],
  },
  이스탄불: {
    types: ["locality", "political"],
    displayName: { text: "이스탄불" },
    shortFormattedAddress: "이스탄불",
    addressComponents: [
      c(["locality", "political"], "이스탄불"),
      c(["administrative_area_level_1", "political"], "이스탄불 주"),
      c(["country", "political"], "튀르키예", "TR"),
    ],
  },
  멕시코아레나: {
    types: ["event_venue", "arena", "concert_hall", "point_of_interest", "establishment"],
    displayName: { text: "멕시코시티 아레나" },
    shortFormattedAddress: "Av. de las Granjas 800, Santa Barbara, Ciudad de México",
    addressComponents: [
      c(["street_number"], "800"),
      c(["route"], "Avenida de las Granjas", "Av. de las Granjas"),
      c(["sublocality_level_1", "sublocality", "political"], "Santa Barbara"),
      c(["locality", "political"], "Ciudad de México", "México D.F."),
      c(["administrative_area_level_1", "political"], "Ciudad de México", "CDMX"),
      c(["country", "political"], "멕시코", "MX"),
    ],
  },
  매디슨스퀘어가든: {
    types: ["arena", "stadium", "tourist_attraction", "point_of_interest", "establishment"],
    displayName: { text: "매디슨 스퀘어 가든" },
    shortFormattedAddress: "Pennsylvania Station, New York",
    addressComponents: [
      c(["locality", "political"], "뉴욕"),
      c(["sublocality_level_1", "sublocality", "political"], "맨해튼"),
      c(["administrative_area_level_2", "political"], "뉴욕 카운티"),
      c(["administrative_area_level_1", "political"], "뉴욕", "NY"),
      c(["country", "political"], "미국", "US"),
    ],
  },
};

test("placeLabel: 국내 장소는 이름 그대로(displayName)", () => {
  assert.equal(placeLabel(FIXTURES.잠실실내체육관), "잠실실내체육관");
  assert.equal(placeLabel(FIXTURES.장충체육관), "장충체육관");
});

test("placeLabel: 국내 주소는 동네+번지 — 구(區)를 빼고 조립한다", () => {
  // mainText("용산구 이태원로15길 27-3")를 쓰면 구가 따라붙는다 → addressComponents 조립(사용자 결정: 구 제외).
  assert.equal(placeLabel(FIXTURES.도로명), "이태원로15길 27-3", "도로명: sublocality_level_4 + premise");
  assert.equal(placeLabel(FIXTURES.지번), "이태원동 181-53", "지번: sublocality_level_2 + premise");
});

test("placeLabel: 해외는 국가 먼저 + 도시", () => {
  assert.equal(placeLabel(FIXTURES.이스탄불), "튀르키예 이스탄불");
  assert.equal(placeLabel(FIXTURES.매디슨스퀘어가든), "미국 뉴욕", "해외는 장소여도 국가+도시(장소명 아님)");
  // 구글이 한국어 도시명을 안 주는 나라가 있다 — 그대로 둔다(사용자 결정, 별칭 표를 만들지 않는다).
  assert.equal(placeLabel(FIXTURES.멕시코아레나), "멕시코 Ciudad de México");
});

test("placeLabel: 조립할 게 없으면 shortFormattedAddress로 폴백(구가 붙어도 없는 것보단 낫다)", () => {
  const bare = {
    types: ["street_address"],
    displayName: { text: "5" },
    shortFormattedAddress: "어딘가 5",
    addressComponents: [c(["country", "political"], "대한민국", "KR")], // 동네·번지 성분이 없는 형태
  };
  assert.equal(placeLabel(bare), "어딘가 5");
});

test("placeLabel: 빈 입력·국가 없음은 빈 문자열(제목을 안 건드린다)", () => {
  assert.equal(placeLabel(null), "");
  assert.equal(placeLabel({}), "");
  assert.equal(placeLabel({ types: [], addressComponents: [] }), "");
});

test("placeLabel: 길이 상한 40자 + 개행·연속 공백 정리(제목에 들어가는 값이라)", () => {
  const long = {
    types: ["locality"],
    addressComponents: [c(["locality", "political"], "가".repeat(60)), c(["country", "political"], "어떤나라", "XX")],
  };
  const out = placeLabel(long);
  assert.ok(out.length <= 40, `40자 이하(실제 ${out.length})`);
  const messy = {
    types: ["locality"],
    addressComponents: [c(["locality", "political"], " 이스탄불 \n 시 "), c(["country", "political"], "튀르키예", "TR")],
  };
  assert.equal(placeLabel(messy), "튀르키예 이스탄불 시", "개행·연속 공백은 한 칸으로");
});

// ── 제목 조합 ──
const project = { title: "루나 1집", artist: "루나", production_company: "뮤직팜" };
const base = { id: 0, project_id: 5, session_type: "녹음", session_date: "2026-08-01", start_time: "14:00", end_time: "18:00", status: "예정" };
const titleOf = (extra) => eventInputForSession({ ...base, ...extra }, project).title;

test("제목: 외부 일정이면 맨 뒤에 @장소, 라벨이 없으면 그대로", () => {
  assert.equal(titleOf({}), "루나 · 뮤직팜", "라벨 없음 = 기존 제목(스튜디오 룸 세션이 여기 해당)");
  assert.equal(titleOf({ location_label: "잠실실내체육관" }), "루나 · 뮤직팜 @잠실실내체육관");
  assert.equal(titleOf({ location_label: "튀르키예 이스탄불" }), "루나 · 뮤직팜 @튀르키예 이스탄불");
  assert.equal(titleOf({ location_label: "   " }), "루나 · 뮤직팜", "공백뿐인 라벨은 없는 것으로");
});

test("제목: '(취소)'는 맨 앞, 장소는 맨 뒤 — 둘이 함께 걸린다", () => {
  assert.equal(titleOf({ status: "취소", location_label: "장충체육관" }), "(취소) 루나 · 뮤직팜 @장충체육관");
});

// ── 저장 계약 ──
const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const projectId = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('외부 공연', 'session', 0)").run().lastInsertRowid);
const studioRoom = db().prepare("SELECT id FROM rooms WHERE name = 'Studio A'").get().id;
const extRoom = Number(db().prepare("INSERT INTO rooms (name, bookable, is_external, sort_order, active) VALUES ('외부일정', 1, 1, 90, 1)").run().lastInsertRowid);
const mk = (extra) => createSession(CHIEF, projectId, {
  session_type: "녹음", session_date: "2026-09-01", start_time: "14:00", custom_hours: "3", status: "예정", ...extra,
});

test("저장: 라벨은 주소와 같은 조건 — 외부 장소일 때만 남고 스튜디오 룸이면 지워진다", () => {
  const ext = mk({ room_id: String(extRoom), location: "대한민국 서울특별시 송파구 올림픽로 25", location_label: "잠실실내체육관" });
  assert.equal(ext.location_label, "잠실실내체육관", "외부 장소: 저장됨");
  assert.equal(eventInputForSession(getSessionForUser(CHIEF, ext.id), project).title, "루나 · 뮤직팜 @잠실실내체육관");

  const studio = mk({ room_id: String(studioRoom), location: "무시됨", location_label: "잠실실내체육관" });
  assert.equal(studio.location_label, null, "스튜디오 룸: 주소와 함께 라벨도 null");

  // 외부 → 스튜디오로 되돌리면 라벨이 남아 제목에 옛 장소가 계속 붙으면 안 된다.
  const moved = updateSession(CHIEF, ext.id, {
    session_type: "녹음", session_date: "2026-09-01", start_time: "14:00", custom_hours: "3", status: "예정",
    room_id: String(studioRoom), location_label: "잠실실내체육관",
  });
  assert.equal(moved.location_label, null, "장소를 스튜디오로 되돌리면 라벨도 지워진다");
  assert.equal(eventInputForSession(getSessionForUser(CHIEF, moved.id), project).title, "루나 · 뮤직팜");
});

test("저장: 클라이언트가 보낸 라벨은 길이·개행만 정리한다(계산은 서버가 place-label로 따로 한다)", () => {
  const s = mk({ room_id: String(extRoom), location: "어딘가", location_label: " 잠실 \n 실내체육관 " });
  assert.equal(s.location_label, "잠실 실내체육관", "개행·연속 공백 정리");
  const long = mk({ room_id: String(extRoom), location: "어딘가", location_label: "가".repeat(80) });
  assert.ok(long.location_label.length <= 40, "40자 상한");
});
