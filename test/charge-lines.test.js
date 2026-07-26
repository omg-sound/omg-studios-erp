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
const { computeCharge, computeRatePrice, getSurcharge, listSurcharges } = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const SOLO = { name: "솔로 녹음", base_minutes: 210, base_price: 300000, extra_minutes: 60, extra_price: 100000 };
const PKG = { name: "기본 패키지", base_minutes: 600, base_price: 1000000, extra_minutes: 60, extra_price: 100000 };
const FLAT = { name: "플레이백 세션", base_minutes: 0, base_price: 500000, extra_minutes: 60, extra_price: 0 };

const labels = (r) => r.lines.map((l) => l.label);
const total = (item, m, opt) => computeCharge(item, m, opt).total;

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

test("미장센 할증: 대관비의 50%가 기본가에 붙는다(100만 → 150만)", () => {
  const s = getSurcharge("mise_en_scene");
  assert.ok(s, "할증 마스터 없음");
  const r = computeCharge(PKG, 600, { surcharge: s });
  assert.deepEqual(labels(r), ["기본 패키지", "미장센 할증"]);
  assert.equal(r.total, 1500000);
  assert.equal(r.lines[1].amount, 500000);
  assert.equal(r.lines[1].detail, "기본가의 50%");
});

test("할증은 초과분이 아니라 기본가에만 붙는다", () => {
  const s = getSurcharge("mise_en_scene");
  const r = computeCharge(PKG, 690, { surcharge: s });
  assert.equal(r.total, 1700000, "100만 + 초과 20만 + 할증 50만(초과분에는 안 붙음)");
  assert.equal(r.lines.find((l) => l.label === "미장센 할증").amount, 500000);
});

test("할증 요율은 코드가 아니라 마스터 테이블에서 온다", () => {
  db().prepare("UPDATE surcharges SET rate = 0.3 WHERE key = 'mise_en_scene'").run();
  assert.equal(computeCharge(PKG, 600, { surcharge: getSurcharge("mise_en_scene") }).total, 1300000);
  db().prepare("UPDATE surcharges SET rate = 0.5 WHERE key = 'mise_en_scene'").run();
  // 비활성 할증은 조회되지 않는다(적용 안 됨).
  db().prepare("UPDATE surcharges SET active = 0 WHERE key = 'mise_en_scene'").run();
  assert.equal(getSurcharge("mise_en_scene"), null);
  db().prepare("UPDATE surcharges SET active = 1 WHERE key = 'mise_en_scene'").run();
});

test("할증 목록은 적용 대상(kind)으로 걸러진다", () => {
  assert.ok(listSurcharges({ appliesTo: "filming" }).some((s) => s.key === "mise_en_scene"));
  assert.ok(!listSurcharges({ appliesTo: "recording" }).some((s) => s.key === "mise_en_scene"), "녹음에는 미장센 할증이 없다");
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
