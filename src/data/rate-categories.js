"use strict";

/**
 * 단가표 분류(rate_categories) 도메인 — 2026-07-05 신설.
 * config의 RECORDING/FILMING/PERFORMANCE_CATEGORIES는 1회 시드 데이터일 뿐(db.js seedDefaultCatalogs),
 * 이후 이 테이블이 단일 진실원천이다.
 *
 * 🔓 **기본 분류도 수정·삭제할 수 있다**(2026-07-29 사용자 요청). 원래 시드된 4개는 locked=1로 잠겨 있었고
 * 근거는 '세션 종류↔kind 매핑 등 코드가 이름에 의존'이었는데, 실제로 확인해 보니 **이름에 의존하는 코드가
 * 없다**: kind는 이 테이블을 조회해 얻고(`rateCategoryKind`), 이름을 바꾸면 참조 중인 `rate_items.category`도
 * 함께 갱신되며, 시드는 마이그레이션 게이트라 지워도 되살아나지 않는다. config 상수는 시드 값일 뿐이다.
 * 남는 안전망은 **사용 중이면 삭제 거부**(CATEGORY_IN_USE) 하나 — 그건 기본이든 아니든 똑같이 적용된다.
 * `locked` 컬럼은 스키마에 남아 있으나 읽는 코드가 없다(레거시).
 */

const { db } = require("../db");

const KINDS = ["recording", "filming", "performance"]; // ⚠️배열 순서가 곧 화면 표시 순서다(녹음 → 촬영 → 공연).

// 종류 정렬 순위 — 예전엔 `ORDER BY kind`(문자열)이라 **filming < performance < recording** 알파벳순으로
// 촬영·공연이 녹음보다 위에 고정됐다(2026-07-29 사용자 리포트 '녹음을 위로 못 옮긴다'). ↑↓는 같은 종류
// 안에서만 자리를 바꾸므로 사용자가 손댈 방법이 아예 없었다. 게다가 분류 select만 다른 순서(녹음 먼저)를
// 써서 화면마다 순서가 달랐다 — 여기서 한 번 정해 전 화면이 같은 순서를 쓰게 한다.
const KIND_RANK = KINDS.map((k, i) => `WHEN '${k}' THEN ${i}`).join(" ");

/** 전체 분류(종류[녹음→촬영→공연] → sort_order → 이름순). 세션 폼·관리 화면 공용. */
function listRateCategories() {
  return db().prepare(`SELECT * FROM rate_categories ORDER BY CASE kind ${KIND_RANK} ELSE 99 END, sort_order, name COLLATE NOCASE`).all();
}

function getRateCategory(id) {
  return db().prepare("SELECT * FROM rate_categories WHERE id = ?").get(Number(id)) || null;
}

/** 분류명 → kind(recording|filming|performance). 등록 안 된 이름은 recording으로 폴백(레거시 데이터 방어). */
function rateCategoryKind(name) {
  const row = db().prepare("SELECT kind FROM rate_categories WHERE name = ?").get(String(name || ""));
  return row ? row.kind : "recording";
}

function createRateCategory({ name, kind } = {}) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("CATEGORY_NAME_REQUIRED");
  const k = KINDS.includes(kind) ? kind : "recording";
  const info = db().prepare("INSERT INTO rate_categories (name, kind, locked, sort_order) VALUES (?, ?, 0, 999)").run(nm, k);
  return getRateCategory(info.lastInsertRowid);
}

/** 이름을 바꾸면 그 이름을 참조 중인 rate_items.category도 함께 갱신(텍스트 컬럼이라 끊어지지 않게). */
function updateRateCategory(id, { name, kind } = {}) {
  const cat = getRateCategory(id);
  if (!cat) return null;
  const nm = String(name || "").trim();
  if (!nm) throw new Error("CATEGORY_NAME_REQUIRED");
  const k = KINDS.includes(kind) ? kind : cat.kind;
  db().prepare("UPDATE rate_categories SET name = ?, kind = ? WHERE id = ?").run(nm, k, cat.id);
  if (nm !== cat.name) db().prepare("UPDATE rate_items SET category = ? WHERE category = ?").run(nm, cat.name);
  return getRateCategory(id);
}

/** 사용 중인(rate_items가 참조하는) 분류는 삭제 거부 — 오연결/유령 분류 방지. */
function deleteRateCategory(id) {
  const cat = getRateCategory(id);
  if (!cat) return null;
  const inUse = db().prepare("SELECT COUNT(*) AS n FROM rate_items WHERE category = ?").get(cat.name).n;
  if (inUse > 0) throw new Error("CATEGORY_IN_USE");
  db().prepare("DELETE FROM rate_categories WHERE id = ?").run(cat.id);
  return { id: cat.id };
}

/**
 * 분류 순서 이동(같은 kind 안에서 위/아래 한 칸, 2026-07-09 관리 개선 — 정렬 UI).
 * 현재 표시 순서(kind→sort_order→이름)를 물질화해 이웃과 자리를 바꾸고 sort_order를 10 간격으로 재부여
 * (999 기본값 중복 상태에서도 결정적으로 동작).
 */
function moveRateCategory(id, dir) {
  const cur = db().prepare("SELECT * FROM rate_categories WHERE id = ?").get(Number(id));
  if (!cur) return;
  const rows = db().prepare("SELECT id FROM rate_categories WHERE kind = ? ORDER BY sort_order, name COLLATE NOCASE").all(cur.kind);
  const i = rows.findIndex((r) => r.id === cur.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  const upd = db().prepare("UPDATE rate_categories SET sort_order = ? WHERE id = ?");
  rows.forEach((r, idx) => upd.run((idx + 1) * 10, r.id));
}

/**
 * 분류 인라인 통합 저장 — 화면에 보이는 분류 행 전부를 한 번에(단가 항목·룸·작업 종류와 같은 규칙).
 * 기본 분류까지 편집 가능해지면서(2026-07-29) 행마다 저장 버튼이 생기면 재설계가 없앤 '행마다 저장'이
 * 되살아나므로 여기서도 통합 저장을 쓴다. 요청 바디에 없는 id는 건너뛰고(화면에 없던 행은 무변경),
 * 이름이 빈 행만 조용히 skip한다(JS-off·직접 제출 안전망 — 정상 브라우저는 required가 먼저 막는다).
 */
function bulkUpdateRateCategories(body = {}) {
  const d = db();
  const ids = d.prepare("SELECT id FROM rate_categories").all().map((r) => r.id);
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of ids) {
      if (body[`cat_name_${id}`] == null) continue;
      try { updateRateCategory(id, { name: body[`cat_name_${id}`], kind: body[`kind_${id}`] }); updated++; }
      catch (e) { if (e.message !== "CATEGORY_NAME_REQUIRED") throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
}

module.exports = {
  listRateCategories,
  bulkUpdateRateCategories,
  getRateCategory,
  rateCategoryKind,
  createRateCategory,
  updateRateCategory,
  moveRateCategory,
  deleteRateCategory,
};
