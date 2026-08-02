"use strict";
// 초성 인덱스(iCloud식 이름 그룹핑·레일) — 한글 음절/쌍자음 병합·호환자모·영문·기타.
const test = require("node:test");
const assert = require("node:assert");
const { chosungOf } = require("../src/lib/chosung");

test("chosungOf: 한글 음절 첫 자의 초성", () => {
  assert.equal(chosungOf("강기민"), "ㄱ");
  assert.equal(chosungOf("김보종"), "ㄱ");
  assert.equal(chosungOf("루나"), "ㄹ");
  assert.equal(chosungOf("하영"), "ㅎ");
  assert.equal(chosungOf("박수한 대표님"), "ㅂ"); // 호칭 병기 이름도 첫 자 기준
});

test("chosungOf: 쌍자음은 기본 자음으로 병합", () => {
  assert.equal(chosungOf("까치"), "ㄱ");
  assert.equal(chosungOf("따오기"), "ㄷ");
  assert.equal(chosungOf("빠름"), "ㅂ");
  assert.equal(chosungOf("싸이"), "ㅅ");
  assert.equal(chosungOf("짜장"), "ㅈ");
});

test("chosungOf: 호환 자모 단독(ㅌㅌㅌ)·영문·기타", () => {
  assert.equal(chosungOf("ㅌㅌㅌ"), "ㅌ");
  assert.equal(chosungOf("Various Artists"), "V");
  assert.equal(chosungOf("apple"), "A");
  assert.equal(chosungOf("365데이"), "#");
  assert.equal(chosungOf(""), "#");
  assert.equal(chosungOf(null), "#");
  assert.equal(chosungOf("  김"), "ㄱ"); // 앞 공백 trim
});

// ── 초성 검색(2026-08-02 사용자 요청) ──
const { chosungTextOf, isChosungQuery, normalizeChosung } = require("../src/lib/chosung");

test("chosungTextOf: 문자열 전체의 초성열", () => {
  assert.equal(chosungTextOf("박광현"), "ㅂㄱㅎ");
  assert.equal(chosungTextOf("김보종"), "ㄱㅂㅈ");
  assert.equal(chosungTextOf("까치"), "ㄱㅊ"); // 쌍자음 병합
  assert.equal(chosungTextOf("블루노트 신인팀"), "ㅂㄹㄴㅌㅅㅇㅌ"); // 공백 제거 — 이어서 치는 입력에 맞춘다
  assert.equal(chosungTextOf("Various Artists"), "", "영문·기호는 버린다");
  assert.equal(chosungTextOf("365데이"), "ㄷㅇ");
  assert.equal(chosungTextOf(""), "");
  assert.equal(chosungTextOf(null), "");
});

test("isChosungQuery: 초성만인 질의만 참", () => {
  assert.equal(isChosungQuery("ㅂㄱㅎ"), true);
  assert.equal(isChosungQuery("ㅂ"), true, "한 글자도 초성 검색");
  assert.equal(isChosungQuery(" ㅂㄱㅎ "), true, "앞뒤 공백 trim");
  assert.equal(isChosungQuery("박광현"), false, "완성형은 기존 텍스트 검색");
  assert.equal(isChosungQuery("박ㄱㅎ"), false, "혼합은 미지원(기존 텍스트 검색으로)");
  assert.equal(isChosungQuery("ㅏㅑ"), false, "모음은 초성이 아니다");
  assert.equal(isChosungQuery(""), false);
  assert.equal(isChosungQuery(null), false);
});

test("normalizeChosung: 질의 쌍자음도 기본 자음으로(저장된 초성열과 짝 맞춤)", () => {
  assert.equal(normalizeChosung("ㄲㅊ"), "ㄱㅊ");
  assert.equal(normalizeChosung("ㅂㄱㅎ"), "ㅂㄱㅎ");
});

test("초성 검색은 부분 일치 — 이름 중간도 잡힌다", () => {
  const cho = chosungTextOf("박광현");
  assert.ok(cho.indexOf(normalizeChosung("ㄱㅎ")) >= 0, "'ㄱㅎ' → 박광현");
  assert.ok(cho.indexOf(normalizeChosung("ㅂㄱㅎ")) >= 0);
  assert.ok(cho.indexOf(normalizeChosung("ㅂㅎ")) < 0, "연속하지 않으면 안 잡힌다");
});
