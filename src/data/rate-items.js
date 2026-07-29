"use strict";

/**
 * 단가표(과금 항목) 도메인 — 녹음 종류(rate_items). 스튜디오/로케이션 분류.
 * 녹음 세션 1Pro(기준시간) 블록 산정(computeRatePrice). 치프가 관리 메뉴에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 */

const { db } = require("../db");
const { listRateCategories } = require("./rate-categories"); // 무순환(rate-categories는 rate-items를 require하지 않음)
const { parseMoney } = require("../lib/forms");
const { durationKo } = require("../lib/date");

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
      `INSERT INTO rate_items (name, category, base_minutes, base_price, extra_minutes, extra_price, sort_order, active)
       VALUES (@name,@category,@base_minutes,@base_price,@extra_minutes,@extra_price,900,1)`
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
       extra_minutes=@extra_minutes, extra_price=@extra_price WHERE id=@id`
    )
    .run({ id, ...f });
  return db().prepare("SELECT * FROM rate_items WHERE id = ?").get(id);
}

/**
 * 통합 저장(2026-07-27 인라인 편집): body의 `<필드>_<id>` 묶음을 행별로 모아 한 트랜잭션으로 갱신.
 * 행 판별은 DB 기준(rate_name_<id> 존재 시 참여) — 임의 id 주입은 자연 무시.
 * 검증은 2단 구조다 — 이름 입력은 `required`라 정상 브라우저에서는 한 행이라도 비면 제출 자체가 막힌다.
 * 여기의 이름·가격 누락 skip은 JS-off·직접 제출 등 required를 우회한 경우를 위한 안전망(단건 저장과 같은 의미론).
 * 그 외 오류는 롤백 후 재던짐.
 */
function bulkUpdateRateItems(body = {}) {
  const d = db();
  const ids = d.prepare("SELECT id FROM rate_items").all().map((r) => r.id);
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of ids) {
      if (body[`rate_name_${id}`] == null) continue;
      const input = {
        rate_name: body[`rate_name_${id}`],
        category: body[`category_${id}`],
        base_hours: body[`base_hours_${id}`],
        base_price: body[`base_price_${id}`],
        extra_hours: body[`extra_hours_${id}`],
        extra_price: body[`extra_price_${id}`],
      };
      try { updateRateItem(id, input); updated++; }
      catch (e) { if (!["RATE_NAME_REQUIRED", "RATE_PRICE_REQUIRED"].includes(e.message)) throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
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
 * 요금 산정 + **근거 라인**(2026-07-26). 홈페이지 pricing.ts computeCharge를 이식하되
 * 초과 규칙은 이 ERP의 1Pro 블록 반복을 유지한다(사용자 확정) — 두 구현이 7시간부터 갈렸다:
 * 630분(3Pro)은 블록 반복이면 90만, '기본가 + 초과 시간당'이면 100만이다. 2026-07-01에
 * 사용자가 '10.5시간 → 90만'으로 리포트해 고친 규칙이라 그쪽을 지킨다(2Pro 미만은 두 방식이 동일).
 *
 * 근거를 한 줄로 뭉치지 않고 라인으로 쪼개 돌려준다 — 청구서에서 "왜 이 금액인지"를 고객이 따라올 수 있어야 한다.
 * `lines[i] = { label, amount, detail, quantity, unit_price }` (뒤 두 개는 invoice_items 스냅샷용).
 * (할증 개념은 2026-07-27 폐기 — 미장센은 별도 단가 항목으로 표현한다.)
 *
 * @param minutes 실사용 분. 촬영이면 반입·설치 + 촬영 + 철수를 **합친** 값.
 */
function computeCharge(item, minutes) {
  if (!item) return { lines: [], total: 0 };
  const m = Math.max(0, Number(minutes) || 0);
  const baseMin = item.base_minutes;
  const lines = [];

  if (baseMin <= 0) {
    // 정액(회당) — 시간과 무관. 가격까지 비어 있으면 '금액 미정'(청구 시 입력).
    lines.push({ label: item.name, amount: item.base_price, detail: "정액(회당)", quantity: 1, unit_price: item.base_price });
  } else {
    // 완전한 1Pro 블록마다 기준가. 0분·기준시간 미만도 최소 1Pro로 본다(종전 computeRatePrice와 동일).
    const fullPros = Math.max(1, Math.floor(m / baseMin));
    const remainder = m <= baseMin ? 0 : m - fullPros * baseMin;
    lines.push({
      label: item.name,
      amount: fullPros * item.base_price,
      detail: fullPros > 1 ? `기본 ${durationKo(baseMin)} × ${fullPros}` : `기본 ${durationKo(baseMin)} 포함`,
      quantity: fullPros,
      unit_price: item.base_price,
    });
    if (remainder > 0) {
      const unit = item.extra_minutes > 0 ? item.extra_minutes : 60;
      const n = Math.ceil(remainder / unit); // 3시간 31분을 썼으면 1시간 초과다 — 분 단위로 깎아 주지 않는다.
      const unitLabel = unit === 60 ? "시간" : `${durationKo(unit)}`;
      const extra = n * item.extra_price;
      // ⚠️ 0원 라인은 만들지 않는다 — 초과 단가가 0인 항목(기준가만 설정)에서 '2시간 × ₩0' 같은 무의미한
      // 근거가 생기고, 그 0원 라인이 createInvoiceFromTasks의 0원 가드(TASK_AMOUNT_REQUIRED)에 걸려
      // **발행 자체가 막힌다**(근거를 쪼개기 전에는 한 줄이라 통과했다). 기본가 라인은 0이어도 남긴다 —
      // '금액 미정'(청구 시 입력) 흐름이 그 라인에 걸려 있다.
      if (extra > 0) {
        lines.push({
          label: "초과 시간",
          amount: extra,
          detail: `${durationKo(remainder)} 초과 → ${n}${unitLabel} × ${wonText(item.extra_price)}`,
          quantity: n,
          unit_price: item.extra_price,
        });
      }
    }
  }

  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

/**
 * 진행 분(minutes)에 대한 자동 산정 금액(합계만).
 * computeCharge의 total과 **항상 같다**(같은 구현 — 근거 라인이 필요 없는 호출부용 얇은 래퍼).
 */
function computeRatePrice(item, minutes) {
  return computeCharge(item, minutes).total;
}

/** 근거 문구용 금액 표기(₩1,200,000). 뷰의 formatKRW과 같은 형식이지만 데이터 계층이 views를 참조하지 않게 별도. */
function wonText(n) {
  return "₩" + Math.round(Number(n) || 0).toLocaleString("ko-KR");
}

module.exports = {
  listRateItems,
  getRateItem,
  createRateItem,
  updateRateItem,
  bulkUpdateRateItems,
  setRateItemActive,
  moveRateItem,
  deleteRateItem,
  computeRatePrice,
  computeCharge,
};
