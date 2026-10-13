"use strict";

/**
 * 프로젝트 도메인 — 목록·단건 조회·자동완성 필드. (생성/수정은 라우트에서 직접 처리, 삭제는 tracks 도메인.)
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * (세션 예상액은 확정액만 — 단가표 산정은 개편 3단계에서 제거.)
 * sessionAmountsByProject는 내부 헬퍼(공개 API 미노출). getProjectForUser는 다수 도메인이 공유.
 */

const { db } = require("../db");
const { todayYmd } = require("../lib/date");
const { RENTAL_SESSION_TYPES, POSTPROD_SESSION_TYPES } = require("../config");
const { songOrderSql, songTitlesSql } = require("../lib/task-order");
const RENTAL_IN = RENTAL_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // SQL IN절(정적 config 값 — 인젝션 무관)
const POSTPROD_IN = POSTPROD_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // 후반작업(믹싱·마스터링) 세션 IN절

/** 프로젝트 폼 자동완성용 — 기존 프로젝트의 아티스트·소속사/레이블·제작사 중복 제거 목록. */
function distinctProjectFields() {
  const col = (c) =>
    db()
      .prepare(`SELECT DISTINCT ${c} AS v FROM projects WHERE ${c} IS NOT NULL AND TRIM(${c}) <> '' ORDER BY ${c} COLLATE NOCASE`)
      .all()
      .map((r) => r.v);
  return { artists: col("artist"), companies: col("artist_company"), productions: col("production_company") };
}

/** 프로젝트 ID 배열의 청구된 세션 금액 합계 맵(청구 라인 금액). 내부 헬퍼. */
function sessionAmountsByProject(projectIds) {
  if (!projectIds || !projectIds.length) return {};
  const placeholders = projectIds.map(() => "?").join(",");
  const sums = {};
  // 청구서에 걸린 세션 = invoice_items의 청구 금액.
  const invoiced = db()
    .prepare(
      `SELECT s.project_id AS pid, ii.session_id AS sid, SUM(ii.amount) AS amt
       FROM invoice_items ii
       JOIN sessions s ON s.id = ii.session_id
       WHERE s.project_id IN (${placeholders}) AND ii.session_id IS NOT NULL
       GROUP BY ii.session_id`
    )
    .all(...projectIds);
  for (const r of invoiced) sums[r.pid] = (sums[r.pid] || 0) + (r.amt || 0);
  // 미청구 세션은 더하지 않는다 — 금액은 청구서 작성 화면에서 처음 정한다(2026-10-14 사용자 결정).
  return sums;
}

/**
 * 프로젝트별 청구서 할인 합계(개편 3단계) — 청구서 할인을 **그 프로젝트 라인 금액 비례**로 배분한다.
 * 한 프로젝트 청구서(자유 줄 없음)는 비율 1이라 종전(그 청구서 할인 전액)과 같고, 여러 프로젝트를 섞은 청구서는
 * 매출 화면(ATTR_SUPPLY)과 같은 규칙으로 나뉜다. 자유 줄(계약금 등)은 어느 프로젝트에도 속하지 않는다.
 * 세션·작업 라인이 없는 청구서는 예산과 무관하므로 빠진다(종전 EXISTS 조건과 같은 결과).
 */
function invoiceDiscountByProject(projectIds) {
  const ids = (projectIds || []).map(Number).filter(Boolean);
  if (!ids.length) return {};
  const ph = ids.map(() => "?").join(",");
  const rows = db().prepare(
    `SELECT x.pid, x.invoice_id, x.amt, i.discount_amount AS disc,
            (SELECT SUM(a.amount) FROM invoice_items a WHERE a.invoice_id = x.invoice_id) AS total
       FROM (SELECT COALESCE(s.project_id, t.project_id) AS pid, ii.invoice_id, SUM(ii.amount) AS amt
               FROM invoice_items ii
               LEFT JOIN sessions s ON s.id = ii.session_id
               LEFT JOIN track_tasks t ON t.id = ii.task_id
              WHERE COALESCE(s.project_id, t.project_id) IN (${ph})
              GROUP BY pid, ii.invoice_id) x
       JOIN invoices i ON i.id = x.invoice_id
      WHERE i.discount_amount > 0`
  ).all(...ids);
  const out = {};
  for (const r of rows) {
    const share = r.total > 0 ? Math.round((r.disc * r.amt) / r.total) : 0;
    out[r.pid] = (out[r.pid] || 0) + share;
  }
  return out;
}

