"use strict";

// ── 세션 종류 select 표시 순서 = config.SESSION_TYPES 순서 ──
// 2026-08-05~10-13엔 요금표 분류(환경설정) 순서를 따라갔지만, 개편 4단계에서 요금표를 지우며 config 순서로
// 고정했다(값은 운영에서 보이던 순서에 맞춰 둔다 — docs/redesign/04-cleanup.md §5-2).
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { sessionBookingFields } = require("../src/views.sessions");
const { SESSION_TYPES } = require("../src/config");

function typeOrder(html) {
  const sel = (html.match(/<select[^>]*name="session_type"[\s\S]*?<\/select>/) || [""])[0];
  return [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

test("세션 종류 드롭다운은 config.SESSION_TYPES 순서 그대로, 빠짐없이", () => {
  assert.deepEqual(typeOrder(sessionBookingFields({}, [], [])), SESSION_TYPES);
});
