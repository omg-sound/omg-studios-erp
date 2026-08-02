"use strict";

// 이름 첫 글자의 초성 인덱스(애플 iCloud 연락처식 그룹핑·인덱스 레일용).
// 한글 음절 → 초성(쌍자음은 기본 자음으로 병합: ㄲ→ㄱ). 호환 자모 단독(예 'ㅌㅌㅌ') → 그 자음.
// 영문 → 대문자 한 글자. 그 외(숫자·기호·공백) → '#'.

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const MERGE = { "ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ" };
const COMPAT = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"; // 호환 자모 단독 자음(U+3131~)

function chosungOf(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return "#";
  const ch = s[0];
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const cho = CHO[Math.floor((code - 0xac00) / 588)];
    return MERGE[cho] || cho;
  }
  if (COMPAT.indexOf(ch) >= 0) return MERGE[ch] || ch;
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  return "#";
}

/**
 * 문자열 전체의 초성열 — 초성 검색용("박광현" → "ㅂㄱㅎ").
 * 한글 음절·호환 자모만 남기고 영문·숫자·기호·공백은 **버린다**: 초성 검색은 한글 이름을 찾는 수단이고,
 * 공백을 남기면 "블루노트 신인팀"을 'ㅂㄴㅌㅅㅇㅌ'로 이어서 치는 자연스러운 입력이 안 맞는다.
 * 쌍자음은 chosungOf와 같은 규칙으로 병합(ㄲ→ㄱ) — 검색어 쪽도 normalizeChosung으로 맞춰야 짝이 된다.
 */
function chosungTextOf(text) {
  let out = "";
  for (const ch of String(text == null ? "" : text)) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const cho = CHO[Math.floor((code - 0xac00) / 588)];
      out += MERGE[cho] || cho;
    } else if (COMPAT.indexOf(ch) >= 0) {
      out += MERGE[ch] || ch;
    }
  }
  return out;
}

/** 검색어가 **초성만**인가(= 초성 검색으로 해석할 것인가). 한 글자도 허용('ㅂ' → 박씨 전부). */
function isChosungQuery(q) {
  const s = String(q == null ? "" : q).trim();
  return s.length > 0 && Array.from(s).every((ch) => COMPAT.indexOf(ch) >= 0);
}

/** 검색어 쌍자음을 기본 자음으로 병합 — 저장된 초성열이 병합돼 있으므로 질의도 맞춘다('ㄲ' → 까치·기민 모두). */
function normalizeChosung(q) {
  return Array.from(String(q == null ? "" : q).trim()).map((ch) => MERGE[ch] || ch).join("");
}

/**
 * 초성 질의면 매처(문자열 → boolean)를, 아니면 **null**을 준다.
 * null = "초성 검색이 아니다" → 호출부는 기존 텍스트/LIKE 검색을 그대로 쓴다.
 * 🔒 초성 판정·병합·부분일치 규칙을 **이 한 곳**에 모으기 위한 것 — 소비처(연락처 목록·업체 목록)가 각자
 * `isChosungQuery` + `normalizeChosung` + `indexOf`를 조립하면 한 곳만 바뀌어도 화면마다 결과가 갈린다.
 */
function chosungMatcher(q) {
  if (!isChosungQuery(q)) return null;
  const term = normalizeChosung(q);
  return (text) => chosungTextOf(text).indexOf(term) >= 0;
}

module.exports = { chosungOf, chosungTextOf, isChosungQuery, normalizeChosung, chosungMatcher };