// 라우트는 filters 객체(service/clientId/q)를 넘기지만 목록 UI는 검색(q)만 사용 → q만 처리(나머지 인자는 무시).
function listProjects(_user, { q } = {}) {
  const where = [];
  const params = { today: todayYmd() };

  if (q) {
    // 제목·아티스트 외 소속사/레이블·제작사·메모·청구처(c.name)·담당 엔지니어(m.name)까지 검색.
    where.push(
      "(p.title LIKE @q OR p.artist LIKE @q OR p.artist_company LIKE @q OR p.production_company LIKE @q OR p.memo LIKE @q OR c.name LIKE @q OR m.name LIKE @q)"
    );
    params.q = `%${q}%`;
  }

  // 진행/완료 판정 신호(개편 5단계 — 완료 버튼 없음. 날짜와 청구 기록만 본다):
  //  upcoming_cnt = 다가오는 세션(오늘 포함 이후, 취소 제외) 수 — 있으면 '진행 중'.
  //  content_cnt  = 세션+작업 총량(0이면 아직 아무 내용 없는 빈 프로젝트) → 진행 중으로 취급
  const sql = `
    SELECT p.*, c.name AS client_name, m.name AS manager_name,
      ${songTitlesSql("p")} AS track_titles,
      (SELECT COALESCE(SUM(t.total_price), 0)
       FROM track_tasks t
       WHERE t.project_id = p.id AND t.is_invoiced = 1) AS task_total, -- 청구된 금액만(미청구 금액은 없다 — 2026-10-14)
      (SELECT COUNT(*) FROM sessions s
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status <> '취소') AS upcoming_cnt,
      (SELECT MIN(s.session_date) FROM sessions s
       WHERE s.project_id = p.id AND s.session_date >= @today AND s.status <> '취소') AS next_session_date,
      -- 세션 총수(취소 포함) — 목록 카드 진입 탭 결정용(세션 있으면 세션 일정, 없고 곡만 있으면 곡·콘텐츠).
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sess_cnt,
      (SELECT COUNT(*) FROM track_tasks t WHERE t.project_id = p.id) AS task_cnt,
      ((SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id)
       + (SELECT COUNT(*) FROM track_tasks t WHERE t.project_id = p.id)) AS content_cnt,
      -- 미청구 항목 수 = 미청구 작업 + 미청구 청구가능 세션(listBillableSessionsForProject와 동일 조건).
      -- 완료 탭에서 '청구 생성 안 한 프로젝트'를 위로 올리는 정렬·배지용(2026-07-05 사용자 요청).
      -- 청구 안 함(waived) 처리한 항목은 더 이상 '필요'하지 않으므로 제외(2026-07-06 사용자 요청).
      -- ⚠️ 단가 항목 미선택(rate_item_id NULL)도 **센다**(2026-07-23) — 안 세면 완료된 대관 세션이
      --    청구 후보·집계 양쪽에서 동시에 사라져 프로젝트가 조용히 '완료'로 넘어간다(매출 누락).
      --    산정이 안 될 뿐 청구는 여전히 '필요'하다. 진짜로 안 받을 거면 '청구 안 함'(waived)이 탈출구.
      -- 내부 지원 프로젝트(internal_support=1)는 애초에 청구 대상이 아니므로 전부 0으로 강제(2026-08-26).
      (CASE WHEN p.internal_support = 1 THEN 0 ELSE (
      (SELECT COUNT(*) FROM track_tasks t
         WHERE t.project_id = p.id AND t.is_invoiced = 0 AND t.waived = 0)
       + (SELECT COUNT(*) FROM sessions s
           WHERE s.project_id = p.id AND s.status <> '취소' AND s.session_type IN (${RENTAL_IN})
             AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
             AND s.waived = 0
             AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id))
       -- 후반작업(믹싱·마스터링)은 곡·콘텐츠 작업으로 청구하는데, 세션만 마치고 작업을 아직 안 만든
       -- 프로젝트는 청구할 게 없어 보여 조용히 '완료'로 넘어간다(2026-07-24). 청구 준비(작업·청구서)가
       -- 하나도 없을 때만 '청구 미착수' 플래그(+1)로 세어 '청구 필요'에 잡는다. 작업/청구서가 생기면
       -- 그쪽 로직이 이어받으므로 자동으로 꺼진다. 날짜가 된 세션만(오늘 포함 — 개편 5단계, 완료 버튼 대신 날짜).
       + (CASE WHEN EXISTS (
           SELECT 1 FROM sessions s2
            WHERE s2.project_id = p.id
              AND s2.session_type IN (${POSTPROD_IN})
              AND s2.status <> '취소' AND s2.waived = 0
              AND s2.session_date <= @today
              AND NOT EXISTS (SELECT 1 FROM track_tasks t3
                               WHERE t3.project_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM invoices i3 WHERE i3.project_id = p.id)
         ) THEN 1 ELSE 0 END)
      ) END) AS unbilled_cnt,
      -- 청구서 단위 할인 합계 — 작업·세션이 연결된(from-tasks) 청구서만. 수동 청구서 라인은 프로젝트 버짓에
      -- 안 잡히므로 그 할인을 빼면 이중 차감이 된다. 목록·상세 금액 표시에서 확정 라인 합계에서 차감(2026-07-05).
      0 AS invoice_discount_total /* 아래 invoiceDiscountByProject가 채운다(여러 프로젝트 청구서 배분) */
    FROM projects p
    LEFT JOIN parties c ON c.id = COALESCE(p.production_id, p.agency_id, p.artist_id)
    LEFT JOIN project_managers m ON m.id = p.manager_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      -- 생성일 순(최신 생성이 위, 2026-07-04 사용자 요청). 동일 생성일은 id 역순으로 안정 정렬.
      p.created_at DESC, p.id DESC`;
  const rows = db().prepare(sql).all(params);
  if (!rows.length) return rows;
  const sessionAmounts = sessionAmountsByProject(rows.map((r) => r.id));
  const discounts = invoiceDiscountByProject(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    invoice_discount_total: discounts[r.id] || 0,
    session_amount_total: sessionAmounts[r.id] || 0,
    // 활동 끝남 = 실제 활동이 있었고(content_cnt>0) 다가오는 세션(오늘 포함, 취소 제외)이 없다.
    // 개편 5단계(2026-10-13): 완료 버튼을 없애며 '예정 세션·미완료 작업이 없음'에서 **날짜**로 바꿨다 —
    // 완료를 안 눌러 진행 중에 남던 프로젝트가 사라진다. 작업은 등록=수주라 끝났는지는 청구(unbilled_cnt)가 말한다.
    is_completed: r.content_cnt > 0 && r.upcoming_cnt === 0,
  }));
}

