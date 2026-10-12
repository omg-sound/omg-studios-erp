"use strict";

/**
 * 작업(Task) CRUD 도메인.
 * 개편 2단계(2026-10-13): 곡(project_tracks) 계층을 없앴다 — 작업이 프로젝트에 바로 붙고, 곡은 작업의
 * 곡명(song_title)·곡 아티스트(song_artist) 칸이다. 화면의 '곡 묶음'은 같은 곡명끼리 **보기로만** 묶은 것.
 * 테이블 이름은 track_tasks 그대로(이름만 바꾸는 비용이 커서 — docs/redesign/02-flatten-tasks.md §3).
 *
 * cross-domain: getProjectForUser(projects)·getManagerByUserId(parties)·normalizeTaskTypeDb/taskTypeUnitPrice
 * (task-types)를 호출한다. 이 도메인들은 tracks를 호출하지 않으므로(무순환) 형제 모듈을 직접 require한다.
 */

const { db } = require("../db");
const { normalizeTaskStatus } = require("../config");
const { parseMoney, cleanYmd } = require("../lib/forms");
const { getProjectForUser } = require("./projects"); // 무순환
const { getManagerByUserId } = require("./parties"); // 무순환
const { normalizeTaskTypeDb, taskTypeUnitPrice } = require("./task-types"); // 무순환
const { songOrderSql } = require("../lib/task-order");

const parseWon = parseMoney; // 내부 호출명 parseWon 유지

/** 곡명 정리(공백 정리, 빈 값 = NULL = 표시는 프로젝트 이름). 묶음·이름 바꾸기·저장이 같은 규칙을 써야 묶음이 안 갈린다. */
function cleanSongTitle(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim() || null;
}

/**
 * 프로젝트의 작업을 곡명별로 묶어 반환 — { project, groups: [{ key, title, artist, tasks }] }.
 * key = 곡명(없으면 ""), title = 표시 이름(없으면 프로젝트 이름), artist = 곡 아티스트(첫 작업 기준, 없으면 null).
 */
function listTaskGroupsForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const tasks = db()
    .prepare(`SELECT t.* FROM track_tasks t WHERE t.project_id = ? ORDER BY ${songOrderSql("t")}`)
    .all(project.id);
  const groups = [];
  const byKey = new Map();
  for (const task of tasks) {
    const key = task.song_title || "";
    if (!byKey.has(key)) {
      const g = { key, title: task.song_title || project.title, artist: null, tasks: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    const g = byKey.get(key);
    if (!g.artist && task.song_artist) g.artist = task.song_artist;
    g.tasks.push(task);
  }
  return { project, groups };
}

/** 콤마 다중 아티스트 표시 정규화("아이유,태연 " → "아이유, 태연") — 프로젝트 artist TEXT와 동일 규칙(2026-07-05). */
function normalizeArtistList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
}

/**
 * 같은 곡명의 **미청구** 작업 곡명을 한 번에 바꾼다(곡 묶음 '이름 바꾸기'). 청구된 작업은 스냅샷 잠금이라 그대로 —
 * 그래서 바꾼 뒤에도 옛 이름 묶음이 남을 수 있다(locked 개수를 돌려줘 화면이 안내).
 * @returns {{project_id:number, changed:number, locked:number}|null}
 */
function renameSong(user, projectId, from, to) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const fromKey = cleanSongTitle(from) || "";
  const next = cleanSongTitle(to);
  const where = "project_id = ? AND COALESCE(song_title, '') = ?";
  const changed = db().prepare(`UPDATE track_tasks SET song_title = ? WHERE ${where} AND is_invoiced = 0`).run(next, project.id, fromKey).changes;
  const locked = db().prepare(`SELECT COUNT(*) AS n FROM track_tasks WHERE ${where} AND is_invoiced = 1`).get(project.id, fromKey).n;
  return { project_id: project.id, changed, locked };
}

function getTaskForUser(user, taskId) {
  const task = db()
    .prepare(
      `SELECT t.*, COALESCE(t.song_title, p.title) AS track_title, COALESCE(p.production_id, p.agency_id, p.artist_id) AS client_id
       FROM track_tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`
    )
    .get(taskId);
  return task || null;
}

/**
 * 작업 폼의 engineer_id(담당자 마스터 id) → { engineer_id, engineer_name } 결정.
 *  - 숫자 id면 그 manager로 id+name 동기 기록(표시·정산 매칭·레거시 호환).
 *  - 'legacy'면 제출된 engineer_name(레거시 자유입력) 보존(engineer_id는 NULL → 이름 폴백 정산).
 *  - 그 외(빈 값·미지정)면 둘 다 NULL.
 */
