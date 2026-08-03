"use strict";

/**
 * Google Calendar 충돌 검사 모듈 — 전용 스튜디오 캘린더 FreeBusy 읽기.
 *
 * 목적: 앱 밖(구글 캘린더에서 직접)에서 잡은 일정과도 세션 예약이 겹치지 않게 막는다.
 *       앱 DB 안의 세션끼리 겹침은 data.findSessionConflict가 담당하고, 여기서는 외부 캘린더를 본다.
 *
 * 설계(Drive와 동일 패턴):
 * - 관리자(치프) OAuth refresh token을 재사용(drive.getRefreshToken), scope 'calendar.readonly' 추가 필요.
 * - 치프가 /settings에서 고른 "스튜디오 캘린더" 하나의 FreeBusy(바쁜 시간대)만 읽는다 → 일정 제목 미열람(프라이버시).
 * - 미연동/권한없음/네트워크 오류는 fail-open(null) — 검사 실패로 예약 자체가 마비되지 않게 한다.
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { getState, setState } = require("./db");
const { oauthClient } = require("./auth");
const { getRefreshToken } = require("./drive"); // Drive와 같은 refresh token 재사용

const STATE_STUDIO_CALENDAR = "studio_calendar_id"; // admin_state에 저장된 스튜디오 캘린더 id
const STATE_STUDIO_LOCATION = "studio_location"; // 예약 일정 기본 장소(관리에서 설정)

function getStudioCalendarId() {
  return getState(STATE_STUDIO_CALENDAR) || null;
}

function setStudioCalendarId(id) {
  setState(STATE_STUDIO_CALENDAR, String(id || "").trim() || null);
}

function getStudioLocation() {
  return getState(STATE_STUDIO_LOCATION) || "";
}

function setStudioLocation(v) {
  setState(STATE_STUDIO_LOCATION, String(v || "").trim() || null);
}

/** refresh token으로 인증된 Calendar 클라이언트. 미연동이면 null. */
function calendarClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.calendar({ version: "v3", auth });
}

