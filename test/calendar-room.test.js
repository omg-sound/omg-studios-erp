"use strict";

// ── 캘린더 제목 종류 태그 + 룸별 캘린더(2026-10-22 사용자 요청) ──
// ① 월간뷰에서 녹음인지 믹스인지 식별이 안 돼 제목 뒤에 `[녹음]`·`[믹스]`를 붙인다.
// ② Studio C는 다른 룸과 장소가 안 겹쳐 따로 보고 싶다 → 룸마다 캘린더를 지정하고, 세션은 일정이
//    **어느 캘린더에 있는지**(sessions.gcal_calendar_id)를 기억해 룸이 바뀌면 events.move로 옮긴다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { init, db } = require("../src/db");
init();
const { eventInputForSession, syncSessionEvent } = require("../src/routes/sessions.routes");
const { updateRoom, bulkUpdateRooms, getRoom } = require("../src/data/rooms");
const { roomsSection } = require("../src/views.settings");

const project = { title: "루나 1집", artist: "루나", production_company: "뮤직팜" };
const base = { id: 0, project_id: 5, session_date: "2026-11-01", start_time: "14:00", end_time: "18:00", status: "예정" };
const titleOf = (extra) => eventInputForSession({ ...base, ...extra }, project).title;

test("제목: 종류 태그는 짧은 표기, '기타'는 안 붙인다", () => {
  assert.equal(titleOf({ session_type: "녹음" }), "루나 · 뮤직팜 [녹음]");
  assert.equal(titleOf({ session_type: "믹싱" }), "루나 · 뮤직팜 [믹스]");
  assert.equal(titleOf({ session_type: "마스터링" }), "루나 · 뮤직팜 [마스터링]");
  assert.equal(titleOf({ session_type: "촬영 대관" }), "루나 · 뮤직팜 [촬영]");
  assert.equal(titleOf({ session_type: "작업 대관" }), "루나 · 뮤직팜 [작업]");
  assert.equal(titleOf({ session_type: "공연" }), "루나 · 뮤직팜 [공연]");
  assert.equal(titleOf({ session_type: "기타" }), "루나 · 뮤직팜", "기타는 정보가 없어 태그 없음");
  assert.equal(titleOf({ session_type: null }), "루나 · 뮤직팜", "종류 없음");
});

test("제목: (취소)는 맨 앞, 종류 태그는 @장소 앞", () => {
  assert.equal(titleOf({ session_type: "믹싱", status: "취소", location_label: "잠실실내체육관" }), "(취소) 루나 · 뮤직팜 [믹스] @잠실실내체육관");
});

// ── 룸별 캘린더 ──
const CAL_MAIN = "main@group.calendar.google.com";
const CAL_C = "studio-c@group.calendar.google.com";
const roomA = db().prepare("SELECT id FROM rooms WHERE name = 'Studio A'").get().id;
const roomC = db().prepare("SELECT id FROM rooms WHERE name = 'Studio C'").get().id;

test("updateRoom: 캘린더는 보냈을 때만 바뀐다(미연동이라 select이 안 그려진 저장은 보존)", () => {
  updateRoom(roomC, { room_name: "Studio C", bookable: "1", gcal_calendar_id: CAL_C });
  assert.equal(getRoom(roomC).gcal_calendar_id, CAL_C);
  updateRoom(roomC, { room_name: "Studio C", bookable: "1" }); // 필드 없음
  assert.equal(getRoom(roomC).gcal_calendar_id, CAL_C, "미전송 = 보존");
  bulkUpdateRooms({ [`room_name_${roomC}`]: "Studio C", [`bookable_${roomC}`]: "1" });
  assert.equal(getRoom(roomC).gcal_calendar_id, CAL_C, "통합 저장도 미전송이면 보존");
  bulkUpdateRooms({ [`room_name_${roomC}`]: "Studio C", [`bookable_${roomC}`]: "1", [`gcal_calendar_${roomC}`]: "" });
  assert.equal(getRoom(roomC).gcal_calendar_id, null, "빈 값 = 스튜디오 캘린더로 되돌림");
  updateRoom(roomC, { room_name: "Studio C", bookable: "1", gcal_calendar_id: CAL_C });
});

test("eventInputForSession: 룸 캘린더가 있으면 calendarId, 없으면 null(스튜디오 캘린더)", () => {
  assert.equal(eventInputForSession({ ...base, session_type: "믹싱", room_id: roomC }, project).calendarId, CAL_C);
  assert.equal(eventInputForSession({ ...base, session_type: "녹음", room_id: roomA }, project).calendarId, null);
  assert.equal(eventInputForSession({ ...base, session_type: "녹음" }, project).calendarId, null, "룸 미지정");
});