function resolveTaskEngineer(input) {
  const raw = String(input.engineer_id == null ? "" : input.engineer_id).trim();
  if (/^\d+$/.test(raw)) {
    const m = db().prepare("SELECT id, name, user_id FROM project_managers WHERE id = ?").get(Number(raw));
    if (m) return { engineer_id: m.id, engineer_name: m.name, is_external: !m.user_id }; // user_id 없으면 외주 작업자
  }
  if (raw === "legacy") {
    return { engineer_id: null, engineer_name: String(input.engineer_name || "").trim() || null, is_external: true };
  }
  return { engineer_id: null, engineer_name: null, is_external: false };
}

/** 청구 폼에서 입력한 작업 금액을 즉시 작업에 저장(초안이 아니라 기록 — 목록·청구 폼 기본값 반영). 청구된 작업은 거부. */
function setTaskAmount(user, taskId, amount) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  const amt = amount > 0 ? Math.round(amount) : 0;
  db().prepare("UPDATE track_tasks SET unit_price = ?, total_price = ? WHERE id = ?").run(amt, amt, task.id);
  return db().prepare("SELECT t.*, t.project_id FROM track_tasks t WHERE t.id = ?").get(task.id);
}

/** 작업 수정. 이미 청구된 작업은 거부(라인아이템 스냅샷이 잠금). total_price는 재계산. */
function updateTask(user, taskId, input = {}) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  // 금액은 청구 탭에서 확정 — 곡·콘텐츠 탭엔 금액 칸 없음. 입력값 있으면 우선, 없으면 확정 금액(total_price>0) 보존, 그것도 0이면 종류 기본단가.
  const taskType = normalizeTaskTypeDb(input.task_type);
  const hasPrice = input.unit_price != null && String(input.unit_price).trim() !== "";
  const unitPrice = hasPrice ? parseWon(input.unit_price) : (task.total_price > 0 ? task.total_price : taskTypeUnitPrice(taskType)); // 자동저장(상태·담당만 변경) 시 확정 금액 리셋 방지
  const eng = resolveTaskEngineer(input);
  // 상태는 완료 토글(POST /tasks/:id/status)이 전담 — 이 폼엔 상태 필드가 없다. 미전송이면 기존값 보존(리셋 방지, 2026-07-05).
  const status = input.status != null ? normalizeTaskStatus(input.status) : task.status;
  db()
    .prepare(
      `UPDATE track_tasks SET
         task_type = @task_type, billing_type = 'Fixed_Per_Track', quantity = 1,
         unit_price = @unit_price, total_price = @unit_price, engineer_name = @engineer_name,
         engineer_id = @engineer_id, worker_rate = @worker_rate, status = @status, work_date = @work_date,
         song_title = @song_title, song_artist = @song_artist
       WHERE id = @id`
    )
    .run({
      id: task.id,
      task_type: taskType,
      unit_price: unitPrice,
      engineer_name: eng.engineer_name,
      engineer_id: eng.engineer_id,
      worker_rate: eng.is_external ? parseWon(input.worker_rate) : 0, // 하우스 엔지니어·미지정은 외주 지급단가 없음(0, NOT NULL 컬럼)
      status,
      // 작업일 칸이 없는 폼(빠른 추가 버튼 등)의 저장이 기존 날짜를 지우지 않게 — 키가 있을 때만 갱신.
      work_date: input.work_date !== undefined ? cleanYmd(input.work_date) : task.work_date || null,
      // 곡명·곡 아티스트도 같은 규칙 — 칸이 없는 폼의 저장이 지우지 않게.
      song_title: input.song_title !== undefined ? cleanSongTitle(input.song_title) : task.song_title || null,
      song_artist: input.song_artist !== undefined ? normalizeArtistList(input.song_artist) || null : task.song_artist || null,
    });
  return db().prepare("SELECT t.*, t.project_id FROM track_tasks t WHERE t.id = ?").get(task.id);
}

/** 작업 완료 토글(2026-07-05 사용자 요청 — 세션 완료 버튼과 동일 UX). 상태만 바꾸고 종류·담당·단가는 건드리지 않는다. */
function setTaskStatus(user, taskId, status) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  db().prepare("UPDATE track_tasks SET status = ? WHERE id = ?").run(normalizeTaskStatus(status), task.id);
  return db().prepare("SELECT t.*, t.project_id FROM track_tasks t WHERE t.id = ?").get(task.id);
}

/**
 * '청구 안 함'(무료 처리) 토글(2026-07-06 사용자 요청 — 리허설 등 의도적 무료 작업). 청구 후보 화면에서만
 * 노출·되돌리기 가능한 표시 플래그일 뿐 total_price는 건드리지 않는다(되돌리면 원래 금액이 그대로 보이게).
 * 예산·미청구 집계(listProjects task_total·unbilled_cnt)에서는 waived=1을 제외한다.
 * 폼 필드 없이 현재값을 뒤집는 순수 토글(청구 생성 폼 안 여러 행이 한 폼을 공유해 이름 충돌 없이 안전).
 */