/** 단건 조회 + 권한 검사. 권한 없으면 null(클라이언트가 타 프로젝트 접근 시도 시 404 처리용). */
function getProjectForUser(user, id) {
  const row = db()
    .prepare(
      `SELECT p.*, c.name AS client_name, m.name AS manager_name, ct.name AS contact_name, ct.phone AS contact_phone, ${songTitlesSql("p")} AS track_titles, task_sum.task_total,
         0 AS invoice_discount_total /* 아래 invoiceDiscountByProject가 채운다(여러 프로젝트 청구서 배분) */
       FROM projects p
       LEFT JOIN parties c ON c.id = COALESCE(p.production_id, p.agency_id, p.artist_id)
       LEFT JOIN project_managers m ON m.id = p.manager_id
       LEFT JOIN parties ct ON ct.id = p.contact_party_id
       LEFT JOIN (
         SELECT t.project_id, COALESCE(SUM(t.total_price), 0) AS task_total
         FROM track_tasks t
         WHERE t.is_invoiced = 1
         GROUP BY t.project_id
       ) task_sum ON task_sum.project_id = p.id
       WHERE p.id = ?`
    )
    .get(id);
  if (!row) return null;
  const sessionAmounts = sessionAmountsByProject([row.id]);
  return { ...row, invoice_discount_total: invoiceDiscountByProject([row.id])[row.id] || 0, session_amount_total: sessionAmounts[row.id] || 0 };
}

