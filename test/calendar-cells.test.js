"use strict";

// ── calendarMonthCells 회귀 잠금(2026-07-21 구글식 앞뒤 달 넘침) ──
// 뷰(monthCalendar)와 데이터(sessionsForCalendar)가 이 하나를 공유하므로, 격자 셀 목록이 곧 세션 조회 범위다.
// 여기가 어긋나면 이웃 달 세션이 조회는 됐는데 셀이 없거나(유령), 셀은 있는데 세션이 안 잡힌다.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { calendarMonthCells } = require("../src/lib/date");

test("항상 완전한 주(7칸 배수)로 채운다", () => {
  for (const ym of ["2026-01", "2026-02", "2026-07", "2026-08", "2028-02"]) {
    const cells = calendarMonthCells(ym);
    assert.equal(cells.length % 7, 0, `${ym}: 7칸 배수`);
    assert.ok(cells.length === 35 || cells.length === 42 || cells.length === 28, `${ym}: 4~6주(${cells.length})`);
  }
});

test("첫 셀은 일요일(앞 달 넘침), 마지막 셀은 토요일(뒷 달 넘침)", () => {
  // 2026-07: 1일이 수요일 → 앞에 6/28·29·30, 끝에 8/1
  const c = calendarMonthCells("2026-07");
  assert.equal(c[0].ymd, "2026-06-28", "첫 셀 = 이전 달 말일들의 시작(일요일)");
  assert.equal(c[0].inMonth, false);
  assert.equal(c[c.length - 1].ymd, "2026-08-01", "마지막 셀 = 다음 달 초(토요일)");
  assert.equal(c[c.length - 1].inMonth, false);
  // 이번 달 1일~31일은 정확히 inMonth=true, 그 수는 31
  assert.equal(c.filter((x) => x.inMonth).length, 31, "7월 = 31일");
});

test("inMonth 경계 — 이번 달 첫날/말일만 참", () => {
  const c = calendarMonthCells("2026-08"); // 8/1=토요일 → 앞 넘침 6칸, 6주
  const inMonth = c.filter((x) => x.inMonth);
  assert.equal(inMonth[0].ymd, "2026-08-01");
  assert.equal(inMonth[0].day, 1);
  assert.equal(inMonth[inMonth.length - 1].ymd, "2026-08-31");
  assert.equal(inMonth.length, 31);
  // 앞 넘침은 7월, 뒤 넘침은 9월
  assert.ok(c[0].ymd.startsWith("2026-07"), "앞 넘침 = 7월");
  assert.ok(c[c.length - 1].ymd.startsWith("2026-09"), "뒤 넘침 = 9월");
});

test("연말 경계 — 12월은 다음 해 1월로 넘친다", () => {
  const c = calendarMonthCells("2026-12"); // 12/1=화 → 앞 6/29·11/30, 끝 1월
  assert.ok(c[c.length - 1].ymd.startsWith("2027-01"), "12월 뒤 넘침 = 이듬해 1월");
  assert.equal(c.filter((x) => x.inMonth && x.ymd.startsWith("2026-12")).length, 31);
});

test("연속·중복 없는 날짜(하루씩 증가)", () => {
  const c = calendarMonthCells("2026-07");
  for (let i = 1; i < c.length; i++) {
    const prev = new Date(c[i - 1].ymd + "T00:00:00Z").getTime();
    const cur = new Date(c[i].ymd + "T00:00:00Z").getTime();
    assert.equal(cur - prev, 86400000, `${c[i - 1].ymd} → ${c[i].ymd} 하루 차이`);
  }
});

// ── 다일 종일 일정은 덮는 칸 전부에 놓인다(2026-08-03 사용자 리포트 '3일짜리가 하루로만 뜬다') ──
// 시작 칸에만 넣으면 이틀째부터 캘린더가 비어 보여, 서베이 화면의 목적(언제 뭐가 잡혀 있나)이 깨진다.
const { monthCalendar } = require("../src/views.sessions");

const sess = (extra) => ({
  id: 7, project_id: 3, session_type: "녹음", status: "예정", project_title: "루나 1집", artist: "루나",
  session_date: "2026-02-05", start_time: null, end_time: null, all_day: 1, end_date: null, billing: null, ...extra,
});

test("monthCalendar: 종일 3일(2/5~2/7) → 세 칸에 모두 칩", () => {
  const html = monthCalendar("2026-02", [sess({ end_date: "2026-02-07" })]);
  const chips = (html.match(/data-session-card="\/sessions\/7\/card"/g) || []).length;
  assert.equal(chips, 3, `2/5·2/6·2/7 세 칸(실제 ${chips})`);
  assert.match(html, /2월 5일~2월 7일/, "칸만 봐선 어디까지인지 모르니 기간을 툴팁에");
});

test("monthCalendar: 단일 종일·시간 세션은 한 칸만(과잉 확산 방지)", () => {
  assert.equal((monthCalendar("2026-02", [sess({})]).match(/\/sessions\/7\/card/g) || []).length, 1, "단일 종일");
  // 야간(자정 넘김)도 하루 일과라 시작일 한 칸 — 이틀에 걸쳐 그리면 오히려 길어 보인다.
  const night = sess({ all_day: 0, start_time: "22:00", end_time: "02:00", end_date: null });
  assert.equal((monthCalendar("2026-02", [night]).match(/\/sessions\/7\/card/g) || []).length, 1, "야간 시간 세션");
});

test("monthCalendar: end_date가 시작보다 앞이면(비정상) 한 칸으로 폴백", () => {
  const bad = sess({ end_date: "2026-02-01" });
  assert.equal((monthCalendar("2026-02", [bad]).match(/\/sessions\/7\/card/g) || []).length, 1);
});
