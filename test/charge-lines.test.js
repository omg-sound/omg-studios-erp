"use strict";

// 요금 산정 + 근거 라인(computeCharge, 2026-07-26).
//
// 규칙은 **1프로 블록 반복**이다(사용자 확정). 홈페이지 computeCharge는 '기본가 + 초과 시간당'이라
// 630분에서 100만이 되는데, 이 ERP는 2026-07-01에 사용자가 '10.5시간 → 90만'으로 리포트해 고친
// 블록 반복 규칙을 지킨다. 2프로 미만은 두 방식이 완전히 같다(그 경계를 여기서 못 박는다).

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const { computeCharge, computeRatePrice } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const SOLO = { name: "솔로 녹음", base_minutes: 210, base_price: 300000, extra_minutes: 60, extra_price: 100000 };
const PKG = { name: "기본 패키지", base_minutes: 600, base_price: 1000000, extra_minutes: 60, extra_price: 100000 };
const FLAT = { name: "플레이백 세션", base_minutes: 0, base_price: 500000, extra_minutes: 60, extra_price: 0 };

const labels = (r) => r.lines.map((l) => l.label);
const total = (item, m) => computeCharge(item, m).total;

test("1프로 이내는 기준가 — 0분·미달도 최소 1프로", () => {
  assert.equal(total(SOLO, 0), 300000);
  assert.equal(total(SOLO, 180), 300000);
  assert.equal(total(SOLO, 210), 300000);
  assert.deepEqual(labels(computeCharge(SOLO, 210)), ["솔로 녹음"], "초과 라인 없음");
});

test("초과는 1시간 단위 올림 — 3시간 31분을 쓰면 1시간 초과다", () => {
  assert.equal(total(SOLO, 211), 400000, "1분만 넘겨도 1시간 과금");
  assert.equal(total(SOLO, 240), 400000);
  assert.equal(total(SOLO, 270), 400000, "정확히 1시간 초과");
  assert.equal(total(SOLO, 271), 500000, "1시간 1분 초과 → 2시간");
  assert.equal(total(SOLO, 300), 500000);
});

test("2프로 이상은 블록 반복(초과 시간당 합산이 아니다)", () => {
  assert.equal(total(SOLO, 420), 600000, "정확히 2프로 = 30만×2 (시간당 방식이면 70만)");
  assert.equal(total(SOLO, 630), 900000, "3프로 = 30만×3 (시간당 방식이면 100만 — 2026-07-01 사용자 리포트 케이스)");
  assert.equal(total(SOLO, 840), 1200000, "4프로");
  assert.equal(total(SOLO, 700), 1100000, "3프로 + 1시간 10분 초과 → 90만 + 20만");
});

test("근거 라인: 기본가 / 초과 시간이 각각 한 줄 — 금액 합 = total", () => {
  const r = computeCharge(SOLO, 700);
  assert.deepEqual(labels(r), ["솔로 녹음", "초과 시간"]);
  assert.equal(r.lines[0].amount, 900000);
  assert.equal(r.lines[0].detail, "기본 3시간 30분 × 3");
  assert.equal(r.lines[1].amount, 200000);
  assert.equal(r.lines[1].detail, "1시간 10분 초과 → 2시간 × ₩100,000");
  assert.equal(r.lines[1].quantity, 2, "invoice_items 스냅샷용 수량 = 초과 시간 수");
  assert.equal(r.lines[1].unit_price, 100000);
  assert.equal(r.lines.reduce((s, l) => s + l.amount, 0), r.total);
});

test("근거 라인: 1프로일 때는 '기본 … 포함', 2프로 이상은 '× N'", () => {
  assert.equal(computeCharge(SOLO, 200).lines[0].detail, "기본 3시간 30분 포함");
  assert.equal(computeCharge(SOLO, 420).lines[0].detail, "기본 3시간 30분 × 2");
});

test("정액(회당) 항목은 시간과 무관 — 초과 라인 없음", () => {
  assert.equal(total(FLAT, 60), 500000);
  assert.equal(total(FLAT, 6000), 500000);
  assert.deepEqual(labels(computeCharge(FLAT, 6000)), ["플레이백 세션"]);
  assert.equal(computeCharge(FLAT, 60).lines[0].detail, "정액(회당)");
});

test("촬영 기본 패키지: 총 10시간 100만, 초과 시간당 10만", () => {
  assert.equal(total(PKG, 600), 1000000, "반입 2h + 촬영 7h + 철수 1h = 정확히 기본");
  assert.equal(total(PKG, 690), 1200000, "1.5h 초과 → 2시간 가산");
});

test("computeRatePrice는 computeCharge.total과 항상 같다(기존 호출부 호환)", () => {
  for (const item of [SOLO, PKG, FLAT]) {
    for (const m of [0, 1, 59, 60, 209, 210, 211, 419, 420, 600, 630, 700, 1000]) {
      assert.equal(computeRatePrice(item, m), computeCharge(item, m).total, `${item.name} ${m}분`);
    }
  }
  assert.equal(computeRatePrice(null, 100), 0, "item 없으면 0");
  assert.deepEqual(computeCharge(null, 100), { lines: [], total: 0 });
});

test("금액 0인 초과·할증 라인은 만들지 않는다(0원 라인이 발행을 막던 회귀)", () => {
  // 기준가만 있고 초과 단가가 0인 항목(createRateItem은 둘 중 하나만 있으면 통과시킨다).
  // 근거를 라인으로 쪼개면서 '2시간 × ₩0'이라는 0원 라인이 생겼고, createInvoiceFromTasks의
  // 0원 가드(TASK_AMOUNT_REQUIRED)가 그걸 잡아 **발행 자체가 막혔다**(쪼개기 전에는 한 줄 30만이라 통과).
  const noExtra = { name: "기준만 있는 항목", base_minutes: 210, base_price: 300000, extra_minutes: 60, extra_price: 0 };
  const r = computeCharge(noExtra, 300);
  assert.deepEqual(labels(r), ["기준만 있는 항목"], "청구할 게 없는 초과 라인은 안 만든다");
  assert.equal(r.total, 300000);
  // 기본가 라인은 0원이어도 남는다 — '금액 미정'(청구 시 입력) 흐름이 이 라인에 걸려 있다.
  const free = { name: "무료 항목", base_minutes: 0, base_price: 0, extra_minutes: 60, extra_price: 0 };
  const r2 = computeCharge(free, 60);
  assert.equal(r2.lines.length, 1);
  assert.equal(r2.lines[0].amount, 0);
});