test("roomsSection: 캘린더 목록이 있을 때만 select, 지정값이 목록에 없어도 보존", () => {
  assert.ok(!/gcal_calendar_/.test(roomsSection()), "목록 없음(미연동) = select 없음 → 저장 시 보존");
  const html = roomsSection([{ id: CAL_MAIN, summary: "OMG Studios" }]);
  assert.match(html, new RegExp(`name="gcal_calendar_${roomA}"`));
  assert.match(html, /\(목록에 없음\)<\/option>/, "Studio C의 CAL_C가 목록에 없어도 selected로 살린다");
});

// ── 구글 API 흐름: 가짜 calendar 클라이언트로 move·patch·delete가 어느 캘린더로 가는지 본다 ──
function fakeGoogle() {
  const calls = [];
  const events = {
    insert: async (a) => { calls.push(["insert", a.calendarId]); return { data: { id: "evt-new" } }; },
    get: async () => ({ data: {} }),
    patch: async (a) => { calls.push(["patch", a.calendarId, a.eventId]); return { data: {} }; },
    move: async (a) => { calls.push(["move", a.calendarId, a.eventId, a.destination]); return { data: {} }; },
    delete: async (a) => { calls.push(["delete", a.calendarId, a.eventId]); return { data: {} }; },
  };
  return { calls, client: { events } };
}

test("syncSessionEvent: 룸을 Studio C로 바꾸면 기존 일정을 C 캘린더로 옮기고, 캘린더를 기록한다", async () => {
  const { config } = require("../src/config");
  const { google } = require("googleapis");
  const { saveRefreshToken } = require("../src/drive");
  const calendar = require("../src/calendar");
  const origConfigured = config.googleConfigured, origCal = google.calendar;
  const fake = fakeGoogle();
  config.googleConfigured = true;
  saveRefreshToken("test-refresh");
  calendar.setStudioCalendarId(CAL_MAIN);
  google.calendar = () => fake.client;
  try {
    const pid = Number(db().prepare("INSERT INTO projects (title, project_type, artist) VALUES ('룸캘린더','session','루나')").run().lastInsertRowid);
    const sid = Number(db().prepare(
      "INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, room_id, gcal_event_id) VALUES (?, '믹싱', '2026-11-02', '14:00', '18:00', '예정', ?, 'evt-1')"
    ).run(pid, roomC).lastInsertRowid);
    const row = () => db().prepare("SELECT * FROM sessions WHERE id = ?").get(sid);

    // 옛 일정(gcal_calendar_id NULL = 스튜디오 캘린더)을 C 룸으로 → move 후 C에서 patch.
    const r1 = await syncSessionEvent(null, row());
    assert.deepEqual(r1, { synced: true });
    assert.deepEqual(fake.calls, [["move", CAL_MAIN, "evt-1", CAL_C], ["patch", CAL_C, "evt-1"]]);
    assert.equal(row().gcal_calendar_id, CAL_C, "옮긴 캘린더를 기록");

    // 같은 캘린더면 move 없이 patch만.
    fake.calls.length = 0;
    await syncSessionEvent(null, row());
    assert.deepEqual(fake.calls, [["patch", CAL_C, "evt-1"]]);

    // Studio A(지정 없음)로 되돌리면 스튜디오 캘린더로 다시 옮긴다.
    fake.calls.length = 0;
    db().prepare("UPDATE sessions SET room_id = ? WHERE id = ?").run(roomA, sid);
    await syncSessionEvent(null, row());
    assert.deepEqual(fake.calls, [["move", CAL_C, "evt-1", CAL_MAIN], ["patch", CAL_MAIN, "evt-1"]]);
    assert.equal(row().gcal_calendar_id, CAL_MAIN);

    // 삭제는 일정이 있는 캘린더에서.
    fake.calls.length = 0;
    await calendar.deleteEvent("evt-9", CAL_C);
    assert.deepEqual(fake.calls, [["delete", CAL_C, "evt-9"]]);
  } finally {
    config.googleConfigured = origConfigured;
    google.calendar = origCal;
  }
});

