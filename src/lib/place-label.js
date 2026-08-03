"use strict";
/**
 * Places Details 응답 → 구글 캘린더 **제목 뒤에 붙일 짧은 장소 라벨**(2026-08-03 사용자 요청).
 *
 * 규칙(실측 표본 7건으로 확정 — docs/superpowers/specs/2026-08-03-external-session-title-location-design.md):
 *   국내(country=KR) · 장소(establishment) → displayName            "잠실실내체육관"
 *   국내 · 주소(street_address 등)         → 동네 + 번지            "이태원로15길 27-3" · "이태원동 181-53"
 *   해외                                    → 국가 + 도시(국가 먼저) "튀르키예 이스탄불" · "미국 뉴욕"
 *
 * ⚠️ **`mainText`(자동완성 표시용)를 쓰면 안 된다** — 국내 주소에서 구가 따라붙는다("용산구 이태원로15길 27-3").
 *    사용자 결정은 구 제외라, 주소는 addressComponents로 조립한다.
 * ⚠️ **`displayName`도 그대로 쓰면 안 된다** — 주소 유형에서는 번지 조각만 온다("27-3"). 그래서 types로 먼저 가른다.
 * ⚠️ 일부 도시는 구글이 한국어 표기를 주지 않는다(멕시코시티 → "Ciudad de México"). **그대로 둔다**(사용자 결정) —
 *    별칭 표를 만들면 그 표를 영원히 관리해야 하고, 읽는 데 지장은 없다.
 */

const MAX_LEN = 40; // 제목 뒤에 붙는 값이라 길면 월간뷰에서 아티스트 이름이 밀린다

/** addressComponents에서 그 타입의 첫 성분. */
function comp(details, type) {
  const list = (details && details.addressComponents) || [];
  return list.find((c) => Array.isArray(c.types) && c.types.includes(type)) || null;
}
function text(c) {
  return c && c.longText ? String(c.longText).trim() : "";
}
/** 장소(가게·체육관 등)인가 — 아니면 순수 주소. */
function isPlace(details) {
  const types = (details && details.types) || [];
  return types.includes("establishment") || types.includes("point_of_interest");
}

function koreanLabel(details) {
  if (isPlace(details)) return (details.displayName && details.displayName.text) || "";
  // 주소: 도로명(sublocality_level_4) 또는 법정동(sublocality_level_2) + 번지(premise). 구(level_1)는 뺀다.
  const area = text(comp(details, "sublocality_level_4")) || text(comp(details, "sublocality_level_2"));
  const no = text(comp(details, "premise"));
  const joined = [area, no].filter(Boolean).join(" ");
  // 조립할 게 없는 주소 형태 폴백 — 구가 붙더라도("용산구 …") 라벨이 없는 것보다 낫다.
  return joined || String(details.shortFormattedAddress || "").trim();
}

function foreignLabel(details, country) {
  // 도시는 locality가 정석(뉴욕·이스탄불 모두 여기로 온다). 없는 나라를 대비해 상위 행정구역으로 폴백.
  const city =
    text(comp(details, "locality")) ||
    text(comp(details, "administrative_area_level_2")) ||
    text(comp(details, "administrative_area_level_1"));
  return [text(country), city].filter(Boolean).join(" ");
}

/** 공백 정리 + 길이 상한. 개행은 캘린더 제목에 들어가면 안 된다. */
function clean(s) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN).trim() : t;
}

/** Places Details 응답 → 라벨(없으면 빈 문자열 — 호출부는 빈 값이면 제목을 안 건드린다). */
function placeLabel(details) {
  if (!details) return "";
  const country = comp(details, "country");
  const isKR = !!(country && country.shortText === "KR");
  return clean(isKR ? koreanLabel(details) : foreignLabel(details, country));
}

module.exports = { placeLabel, MAX_LEN };
