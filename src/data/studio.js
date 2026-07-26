"use strict";

/**
 * 스튜디오(공급자) 설정 도메인 — admin_state 백킹.
 * 거래명세서 PDF용 세금정보·로고, 예약 그리드 운영시간·기본 소요시간·기본 예약담당자.
 * data.js에서 분리한 첫 모듈(도메인별 모듈화 착수). data.js가 이 함수들을 재export하므로
 * 기존 소비자(`require("../data")`)는 변경 없이 계속 동작한다.
 */

const { getState, setState } = require("../db");
const { formatPhone, formatBizNo } = require("../lib/format");

// ── 공급자(스튜디오) 세금정보 — admin_state 평문(비밀 아님, studio_location과 동급) ──
const STUDIO_INFO_KEYS = ["studio_biz_name", "studio_biz_no", "studio_owner_name", "studio_address", "studio_biz_type", "studio_biz_item", "studio_tel"];
function getStudioInfo() {
  const out = {};
  for (const k of STUDIO_INFO_KEYS) out[k] = getState(k) || "";
  return out;
}
function setStudioInfo(body = {}) {
  for (const k of STUDIO_INFO_KEYS) {
    let v = String(body[k] || "").trim() || null;
    if (k === "studio_biz_no") v = formatBizNo(v); // 사업자번호 000-00-00000 정규화(거래명세서 표기)
    if (k === "studio_tel") v = formatPhone(v); // 전화 하이픈 정규화
    setState(k, v);
  }
}

/** 거래명세서 로고 — base64 data URI(admin_state.studio_logo). 없으면 null. */
function getStudioLogo() {
  return getState("studio_logo") || null;
}
function setStudioLogo(dataUri) {
  setState("studio_logo", dataUri ? String(dataUri) : null);
}

// (옛 '운영시간'[studio_hours_start/end]은 2026-07-27 제거 — 예약 시작 그리드가 날짜·시간 콤보로
//  바뀐 뒤 읽는 곳이 없어 저장·표시만 되는 설정이었다. admin_state 행은 지우지 않았다.)

// ── 기본 세션 시간(분) — 녹음 외 세션(믹싱·마스터링·기타)의 소요시간 슬라이더 기본값 ──
const DEFAULT_PRO_MINUTES = 210; // 3시간 30분
/** 녹음 외 세션의 기본 소요시간(분). 미설정/무효면 210(3시간 30분). */
function getProMinutes() {
  const v = parseInt(getState("studio_pro_minutes"), 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PRO_MINUTES;
}
/** 기본 세션 시간 저장(분 단위 정수, 무효면 null→기본값 폴백). */
function setProMinutes(mins) {
  const n = parseInt(mins, 10);
  setState("studio_pro_minutes", Number.isFinite(n) && n > 0 ? String(n) : null);
}

/** 기본 예약 담당자(이름) — 세션 폼에서 예약 담당자 기본 선택. 미설정이면 null. */
function getDefaultBooker() {
  return getState("default_booker") || null;
}
function setDefaultBooker(name) {
  setState("default_booker", String(name || "").trim() || null);
}

module.exports = {
  getStudioInfo,
  setStudioInfo,
  getStudioLogo,
  setStudioLogo,
  getProMinutes,
  setProMinutes,
  getDefaultBooker,
  setDefaultBooker,
};
