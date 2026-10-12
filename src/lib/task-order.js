"use strict";

/**
 * 작업 정렬 SQL = **곡 묶음 순서**(그 곡명의 첫 작업 id) → 작업 순서(개편 2단계, 2026-10-13).
 * 작업 탭·목록 펼침·청구 후보·청구 라인이 같은 순서를 쓴다. 옛 '곡 등록순 → 작업 등록순'과 같은 결과다
 * (마이그레이션이 id를 보존). projects·tracks·invoices가 서로 require하면 순환이라 lib에 둔다.
 * @param {string} t 작업(track_tasks) 별칭
 */
function songOrderSql(t) {
  return `(SELECT MIN(o.id) FROM track_tasks o WHERE o.project_id = ${t}.project_id AND COALESCE(o.song_title, '') = COALESCE(${t}.song_title, '')) ASC, ${t}.id ASC`;
}

/** 프로젝트의 곡명 목록("||" 연결, 중복 제거) 서브쿼리 — 목록의 곡 수 표시용. @param {string} p 프로젝트 별칭 */
function songTitlesSql(p) {
  return `(SELECT GROUP_CONCAT(st, '||') FROM (SELECT DISTINCT song_title AS st FROM track_tasks WHERE project_id = ${p}.id AND song_title IS NOT NULL))`;
}

module.exports = { songOrderSql, songTitlesSql };