/**
 * 프로젝트 목록 인라인 요약(펼침용) — 여러 프로젝트를 **배치 2쿼리**로 한 번에(N+1 회피).
 * 반환: { [projectId]: { sessions:[{session_date,start_time,end_time,session_type,status}],
 *                        tracks:[{id,title,artist,engineers:[이름...]}] } }.
 * 세션은 취소 제외·날짜순, 트랙은 작성순 + 작업자(engineer_name) 중복 제거.
 */
function listProjectSummaries(projectIds) {
  const ids = (projectIds || []).map(Number).filter(Boolean);
  if (!ids.length) return {};
  const ph = ids.map(() => "?").join(",");
  const out = {};
  for (const id of ids) out[id] = { sessions: [], tracks: [] };
  const sessions = db()
    .prepare(
      `SELECT id, project_id, session_date, start_time, end_time, session_type, status
       FROM sessions WHERE project_id IN (${ph}) AND status <> '취소'
       ORDER BY session_date ASC, start_time ASC, id ASC`
    )
    .all(...ids);
  for (const s of sessions) if (out[s.project_id]) out[s.project_id].sessions.push(s);
  const taskRows = db()
    .prepare(
      `SELECT t.project_id, COALESCE(t.song_title, '') AS song_key, COALESCE(t.song_title, p.title) AS title, t.song_artist AS artist,
              t.id AS task_id, t.status AS task_status, t.engineer_name,
              COALESCE(NULLIF(tt.label, ''), t.task_type) AS type_label
       FROM track_tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_types tt ON tt.key = t.task_type
       WHERE t.project_id IN (${ph})
       ORDER BY ${songOrderSql("t")}`
    )
    .all(...ids);
  const trackMap = {};
  for (const r of taskRows) {
    // 곡 묶음 = 같은 프로젝트 안의 같은 곡명(개편 2단계 — 곡 개체 없음, 보기로만 묶는다).
    const k = `${r.project_id}|${r.song_key}`;
    let tk = trackMap[k];
    if (!tk) {
      tk = { id: k, title: r.title, artist: r.artist, engineers: [], tasks: [] };
      trackMap[k] = tk;
      if (out[r.project_id]) out[r.project_id].tracks.push(tk);
    }
    if (r.engineer_name && !tk.engineers.includes(r.engineer_name)) tk.engineers.push(r.engineer_name);
    if (r.task_id) tk.tasks.push({ id: r.task_id, label: r.type_label, status: r.task_status }); // 목록 펼침에서 작업 단위 완료 토글용
  }
  // (작업 종류별 집계 typeRows는 2026-07-11 제거 — 펼침이 이제 작업을 개별 표시하므로 aggregate 요약 불필요.)
  return out;
}

/**
 * 목록 rows를 진행 중(active)/청구 필요(billing)/완료(done) 3그룹으로 분류.
 *  - active  = !is_completed. 다가오는 세션 임박순(next_session_date ASC, 없으면 뒤로, 동률은 입력 순서=SQL created_at DESC 유지).
 *  - billing = is_completed && unbilled_cnt>0 (활동 끝났는데 미청구 — 지금 처리할 액션).
 *  - done    = is_completed && unbilled_cnt===0 (청구까지 끝난 아카이브).
 * Array.sort는 Node에서 안정 정렬이라 동률/양쪽 세션 없음은 SQL 순서를 보존한다.
 */