function setTaskWaived(user, taskId) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  db().prepare("UPDATE track_tasks SET waived = ? WHERE id = ?").run(task.waived ? 0 : 1, task.id);
  return db().prepare("SELECT t.*, t.project_id FROM track_tasks t WHERE t.id = ?").get(task.id);
}

function deleteTask(user, taskId) {
  const task = getTaskForUser(user, taskId);
  if (!task) return null;
  if (task.is_invoiced) throw new Error("TASK_LOCKED");
  if (task.worker_paid) throw new Error("PAYOUT_LOCKED"); // 이미 이체한 외주 지급 기록(원천세 신고 근거) — 지급 취소가 유일한 해제 경로
  db().prepare("DELETE FROM track_tasks WHERE id = ?").run(task.id);
  return { project_id: task.project_id };
}

/** 작업 1건 생성 — 프로젝트에 바로(개편 2단계). 곡명·곡 아티스트는 선택. */
function createTask(user, projectId, input = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  // 후반작업은 트랙/콘텐츠 고정(billing_type·quantity). 금액은 청구 탭에서 확정 — 생성 시엔 종류 기본단가 자동(입력값 있으면 우선).
  const taskType = normalizeTaskTypeDb(input.task_type);
  const hasPrice = input.unit_price != null && String(input.unit_price).trim() !== "";
  const unitPrice = hasPrice ? parseWon(input.unit_price) : taskTypeUnitPrice(taskType);
  const eng = resolveTaskEngineer(input);
  // 담당 엔지니어 미지정 시 로그인한 계정(하우스 엔지니어)을 기본값으로(빠른 추가 시 본인 자동 선택).
  if (!eng.engineer_id && !eng.engineer_name) {
    const mine = getManagerByUserId(user.id);
    if (mine) { eng.engineer_id = mine.id; eng.engineer_name = mine.name; eng.is_external = !mine.user_id; }
  }
  const info = db()
    .prepare(
      `INSERT INTO track_tasks
       (project_id, song_title, song_artist, task_type, billing_type, quantity, unit_price, total_price, engineer_name, engineer_id, worker_rate, status, is_invoiced, work_date)
       VALUES (@project_id, @song_title, @song_artist, @task_type, 'Fixed_Per_Track', 1, @unit_price, @unit_price, @engineer_name, @engineer_id, @worker_rate, @status, 0, @work_date)`
    )
    .run({
      project_id: project.id,
      song_title: cleanSongTitle(input.song_title),
      song_artist: normalizeArtistList(input.song_artist) || null, // 비우면 프로젝트 아티스트를 따라간다(복사하지 않는다)
      task_type: taskType,
      unit_price: unitPrice,
      engineer_name: eng.engineer_name,
      engineer_id: eng.engineer_id,
      worker_rate: eng.is_external ? parseWon(input.worker_rate) : 0, // 하우스 엔지니어·미지정은 외주 지급단가 없음(0, NOT NULL 컬럼)
      status: normalizeTaskStatus(input.status),
      work_date: cleanYmd(input.work_date), // 작업일(선택) — 형식이 틀리면 비운다
    });
  return db().prepare("SELECT * FROM track_tasks WHERE id = ?").get(info.lastInsertRowid);
}

/**
 * 작업 여러 건 — 곡명 칸의 **줄마다** 작업 하나(옛 '곡 일괄 추가'를 대신, 예: 믹싱 10곡). 같은 줄 중복은 한 번.
 * 곡명이 하나도 없으면 곡명 없는 작업 1건. 한 트랜잭션(중간 실패 시 일부만 생기지 않게).
 * @returns {Array<object>|null} 만든 작업들
 */
function createTasks(user, projectId, input = {}) {
  const titles = [...new Set(String(input.song_title == null ? "" : input.song_title).split(/\r?\n/).map(cleanSongTitle).filter(Boolean))];
  const { withTx } = require("../lib/tx");
  return withTx(() => {
    if (!titles.length) {
      const one = createTask(user, projectId, { ...input, song_title: "" });
      return one ? [one] : null;
    }
    const out = [];
    for (const t of titles) {
      const task = createTask(user, projectId, { ...input, song_title: t });
      if (!task) return null;
      out.push(task);
    }
    return out;
  });
}

module.exports = {
  listTaskGroupsForProject,
  cleanSongTitle,
  renameSong,
  getTaskForUser,
  setTaskAmount,
  updateTask,
  setTaskStatus,
  setTaskWaived,
  deleteTask,
  createTask,
  createTasks,
};
