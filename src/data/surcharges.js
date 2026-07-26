"use strict";

/**
 * 할증 마스터(surcharges) 도메인 — 2026-07-26 신설.
 *
 * 요율을 코드에 박지 않는다(사용자 지시: "할증률은 마스터 테이블 값으로 관리"). 시드는 미장센 할증 50%
 * (`mise_en_scene`, applies_to='filming')이고, `sessions.surcharge_key`가 이 key를 문자열로 참조한다
 * (FK 아님 — rate_items.category와 같은 방식. 마스터 행이 사라져도 세션은 남고 할증만 무효가 된다).
 *
 * **자동 판정은 하지 않는다**(주관적) — 세션 폼의 체크박스 + 사유 메모로 사람이 정한다.
 * 스탠드 라이트나 테이블 위 꽃병 같은 간단한 오브제는 할증 대상이 아니고, '적극적인' 미장센만 대상이다.
 */

const { db } = require("../db");

/** 활성 할증 목록. appliesTo(단가 kind: filming 등)를 주면 그 kind 대상 + 전체 대상(applies_to NULL)만. */
function listSurcharges({ appliesTo = null, includeInactive = false } = {}) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push("active = 1");
  if (appliesTo) {
    where.push("(applies_to IS NULL OR applies_to = ?)");
    params.push(String(appliesTo));
  }
  return db()
    .prepare(`SELECT * FROM surcharges ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sort_order, label COLLATE NOCASE`)
    .all(...params);
}

/** key → 할증 1건(없거나 비활성이면 null). computeCharge에 `{label, rate}`로 넘긴다. */
function getSurcharge(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  return db().prepare("SELECT * FROM surcharges WHERE key = ? AND active = 1").get(k) || null;
}

module.exports = { listSurcharges, getSurcharge };