function splitProjectTabs(rows) {
  const list = rows || [];
  const active = list.filter((r) => !r.is_completed);
  const billing = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) > 0);
  const done = list.filter((r) => r.is_completed && Number(r.unbilled_cnt) === 0);
  active.sort((a, b) => {
    const ad = a.next_session_date || "";
    const bd = b.next_session_date || "";
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
    if (ad) return -1; // a만 다가오는 세션 있음 → 앞
    if (bd) return 1;  // b만 있음 → a 뒤로
    return 0;          // 둘 다 없음 → 입력 순서 유지
  });
  return { active, billing, done };
}

// ── 프로젝트 아티스트 다대다(2026-07-05 — 콤마로 여러 명) ── artist TEXT=콤마 표시 목록, artist_id=첫(대표), 전체=project_artists.

/** 프로젝트 아티스트 목록을 통째로 교체(session_directors 패턴). ids=party id 배열(dedup·falsy 제거). */
function setProjectArtists(projectId, ids) {
  const pid = Number(projectId);
  const d = db();
  d.prepare("DELETE FROM project_artists WHERE project_id = ?").run(pid);
  const ins = d.prepare("INSERT OR IGNORE INTO project_artists (project_id, party_id) VALUES (?, ?)");
  const seen = new Set();
  for (const id of ids || []) {
    const n = Number(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    ins.run(pid, n);
  }
}

/** 프로젝트의 아티스트 party 목록(등록 순서). */
function listProjectArtists(projectId) {
  return db()
    .prepare(
      `SELECT p.* FROM project_artists pa JOIN parties p ON p.id = pa.party_id
        WHERE pa.project_id = ? ORDER BY pa.created_at, p.name COLLATE NOCASE`
    )
    .all(Number(projectId));
}

// ── 프로젝트 고객측 담당자 다대다(2026-07-11 — 콤마로 여러 명, project_artists 패턴) ── contact_party_id=첫(대표), 전체=project_contacts.

/** 프로젝트 담당자 목록을 통째로 교체(project_artists 패턴). ids=party id 배열(dedup·falsy 제거·순서 보존). */
function setProjectContacts(projectId, ids) {
  const pid = Number(projectId);
  const d = db();
  d.prepare("DELETE FROM project_contacts WHERE project_id = ?").run(pid);
  const ins = d.prepare("INSERT OR IGNORE INTO project_contacts (project_id, party_id) VALUES (?, ?)");
  const seen = new Set();
  for (const id of ids || []) {
    const n = Number(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    ins.run(pid, n);
  }
}

/** 프로젝트의 담당자 party 목록(등록 순서) — personCombo(multi) 칩 프리필용. */
function listProjectContacts(projectId) {
  return db()
    .prepare(
      `SELECT p.* FROM project_contacts pc JOIN parties p ON p.id = pc.party_id
        WHERE pc.project_id = ? ORDER BY pc.created_at, p.name COLLATE NOCASE`
    )
    .all(Number(projectId));
}

/**
 * 담당자(project_managers.id)가 '관여한' 프로젝트 id 집합(2026-07-12 — '내 프로젝트만' 필터).
 * 관여 = PM(projects.manager_id) OR 담당 세션(session_engineers) OR 담당 작업(track_tasks.engineer_id).
 * 한 쿼리(UNION)로 id만 뽑아 Set 반환 — 라우트가 listProjects 결과를 이 집합으로 거른다(listProjects 무변경).
 */
function listProjectIdsForManager(managerId) {
  const mid = Number(managerId);
  if (!mid) return new Set();
  const rows = db()
    .prepare(
      `SELECT id AS project_id FROM projects WHERE manager_id = @mid
       UNION SELECT s.project_id FROM session_engineers se JOIN sessions s ON s.id = se.session_id WHERE se.manager_id = @mid
       UNION SELECT t.project_id FROM track_tasks t WHERE t.engineer_id = @mid`
    )
    .all({ mid });
  return new Set(rows.map((r) => r.project_id));
}

/** 프로젝트 삭제. 청구된 작업·세션이 있으면 거부(매출 추적 보존, deleteTrack과 정합). */
function deleteProject(projectId) {
  const pid = Number(projectId);
  const invoicedTask = db()
    .prepare("SELECT 1 FROM track_tasks t WHERE t.project_id = ? AND t.is_invoiced = 1 LIMIT 1")
    .get(pid);
  const invoicedSession = db()
    .prepare("SELECT 1 FROM invoice_items ii JOIN sessions s ON s.id = ii.session_id WHERE s.project_id = ? LIMIT 1")
    .get(pid);
  if (invoicedTask || invoicedSession) throw new Error("PROJECT_HAS_INVOICED");
  // 프로젝트 삭제는 트랙·작업·세션·배정을 CASCADE로 쓸어간다 — 이미 이체한 지급 기록이 남아 있으면 거부.
  const paidTask = db()
    .prepare("SELECT 1 FROM track_tasks t WHERE t.project_id = ? AND t.worker_paid = 1 LIMIT 1")
    .get(pid);
  const paidSession = db()
    .prepare("SELECT 1 FROM session_engineers se JOIN sessions s ON s.id = se.session_id WHERE s.project_id = ? AND se.worker_paid = 1 LIMIT 1")
    .get(pid);
  if (paidTask || paidSession) throw new Error("PAYOUT_LOCKED");
  // 자료 전달 첨부 실파일도 회수 — deliverables는 project_id CASCADE라 DB 행은 사라지지만 Drive/로컬의
  // 실제 파일은 그대로 남아 고아로 누적된다(2026-08-22 감사, deleteParty의 첨부 회수와 같은 이유).
  // 삭제 확정(COMMIT) 후에만 지운다 — 나중에 PROJECT_HAS_INVOICED 등으로 삭제 자체가 실패해도 파일이
  // 먼저 지워지는 사고를 피한다(deleteParty가 setImmediate를 트랜잭션 전에 예약해 롤백 시에도 파일이
  // 사라지는 것과 같은 함정을 여기서는 만들지 않는다).
  const orphanFiles = db().prepare("SELECT storage_backend, file_id FROM deliverables WHERE project_id = ?").all(pid);
  db().prepare("DELETE FROM projects WHERE id = ?").run(pid);
  if (orphanFiles.length) {
    const storage = require("../storage"); // 지연 require(순환 방지)
    for (const f of orphanFiles) {
      Promise.resolve(storage.remove(f.storage_backend, f.file_id)).catch((e) =>
        console.warn("[deleteProject] 자료 삭제 실패(고아 파일 잔존):", f.storage_backend, f.file_id, e && e.message)
      );
    }
  }
}

/**
 * 후반작업(믹싱/마스터링) 세션 날짜가 됐는데(오늘 포함) 청구 준비(작업·청구서)가 하나도 없는 상태인가?
 * = listProjects unbilled_cnt의 '청구 미착수' 항과 동일 조건. 청구 탭 안내 문구 노출 판정용.
 */
function hasPostprodSessionNeedingBilling(projectId) {
  const row = db()
    .prepare(
      `SELECT 1 FROM sessions s
        WHERE s.project_id = @pid
          AND s.session_type IN (${POSTPROD_IN})
          AND s.status <> '취소' AND s.waived = 0
          AND s.session_date <= @today
          AND NOT EXISTS (SELECT 1 FROM track_tasks t
                           WHERE t.project_id = @pid)
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = @pid)
        LIMIT 1`
    )
    // ⚠️SQL과 명명 파라미터를 함께 바꿀 것 — 안 쓰는 파라미터를 넘기거나 쓰는 걸 빠뜨리면 SQLite가 거부한다.
    .get({ pid: projectId, today: todayYmd() });
  return !!row;
}

module.exports = {
  distinctProjectFields,
  listProjects,
  listProjectSummaries,
  getProjectForUser,
  setProjectArtists,
  listProjectArtists,
  setProjectContacts,
  listProjectContacts,
  splitProjectTabs,
  listProjectIdsForManager,
  deleteProject,
  hasPostprodSessionNeedingBilling,
};
