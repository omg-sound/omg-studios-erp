"use strict";

// 단가 항목 관리 — 가격 유형·표시 순서(↑↓)·활성 토글(2026-07-26).
//
// 이전 상태: 정렬이 이름 가나다순 강제라 순서를 못 바꿨고(바로 옆 rate_categories·task_types에는 ↑↓가 있어
// 일관성이 깨져 있었다), active 컬럼은 있는데 라우트·UI가 없어 한 번 비활성이 되면 되살릴 방법이 없었다.

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { init, db } = require("../src/db");
const {
  listRateItems,
  getRateItem,
  createRateItem,
  updateRateItem,
  setRateItemActive,
  moveRateItem,
  deleteRateItem,
  listTaskTypes,
  createTaskType,
  updateTaskType,
} = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

const inCat = (cat) => listRateItems({ includeInactive: true }).filter((r) => r.category === cat).map((r) => r.name);

test("가격 유형: 기본은 고정, 모르는 값도 고정으로 정규화", () => {
  const a = createRateItem({ rate_name: "유형 테스트 A", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000" });
  assert.equal(a.price_type, "fixed", "미지정이면 고정");
  const b = updateRateItem(a.id, { rate_name: "유형 테스트 A", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000", price_type: "minimum" });
  assert.equal(b.price_type, "minimum");
  const c = updateRateItem(a.id, { rate_name: "유형 테스트 A", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000", price_type: "무엄한값" });
  assert.equal(c.price_type, "fixed", "허용 밖 값은 고정으로");
  deleteRateItem(a.id);
});

test("정렬: 이름 가나다순이 아니라 sort_order를 따른다", () => {
  // 마이그레이션이 솔로 녹음(10) → 드럼 · 합주 녹음(20)으로 순서를 줬다. 가나다순이면 '드럼'이 앞이다.
  const names = inCat("스튜디오 녹음");
  assert.deepEqual(names, ["솔로 녹음", "드럼 · 합주 녹음"], "sort_order 우선(가나다순이면 순서가 뒤집힌다)");
});

test("새 항목은 분류 맨 뒤에 붙는다(기존 순서를 밀지 않게)", () => {
  const z = createRateItem({ rate_name: "가가가 신규", category: "스튜디오 녹음", base_hours: "3.5", base_price: "100000" });
  assert.equal(inCat("스튜디오 녹음").at(-1), "가가가 신규", "이름이 가나다순 맨 앞이어도 맨 뒤");
  deleteRateItem(z.id);
});

test("순서 이동: 같은 분류 안에서 이웃과 교환, 경계에서는 무동작", () => {
  const solo = listRateItems({ includeInactive: true }).find((r) => r.name === "솔로 녹음");
  const drum = listRateItems({ includeInactive: true }).find((r) => r.name === "드럼 · 합주 녹음");
  moveRateItem(drum.id, "up");
  assert.deepEqual(inCat("스튜디오 녹음"), ["드럼 · 합주 녹음", "솔로 녹음"]);
  moveRateItem(drum.id, "up"); // 이미 첫 항목 → 무동작
  assert.deepEqual(inCat("스튜디오 녹음"), ["드럼 · 합주 녹음", "솔로 녹음"]);
  moveRateItem(drum.id, "down"); // 원복
  assert.deepEqual(inCat("스튜디오 녹음"), ["솔로 녹음", "드럼 · 합주 녹음"]);
  assert.ok(solo && drum);
});

test("순서 이동은 분류 경계를 넘지 않는다(촬영 항목이 녹음으로 섞이지 않게)", () => {
  const pkg = createRateItem({ rate_name: "촬영 항목", category: "스튜디오 촬영", base_hours: "10", base_price: "1000000" });
  moveRateItem(pkg.id, "up");
  assert.equal(getRateItem(pkg.id).category, "스튜디오 촬영", "이동 후에도 분류 불변");
  assert.ok(!inCat("스튜디오 녹음").includes("촬영 항목"));
  deleteRateItem(pkg.id);
});

test("활성 토글: 비활성 → 다시 활성으로 되살릴 수 있다", () => {
  const solo = listRateItems({ includeInactive: true }).find((r) => r.name === "솔로 녹음");
  setRateItemActive(solo.id, false);
  assert.equal(getRateItem(solo.id).active, 0);
  assert.ok(!listRateItems().some((r) => r.id === solo.id), "세션 폼 목록(활성만)에서 빠진다");
  assert.ok(listRateItems({ includeInactive: true }).some((r) => r.id === solo.id), "관리 목록에는 남아 되살릴 수 있다");
  setRateItemActive(solo.id, true);
  assert.equal(getRateItem(solo.id).active, 1);
  assert.ok(listRateItems().some((r) => r.id === solo.id));
});

test("작업 종류(포스트)도 가격 유형을 갖는다 — 믹싱=기준가·보컬튠=최소가", () => {
  const byKey = (k) => listTaskTypes({ includeInactive: true }).find((t) => t.key === k);
  assert.equal(byKey("Mixing").price_type, "base");
  assert.equal(byKey("Vocal_Tuning").price_type, "minimum");
  // 편집으로 바꿀 수 있고 캐시도 갱신된다(라벨·단가 캐시와 같은 경로).
  updateTaskType(byKey("Mixing").id, { label: "믹싱", billing_type: "Fixed_Per_Track", unit_price: "1000000", price_type: "minimum", is_quick: "1" });
  assert.equal(byKey("Mixing").price_type, "minimum");
  updateTaskType(byKey("Mixing").id, { label: "믹싱", billing_type: "Fixed_Per_Track", unit_price: "1000000", price_type: "base", is_quick: "1" });
  assert.equal(byKey("Mixing").price_type, "base");
  // 신규 종류도 유형을 받는다.
  createTaskType({ label: "임시 작업", billing_type: "Fixed_Per_Track", unit_price: "50000", price_type: "base" });
  const made = listTaskTypes({ includeInactive: true }).find((t) => t.label === "임시 작업");
  assert.equal(made.price_type, "base");
  db().prepare("DELETE FROM task_types WHERE id = ?").run(made.id);
});