/** 치프의 캘린더 목록(스튜디오 캘린더 선택용). 실패 시 []. */
async function listCalendars() {
  const cal = calendarClient();
  if (!cal) return [];
  try {
    const { data } = await cal.calendarList.list({ minAccessRole: "reader", maxResults: 100 });
    return (data.items || []).map((c) => ({ id: c.id, summary: c.summary || c.id, primary: !!c.primary }));
  } catch (_e) {
    return [];
  }
}

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** RFC3339(KST, +09:00) 타임스탬프. date='YYYY-MM-DD', time='HH:MM'. addDay>0이면 날짜를 더한다. */
function rfc3339Kst(date, time, addDay = 0) {
  let d = date;
  if (addDay) {
    const dt = new Date(`${date}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + addDay);
    d = dt.toISOString().slice(0, 10);
  }
  return `${d}T${time}:00+09:00`;
}


/**
 * 일정 시간 본문: 시작·종료 있으면 시간 일정(KST·야간 익일), 없으면 종일(다일이면 endDate까지).
 *
 * 🔒 `clearOpposite`(갱신 경로 전용) — **반대 필드를 명시적으로 null로 지운다.**
 * `events.patch`는 중첩 객체까지 **병합**해서, 종일이던 일정을 시간으로 바꾸며 `start:{dateTime}`만
 * 보내면 구글에 남아 있던 `start.date`와 합쳐져 date·dateTime이 공존하고 **400 Invalid start time**이
 * 난다(2026-08-03 사용자 리포트 — 종일 3일→변경, 종일 1일→시간 둘 다 이 경로였고 fail-safe라
 * 조용히 실패했다). 시간→종일 전환도 같은 이유로 막힌다.
 * 생성(insert)에는 넣지 않는다 — 지울 기존 값이 없고, 불필요한 null은 거부될 여지만 만든다.
 */
function eventTimes(date, start, end, endDate, clearOpposite = false) {
  if (RE_TIME.test(start) && RE_TIME.test(end)) {
    const overnight = end <= start;
    const clear = clearOpposite ? { date: null } : {};
    return {
      start: { dateTime: rfc3339Kst(date, start), timeZone: "Asia/Seoul", ...clear },
      end: { dateTime: rfc3339Kst(date, end, overnight ? 1 : 0), timeZone: "Asia/Seoul", ...clear },
    };
  }
  // 종일: Google end.date는 배타적(마지막 날 다음날). 다일(endDate>date)이면 endDate+1, 단일이면 date+1.
  const last = endDate && String(endDate) > String(date) ? String(endDate) : date;
  const dt = new Date(`${last}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  const clear = clearOpposite ? { dateTime: null, timeZone: null } : {};
  return { start: { date, ...clear }, end: { date: dt.toISOString().slice(0, 10), ...clear } };
}

function eventBody({ title, location, description, date, start, end, endDate, attendees }, clearOpposite = false) {
  const body = Object.assign({ summary: title || "스튜디오 세션" }, eventTimes(date, start, end, endDate, clearOpposite));
  if (location) body.location = location;
  if (description) body.description = description;
  // 참석자(프로젝트 매니저·예약담당자·담당엔지니어 이메일). 초대 메일은 안 보냄(캘린더 이벤트에만 표시) — sendUpdates 미지정(기본 none).
  if (Array.isArray(attendees) && attendees.length) body.attendees = attendees.map((email) => ({ email }));
  return body;
}

// 연동이 안 됐거나 실패한 이유를 로그로 남긴다(연동은 여전히 fail-safe라 예약은 안 막힌다).
// "왜 캘린더로 안 넘어갔나"를 Render 로그에서 바로 확인할 수 있게 하는 진단용.
function skipReason(cal, calId, date) {
  if (!config.googleConfigured) return "googleConfigured=false(OAuth 미설정)";
  if (!getRefreshToken()) return "refresh_token 없음(Drive/Calendar 미연동 — 치프 재로그인 필요)";
  if (!cal) return "calendarClient null";
  if (!calId) return "studio_calendar_id 미선택(/settings 환경설정에서 스튜디오 캘린더 선택 필요)";
  if (!RE_DATE.test(date)) return `날짜 형식 오류(${date})`;
  return "";
}

/** 현재 캘린더 자동연동 준비 상태(설정 수준, 특정 날짜와 무관). { ok, reason }. ok면 세션 저장 시 자동 연동됨. */
function syncStatus() {
  const reason = skipReason(calendarClient(), getStudioCalendarId(), "2999-01-01");
  return { ok: !reason, reason };
}

/** 스튜디오 캘린더에 일정 생성 → event id. 미연동/오류면 null(예약 자체는 막지 않음). */
async function createEvent(input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) {
    console.warn(`[calendar] createEvent 스킵 — ${skipReason(cal, calId, input.date)}`);
    return null;
  }
  try {
    const { data } = await cal.events.insert({ calendarId: calId, requestBody: eventBody(input) });
    return data.id || null;
  } catch (e) {
    console.error(`[calendar] createEvent 실패 — code=${e && e.code} status=${e && e.status} msg=${e && e.message}`);
    return null;
  }
}

/** 기존 일정 수정(시간/제목/장소). 성공 true. 일정이 없으면(404) 새로 만들어 새 id 반환(string). */
async function updateEvent(eventId, input = {}) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !RE_DATE.test(input.date)) {
    console.warn(`[calendar] updateEvent 스킵 — ${skipReason(cal, calId, input.date)}`);
    return null;
  }
  if (!eventId) return createEvent(input); // 연동 후 처음 수정되는 옛 세션 → 새로 생성
  try {
    // clearOpposite=true — patch 병합으로 date/dateTime이 공존하지 않게(종일↔시간 전환, 위 eventTimes 참조).
    await cal.events.patch({ calendarId: calId, eventId, requestBody: eventBody(input, true) });
    return eventId;
  } catch (e) {
    if (e && e.code === 404) return createEvent(input); // 외부에서 지워졌으면 재생성
    // 400이면 시간 형태 충돌일 가능성이 크다(종일↔시간 전환). null로 지우는 방식은 **구글 문서에 명시가 없어**
    // 확증할 수 없으므로, 병합 자체가 없는 update(전체 교체)로 한 번 더 시도한다. 우리는 제목·장소·설명·
    // 참석자·시간을 매번 전부 보내므로 교체해도 잃는 것이 없다(앱→구글 단방향이라 캘린더는 DB의 복제다).
    if (e && e.code === 400) {
      try {
        await cal.events.update({ calendarId: calId, eventId, requestBody: eventBody(input) });
        console.warn(`[calendar] updateEvent patch 400 → update로 복구 — msg=${e && e.message}`);
        return eventId;
      } catch (e2) {
        console.error(`[calendar] updateEvent 실패(update 폴백도) — code=${e2 && e2.code} msg=${e2 && e2.message}`);
        return eventId;
      }
    }
    console.error(`[calendar] updateEvent 실패 — code=${e && e.code} status=${e && e.status} msg=${e && e.message}`);
    return eventId; // 기타 오류는 기존 id 유지(fail-safe)
  }
}

/** 일정 삭제. 미연동/없음/오류는 조용히 무시. */
async function deleteEvent(eventId) {
  const cal = calendarClient();
  const calId = getStudioCalendarId();
  if (!cal || !calId || !eventId) return false;
  try {
    await cal.events.delete({ calendarId: calId, eventId });
    return true;
  } catch (e) {
    if (e && e.code !== 404 && e && e.code !== 410) console.error(`[calendar] deleteEvent 실패 — code=${e && e.code} msg=${e && e.message}`);
    return false;
  }
}

module.exports = {
  STATE_STUDIO_CALENDAR,
  STATE_STUDIO_LOCATION,
  getStudioCalendarId,
  setStudioCalendarId,
  getStudioLocation,
  setStudioLocation,
  calendarClient,
  listCalendars,
  rfc3339Kst,
  eventTimes, // 종일/다일/야간 시간 조립(순수) — 테스트 노출(KST +1일 산술 회귀 잠금)
  eventBody,
  createEvent,
  updateEvent,
  deleteEvent,
  syncStatus,
};
