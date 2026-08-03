"use strict";

// ── 구글 캘린더 이벤트 시간 조립(eventTimes) 회귀 잠금 ──
// 종일 end.date는 배타적(마지막 날+1)이고 다일·야간 익일 산술이 KST에서 하루 밀리기 쉬운 클래스
// (toISOString은 UTC — T00:00:00Z + setUTCDate로 순수 날짜 연산이라 안 밀리지만 무테스트였음).
// 앱→구글 단방향 푸시라 fail-safe로 무음 처리 → 하루 밀린 일정이 조용히 나가도 감지 안 됨.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { eventTimes } = require("../src/calendar");

test("eventTimes: 시간 세션 → KST dateTime(+09:00)", () => {
  const r = eventTimes("2026-02-05", "14:00", "17:00");
  assert.deepEqual(r, {
    start: { dateTime: "2026-02-05T14:00:00+09:00", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-02-05T17:00:00+09:00", timeZone: "Asia/Seoul" },
  });
});

test("eventTimes: 야간(종료<=시작) → 종료는 익일", () => {
  const r = eventTimes("2026-02-05", "22:00", "02:00");
  assert.equal(r.start.dateTime, "2026-02-05T22:00:00+09:00");
  assert.equal(r.end.dateTime, "2026-02-06T02:00:00+09:00", "익일 02:00");
});

test("eventTimes: 단일 종일 → end.date 배타적(다음날)", () => {
  const r = eventTimes("2026-02-05", null, null);
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-06" } });
});

test("eventTimes: 다일 종일(2/5~2/9) → end.date = 종료+1(배타적)", () => {
  const r = eventTimes("2026-02-05", "", "", "2026-02-09");
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-10" } });
});

test("eventTimes: KST 월·연 경계에서 +1일이 밀리지 않음", () => {
  assert.equal(eventTimes("2026-02-28", null, null).end.date, "2026-03-01", "2월 28일(비윤년) → 3월 1일");
  assert.equal(eventTimes("2026-12-31", null, null).end.date, "2027-01-01", "연말 → 다음해 1월 1일");
  assert.equal(eventTimes("2028-02-28", null, null).end.date, "2028-02-29", "윤년 2월 28일 → 2월 29일");
});

test("eventTimes: 종료<시작 문자열 순서가 아닌 다일 종일은 endDate 무시(단일 취급)", () => {
  // endDate가 date보다 앞이면(비정상) 단일 종일로 폴백.
  const r = eventTimes("2026-02-05", null, null, "2026-02-01");
  assert.deepEqual(r, { start: { date: "2026-02-05" }, end: { date: "2026-02-06" } });
});

// ── 종일 ↔ 시간 전환(2026-08-03 사용자 리포트 '종일 3일 일정을 바꾸니 캘린더 연동이 안 된다') ──
// events.patch는 **중첩 객체까지 병합**한다. 그래서 갱신 경로에서 반대 필드를 명시적으로 null로 지우지
// 않으면 구글에 남아 있던 date와 새 dateTime이 공존해 400 "Invalid start time"이 난다(실제 로그로 확인).
// fail-safe라 저장은 성공하고 캘린더만 조용히 옛 상태로 남았다.
test("eventTimes(갱신): 시간 일정은 date를 null로 지운다 — 종일이던 일정을 시간으로 바꿀 수 있게", () => {
  const r = eventTimes("2026-02-05", "14:00", "17:00", null, true);
  assert.deepEqual(r, {
    start: { dateTime: "2026-02-05T14:00:00+09:00", timeZone: "Asia/Seoul", date: null },
    end: { dateTime: "2026-02-05T17:00:00+09:00", timeZone: "Asia/Seoul", date: null },
  });
});

test("eventTimes(갱신): 종일은 dateTime·timeZone을 null로 지운다 — 시간이던 일정을 종일로 바꿀 수 있게", () => {
  const r = eventTimes("2026-02-05", null, null, "2026-02-09", true);
  assert.deepEqual(r, {
    start: { date: "2026-02-05", dateTime: null, timeZone: null },
    end: { date: "2026-02-10", dateTime: null, timeZone: null },
  });
});

test("eventTimes(생성): 지울 기존 값이 없으므로 null을 넣지 않는다", () => {
  // 기본값(clearOpposite=false) = 위 생성 경로 테스트들과 동일한 형태 — null 키가 섞이면 insert가 거부될 여지만 생긴다.
  assert.deepEqual(eventTimes("2026-02-05", "14:00", "17:00"), {
    start: { dateTime: "2026-02-05T14:00:00+09:00", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-02-05T17:00:00+09:00", timeZone: "Asia/Seoul" },
  });
  assert.deepEqual(eventTimes("2026-02-05", null, null), { start: { date: "2026-02-05" }, end: { date: "2026-02-06" } });
});

// ── 동기화 실패는 화면에 보여야 한다(2026-08-03 사용자 요청) ──
// 예전엔 updateEvent가 실패해도 기존 이벤트 id를 돌려줘서 syncSessionEvent가 성공으로 보고했고,
// 저장은 됐는데 캘린더만 안 바뀐 걸 사용자가 나중에 알았다(종일↔시간 400이 그렇게 며칠 숨어 있었다).
const { calFlash } = require("../src/routes/sessions.routes");

test("calFlash: 성공은 그대로, 설정 문제와 API 오류는 다른 안내로 나뉜다", () => {
  assert.equal(calFlash({ synced: true }, "saved"), "saved");
  assert.equal(calFlash(null, "saved"), "saved", "동기화 정보가 없으면(취소 등) 평소 안내");
  assert.equal(calFlash({ synced: false, setup: true }, "saved"), "saved_cal_off", "설정 문제 → 환경설정 안내");
  assert.equal(calFlash({ synced: false }, "saved"), "saved_cal_err", "API 오류 → 재저장·재동기화 안내");
  assert.equal(calFlash({ synced: false }, "added"), "added_cal_err", "추가 경로도 같은 규칙");
});

test("flash 문구: API 오류 키가 등록돼 있고 경고로 뜬다", () => {
  const views = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "views.js"), "utf8");
  for (const k of ["added_cal_err", "saved_cal_err"]) {
    assert.match(views, new RegExp(`${k}:\\s*"`), `${k} 문구 정의`);
    assert.match(views, new RegExp(`FLASH_WARN[^\\n]*"${k}"`), `${k}는 경고 스타일`);
  }
});
