"use strict";

/**
 * 단가표(과금 항목) 도메인 — 녹음 종류(rate_items). 스튜디오/로케이션 분류.
 * 녹음 세션 1Pro(기준시간) 블록 산정(computeRatePrice). 치프가 관리 메뉴에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 */

const { db } = require("../db");
const { listRateCategories } = require("./rate-categories"); // 무순환(rate-categories는 rate-items를 require하지 않음)
const { normalizePriceType } = require("../config");
const { parseMoney } = require("../lib/forms");

const parseWon = parseMoney; // 내부 호출명 parseWon 유지(data.js와 동일 별칭)

/** 시간(소수, "3.5") → 분. 빈 값/0 이하면 0. */
function parseHoursToMinutes(v) {
  const n = Number(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
}

/** 분류 검증 — DB(rate_categories)에 등록된 이름만 허용, 아니면 첫 분류로 폴백(2026-07-05, config 하드코딩에서 전환). */
function normalizeCategory(v) {
  const names = listRateCategories().map((c) => c.name);
  const s = String(v || "").trim();
  return names.includes(s) ? s : names[0] || "";
}

function rateFields(input) {
  return {
    name: String(input.rate_name != null ? input.rate_name : input.name || "").trim(), // 폼 필드=rate_name(Chrome이 name= 필드에 사람이름 자동완성을 강제 — 함정 #19)
    category: normalizeCategory(input.category),
    base_minutes: parseHoursToMinutes(input.base_hours),
    base_price: parseWon(input.base_price),
    extra_minutes: parseHoursToMinutes(input.extra_hours) || 60,
    extra_price: parseWon(input.extra_price),
    // 가격 유형(2026-07-26) — 청구 화면이 금액칸을 잠글지 결정한다.
    // fixed=기본가 잠금(초과 시간만 자동 가산) · base=기준가 자동 입력 후 수정 가능 · minimum=최소가 자동 입력 후 상향.
    price_type: normalizePriceType(input.price_type),
  };
}

/**
 * 단가 항목 목록. 정렬은 **분류 안 표시 순서**(sort_order → 이름) — 이전엔 이름 가나다순 강제라
 * 순서를 바꿀 수 없었다(바로 옆 rate_categories·task_types에는 ↑↓가 있어 일관성이 깨져 있었다).
 */
function listRateItems({ includeInactive = false } = {}) {
  return db()
    .prepare(
      `SELECT * FROM rate_items
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE`
    )
    .all();
}

function createRateItem(input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  // 시간제(기준 시간 있음)는 가격 필수. 정액(기준 시간 0=회당)은 가격 0 허용 — '금액 미정' 항목(예: 플레이백 세션), 청구 시 금액 입력(2026-07-04 사용자 결정).
  if (f.base_minutes > 0 && !f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED");
  const info = db()
    .prepare(
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, price_type, sort_order, active)
       VALUES (@name,@category,@base_minutes,@base_price,@extra_minutes,@extra_price,@price_type,900,1)`
    )
    .run(f); // 새 항목은 분류 맨 뒤(이후 ↑↓로 이동)
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(info.lastInsertRowid);
}

function updateRateItem(id, input = {}) {
  const f = rateFields(input);
  if (!f.name) throw new Error("RATE_NAME_REQUIRED");
  // 시간제(기준 시간 있음)는 가격 필수. 정액(기준 시간 0=회당)은 가격 0 허용 — '금액 미정' 항목(예: 플레이백 세션), 청구 시 금액 입력(2026-07-04 사용자 결정).
  if (f.base_minutes > 0 && !f.base_price && !f.extra_price) throw new Error("RATE_PRICE_REQUIRED");
  db()
    .prepare(
      `UPDATE rate_items SET name=@name, category=@category, base_minutes=@base_minutes, base_price=@base_price,
       extra_minutes=@extra_minutes, extra_price=@extra_price, price_type=@price_type WHERE id=@id`
    )
    .run({ id, ...f });
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id);
}

/**
 * 활성/비활성 토글(2026-07-26) — active 컬럼은 처음부터 있었는데 UI·라우트가 없어서
 * 한 번 비활성이 되면 되살릴 방법이 없었다(세션 폼 옵션에서 사라지고 관리 화면에서도 손댈 수 없었다).
 * 비활성 항목은 세션 폼 단가 select에서 빠지지만 그 항목으로 발행된 청구서는 스냅샷이라 그대로 남는다.
 */
function setRateItemActive(id, active) {
  db().prepare("UPDATE rate_items SET active = ? WHERE id = ?").run(active ? 1 : 0, Number(id));
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(Number(id)) || null;
}

/**
 * 표시 순서 이동(**같은 분류 안에서** 위/아래 한 칸) — moveRateCategory/moveTaskType과 같은 방식.
 * 현재 표시 순서를 물질화해 이웃과 교환하고 sort_order를 10 간격 재부여(기본값 중복 상태에서도 결정적).
 * 분류 경계를 넘지 않는다 — 관리 화면이 분류별 접이식 목록이라 분류를 넘는 이동은 화면에서 사라지는 것처럼 보인다.
 */
function moveRateItem(id, dir) {
  const cur = db().prepare("SELECT * FROM rate_items WHERE id = ?").get(Number(id));
  if (!cur) return;
  const rows = db()
    .prepare("SELECT id FROM rate_items WHERE category = ? ORDER BY active DESC, sort_order ASC, name COLLATE NOCASE")
    .all(cur.category);
  const i = rows.findIndex((r) => r.id === cur.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const upd = db().prepare("UPDATE rate_items SET sort_order = ? WHERE id = ?");
  rows.forEach((r, idx) => upd.run((idx + 1) * 10, r.id));
}

function deleteRateItem(id) {
  db().prepare("DELETE FROM rate_items WHERE id = ?").run(id);
}

/** id로 단가 항목 1건(없으면 null) — 캘린더 이벤트 종류 표기 등. */
function getRateItem(id) {
  if (!id) return null;
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id) || null;
}

/**
 * 진행 분(minutes)에 대한 자동 산정 금액(3단계에서 사용).
 * - 기준 시간 이내 → 기준가. 초과분은 초과 단위(분)로 올림하여 단위당 과금.
 * - base_minutes=0이면 시간 무관 정액(base_price).
 */
function computeRatePrice(item, minutes) {
  if (!item) return 0;
  const m = Math.max(0, Number(minutes) || 0);
  const baseMin = item.base_minutes;
  // 정액(base_minutes=0) 또는 1Pro(기준시간) 이내 → 기본가.
  if (baseMin <= 0 || m <= baseMin) return item.base_price;
  // 기준시간(1Pro)마다 묶어서 계산: 완전한 Pro 블록은 각각 기본가(base_price),
  // 마지막 1Pro 미만 자투리만 추가요금(extra_minutes 단위 올림)으로 과금.
  // 예) 1Pro=210분·30만 / 초과 60분·10만 → 630분(3Pro)=90만, 240분=1Pro+30분=40만.
  const fullPros = Math.floor(m / baseMin);
  const remainder = m - fullPros * baseMin;
  let price = fullPros * item.base_price;
  if (remainder > 0) {
    const unit = item.extra_minutes > 0 ? item.extra_minutes : 60;
    price += Math.ceil(remainder / unit) * item.extra_price;
  }
  return price;
}

module.exports = {
  listRateItems,
  getRateItem,
  createRateItem,
  updateRateItem,
  setRateItemActive,
  moveRateItem,
  deleteRateItem,
  computeRatePrice,
};
