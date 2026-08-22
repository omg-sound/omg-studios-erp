"use strict";

/**
 * 전역 통합 검색 집계(2026-07-21) — 5개 엔티티를 **기존 조회로 모아** 카테고리 순서 고정으로 반환.
 * 스펙: docs/superpowers/specs/2026-07-21-global-search-design.md.
 *
 * 여기선 raw rows만 낸다 — `{label,sub,href}` 매핑은 뷰 헬퍼(personName/personLabel)가 필요해 라우트에서 수행.
 * 크로스 도메인 require는 형제 모듈 직접(무순환 — 이 모듈을 되부르는 곳 없음).
 */
const { listProjects } = require("./projects");
const { listContacts, searchClients } = require("./parties");
const { searchInvoices } = require("./invoices");
const { searchSessions } = require("./sessions");

/**
 * 5개 카테고리 집계. 순서 고정(프로젝트→연락처→업체·그룹→청구→세션). rows는 카테고리별 상위 perCat건.
 * @returns {Array<{cat:string, key:string, rows:object[]}>}
 */
function searchAll(user, q, perCat = 5) {
  const query = String(q || "").trim();
  if (!query) return [];
  return [
    { cat: "프로젝트", key: "projects", rows: listProjects(user, { q: query }).slice(0, perCat) },
    { cat: "연락처", key: "contacts", rows: listContacts({ q: query }).slice(0, perCat) },
    { cat: "업체·그룹", key: "clients", rows: searchClients(query, perCat) },
    { cat: "청구", key: "invoices", rows: searchInvoices(user, query, perCat) },
    { cat: "세션", key: "sessions", rows: searchSessions(query, perCat) },
  ];
}

module.exports = { searchAll };