test("updateEvent: move 실패(404)면 대상 캘린더에 새로 만든다(취소 세션은 안 만든다), 그 외 실패는 null", async () => {
  const { config } = require("../src/config");
  const { google } = require("googleapis");
  const calendar = require("../src/calendar");
  const origConfigured = config.googleConfigured, origCal = google.calendar;
  const fake = fakeGoogle();
  config.googleConfigured = true;
  google.calendar = () => fake.client;
  try {
    const input = { title: "t", date: "2026-11-03", start: "14:00", end: "15:00", calendarId: CAL_C };
    fake.client.events.move = async () => { const e = new Error("gone"); e.code = 404; throw e; };
    assert.equal(await calendar.updateEvent("evt-x", input, CAL_MAIN), "evt-new");
    assert.deepEqual(fake.calls, [["insert", CAL_C]]);
    fake.calls.length = 0;
    assert.equal(await calendar.updateEvent("evt-x", input, CAL_MAIN, { recreate: false }), null, "취소 세션: 지워진 일정은 되살리지 않는다");
    fake.client.events.patch = async () => { const e = new Error("gone"); e.code = 404; throw e; };
    assert.equal(await calendar.updateEvent("evt-x", input, CAL_C, { recreate: false }), null, "같은 캘린더 patch 404도 마찬가지");
    assert.deepEqual(fake.calls, [], "insert 호출 없음");
    fake.client.events.move = async () => { const e = new Error("forbidden"); e.code = 403; throw e; };
    assert.equal(await calendar.updateEvent("evt-x", input, CAL_MAIN), null, "옮기지 못하면 실패로 알린다");
  } finally {
    config.googleConfigured = origConfigured;
    google.calendar = origCal;
  }
});

// ── 참석자 응답 상태(2026-10-22) — {email}만 보내 재동기화마다 전원이 '응답 대기'로 돌아가던 것 ──
test("attendees: 이미 한 응답은 보존, 새 참석자·응답 전은 accepted", async () => {
  const { config } = require("../src/config");
  const { google } = require("googleapis");
  const calendar = require("../src/calendar");
  const origConfigured = config.googleConfigured, origCal = google.calendar;
  const fake = fakeGoogle();
  let sent = null;
  fake.client.events.get = async () => ({ data: { attendees: [
    { email: "A@x.com", responseStatus: "declined" },
    { email: "b@x.com", responseStatus: "needsAction" },
    { email: "gone@x.com", responseStatus: "accepted" },
  ] } });
  fake.client.events.patch = async (a) => { sent = a.requestBody.attendees; return { data: {} }; };
  config.googleConfigured = true;
  google.calendar = () => fake.client;
  try {
    const input = { title: "t", date: "2026-11-03", start: "14:00", end: "15:00", calendarId: CAL_C, attendees: ["a@x.com", "b@x.com", "new@x.com"] };
    assert.equal(await calendar.updateEvent("evt-1", input, CAL_C), "evt-1");
    assert.deepEqual(sent, [
      { email: "a@x.com", responseStatus: "declined" },
      { email: "b@x.com", responseStatus: "accepted" },
      { email: "new@x.com", responseStatus: "accepted" },
    ], "거절은 보존(대소문자 무시)·응답 전은 수락·빠진 사람은 제외");
    assert.deepEqual(calendar.eventBody(input).attendees.map((a) => a.responseStatus), ["accepted", "accepted", "accepted"], "새 일정은 전원 수락");
  } finally {
    config.googleConfigured = origConfigured;
    google.calendar = origCal;
  }
});

test("attendees: 하우스 엔지니어만 자동 수락, 외주·외부는 응답 대기(이미 한 응답은 보존)", () => {
  const { attendeeList } = require("../src/calendar");
  const prev = [{ email: "ext-old@x.com", responseStatus: "declined" }, { email: "house@x.com", responseStatus: "needsAction" }];
  assert.deepEqual(attendeeList(["House@x.com", "ext@x.com", "ext-old@x.com"], prev, ["house@x.com"]), [
    { email: "House@x.com", responseStatus: "accepted" },
    { email: "ext@x.com", responseStatus: "needsAction" },
    { email: "ext-old@x.com", responseStatus: "declined" },
  ]);
});

test("eventInputForSession: autoAccept = user_id 링크된 작업 담당자 이메일(하우스)", () => {
  const D = db();
  const uid = Number(D.prepare("INSERT INTO users (email, role, name) VALUES ('house-login@x.com', 'staff', '하우스A')").run().lastInsertRowid);
  D.prepare("INSERT INTO project_managers (name, email, user_id) VALUES ('하우스A', 'House-A@x.com', ?)").run(uid);
  D.prepare("INSERT INTO project_managers (name, email) VALUES ('외주B', 'ext-b@x.com')").run();
  const auto = eventInputForSession({ ...base, session_type: "녹음" }, project).autoAccept;
  assert.ok(auto.includes("house-a@x.com"), "하우스(소문자)");
  assert.ok(!auto.includes("ext-b@x.com"), "외주 제외");
});

test.after(() => cleanupDb());
