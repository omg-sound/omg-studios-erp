"use strict";

// ── 세션 종류 select 표시 순서 = 요금표 분류(환경설정) 배치 순서 회귀(2026-08-05 사용자 요청) ──
// 환경설정에서 분류 순서를 바꿔도(사용자가 실제로 겪은 사례: 공연을 촬영/작업 대관보다 위로 올림) 세션 예약
// 폼의 "세션 종류" 드롭다운이 그대로 옛 고정 순서(녹음·촬영 대관·작업 대관·공연…)로 남아 서로 어긋났다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { sessionBookingFields } = require("../src/views.sessions");
const { listRateCategories, moveRateCategory, createRateCategory } = require("../src/data");

function typeOrder(html) {
  const sel = (html.match(/<select[^>]*name="session_type"[\s\S]*?<\/select>/) || [""])[0];
  return [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

test("기본 분류 순서(녹음·촬영·공연) 그대로면 세션 종류도 녹음→촬영 대관→공연 순, 분류 없는 종류는 뒤에", () => {
  const order = typeOrder(sessionBookingFields({}, [], [], []));
  assert.deepEqual(order, ["녹음", "촬영 대관", "공연", "작업 대관", "믹싱", "마스터링", "기타"]);
});

test("환경설정에서 분류 순서를 바꾸면(공연을 맨 위로) 세션 종류 순서도 그대로 따라간다", () => {
  const perf = listRateCategories().find((c) => c.kind === "performance");
  for (let i = 0; i < 3; i++) moveRateCategory(perf.id, "up"); // 맨 아래(4번째)에서 맨 위로
  const order = typeOrder(sessionBookingFields({}, [], [], []));
  assert.deepEqual(order.slice(0, 2), ["공연", "녹음"], "공연이 녹음보다 먼저 나온다");
  assert.ok(order.includes("촬영 대관") && order.includes("작업 대관"), "나머지 종류도 여전히 전부 있다");
  assert.strictEqual(order.length, 7, "종류 7개는 그대로 — 순서만 바뀐다");
});

test("작업 대관처럼 분류가 새로 생기면 그 분류 위치를 따라 세션 종류 순서에 편입된다", () => {
  createRateCategory({ name: "작업실 대관", kind: "workspace" });
  // 방금 만든 분류는 맨 끝(가장 큰 sort_order)이라 목록 맨 뒤 — '작업 대관'이 뒤에서 두 번째 이상으로 앞당겨진다.
  const order = typeOrder(sessionBookingFields({}, [], [], []));
  assert.ok(order.indexOf("작업 대관") < order.indexOf("믹싱"), "새 분류가 생기면 그 즉시 믹싱보다 앞으로 온다");
});
