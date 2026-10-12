"use strict";

/**
 * 프로젝트 쓰기(생성·수정) — 개편 1단계(2026-10-13)에서 routes/projects.routes.js에서 옮겨 왔다.
 * `/projects`(정보 탭)와 `/new`(빠른 생성)가 같은 당사자 해석·같은 INSERT/UPDATE를 쓰게 하려고.
 * 당사자 해석 규칙(resolveProjectParties)은 옮기기 전 그대로다 — 계약은 CLAUDE.md §프로젝트 '메타' 참조.
 *
 * 트랜잭션은 withTx — 바깥 트랜잭션(`/new`: 프로젝트 + 세션/작업) 안이면 그쪽이 커밋·롤백한다.
 */

const { db } = require("../db");
const { withTx } = require("../lib/tx");
const {
  createGroup,
  resolvePersonByName,
  ensureCompanyParty,
  addCompanyRole,
  resolvePartyByDisplay,
  currentAffiliations,
} = require("./parties"); // 무순환(parties는 projects를 require하지 않음)
const { setProjectArtists, setProjectContacts } = require("./projects");

/** 사람 party를 아티스트로 표시(is_artist=1, 활동명 비어 있으면 채움). 그룹은 이미 is_artist라 무해. */
function markArtistParty(partyId, activityName) {
  db()
    .prepare("UPDATE parties SET is_artist = 1, activity_name = COALESCE(NULLIF(TRIM(activity_name), ''), ?) WHERE id = ?")
    .run(String(activityName || "").trim() || null, Number(partyId));
}

/**
 * 프로젝트 폼 → 당사자(party) 참조 해석. { contactId, artistId, agencyId, productionId }.
 *  - 아티스트: 그룹 체크→group party / 명시 선택(artist_contact_id=party id) / 이름(본명 우선)으로 사람 party. 개인은 is_artist·활동명 세팅.
 *  - 소속사·제작사: 조직 party 찾거나 생성. 고객측 담당자: 사람 party.
 */
// 고객측 담당자 = 콤마로 여러 명(2026-07-11, personCombo multi 칩). 제출 = 칩마다 contact_id(당사자 id·신규는 빈값) +
// contact_name(순수 본명) 쌍(인덱스 페어링, linkClientContact와 동일). id 있으면 그대로, 신규 이름은 resolvePersonByName(재사용/생성).
function resolveContactIds(b) {
  const asArr = (v) => (Array.isArray(v) ? v : v != null && v !== "" ? [v] : []);
  const rawIds = asArr(b.contact_id);
  const rawNames = asArr(b.contact_name);
  const ids = [];
  const push = (pid) => { if (pid && !ids.includes(pid)) ids.push(pid); };
  for (let i = 0; i < Math.max(rawIds.length, rawNames.length); i++) {
    const pid = Number(rawIds[i]) || null;
    if (pid) { push(pid); continue; }
    const nm = String(rawNames[i] || "").trim();
    if (nm) push(resolvePersonByName(nm));
  }
  return ids;
}

function resolveProjectParties(b) {
  const contactIds = resolveContactIds(b);
  const contactId = contactIds[0] || null; // 첫(대표) = contact_party_id 호환(청구처 파생·관계자 탭·표시)
  // 아티스트 = 콤마로 여러 명 가능(2026-07-05 사용자 요청): "아이유, 태연" → 각 이름을 party로 해석해
  // project_artists(다대다)에 전부 기록, artist_id=첫(대표) 아티스트(청구처 파생·레거시 호환), artist TEXT=정규화된 콤마 목록(표시).
  const artistNames = String(b.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let artistIds = [];
  if (artistNames.length === 1) {
    // 단일 = 기존 경로 그대로(그룹 체크·명시 선택 artist_contact_id·본명 입력칸 모두 유효)
    const artistName = artistNames[0];
    if (b.artist_is_group) {
      const ex = db().prepare("SELECT id FROM parties WHERE kind = 'group' AND name = ? ORDER BY id LIMIT 1").get(artistName);
      artistIds = [ex ? ex.id : createGroup({ name: artistName })];
    } else if (b.artist_contact_id) {
      artistIds = [Number(b.artist_contact_id)];
      markArtistParty(artistIds[0], artistName);
    } else {
      const realName = String(b.artist_real_name || "").trim();
      artistIds = [resolvePersonByName(realName || artistName)];
      markArtistParty(artistIds[0], artistName);
    }
  } else if (artistNames.length > 1) {
    // 다중 = 각 이름 독립 해석(그룹 체크·명시 id·본명칸은 단일 전용이라 무시 — 이름 안전망이 커버):
    // 기존 그룹 정확 일치 → 그 그룹 / 사람은 resolvePersonByName(유일·라벨·활동명 안전망, 없으면 생성) + 아티스트 마킹.
    for (const nm of artistNames) {
      const g = db().prepare("SELECT id FROM parties WHERE kind = 'group' AND name = ? ORDER BY id LIMIT 1").get(nm);
      if (g) { artistIds.push(g.id); continue; }
      const pid = resolvePersonByName(nm);
      markArtistParty(pid, nm);
      artistIds.push(pid);
    }
    artistIds = [...new Set(artistIds)]; // "아이유, 아이유" 같은 중복 제거
  }
  const artistId = artistIds[0] || null;
  const artistText = artistNames.join(", ") || null; // 표시 TEXT 정규화("아이유,태연"→"아이유, 태연")
  // 제작/운영: 콤보에서 사람(관계자·개인) 또는 회사를 선택하면 hidden production_party_id로 party id가 온다 → 그 party를 직접 사용
  // (개인이 제작·운영하는 경우 지원, 2026-07-05). 없으면(새 이름 타이핑·id 미확정) ①기존 party 표시명 해석(resolvePartyByDisplay —
  // 회사 상호·사람 본명/라벨/활동명; 사람 라벨 "조형우 (형우비트)"가 회사로 오생성되는 것 방지) ②그래도 없으면 새 회사 생성.
  // 다운스트림 client_id 파생은 kind 무관(COALESCE JOIN).
  const prodPartyId = b.production_party_id ? Number(b.production_party_id) : null;
  const prodText = String(b.production_company || "").trim();
  const productionId = prodPartyId || (prodText ? resolvePartyByDisplay(prodText) || ensureCompanyParty(prodText, "제작사") : null);
  // 소속/레이블 = 아티스트 속성 → 프로젝트 폼 입력 필드 제거(2026-07-11 사용자 결정). 첫(대표) 아티스트의 현재 소속에서 파생.
  // 다중 아티스트는 첫 아티스트 기준(사용자 확인), 소속 미설정이면 null(소속 지정은 아티스트/연락처 쪽에서). 표시 TEXT도 파생 이름 사용.
  // ⚠️ 표시 이름과 FK는 **같은 소속 하나**에서 나와야 한다 — `agency_id`는 컬럼이 하나라 첫 소속만 담는데
  // 표시를 전 소속 병기로 하면 화면엔 'A, B'가 뜨고 청구처 파생·역할 배지(addCompanyRole)는 A에만 걸려
  // 보이는 것과 실제가 갈린다(2026-07-31 겸직 지원 도입 때 실제로 그랬다). 겸직은 연락처 상세에서 본다.
  const affs = artistId ? currentAffiliations(artistId) : [];
  const primaryAff = affs.find((a) => a.org_id) || null;
  const agencyId = primaryAff ? primaryAff.org_id : null;
  const agencyName = primaryAff ? primaryAff.org_name || null : null;
  // 파생 소속사·제작/운영 회사에 클라이언트 역할 반영(사람이면 no-op·멱등, 2026-07-10). 소속/레이블 배지 일관.
  if (agencyId) addCompanyRole(agencyId, "소속사/레이블");
  if (productionId) addCompanyRole(productionId, "제작사");
  return {
    contactId,
    contactIds,
    artistId,
    artistIds,
    artistText,
    agencyId,
    agencyName,
    productionId,
  };
}

/** 공백 정리된 프로젝트 제목(동명 판정·저장 공용 — 둘이 다르게 다듬으면 '같은 이름' 판정이 어긋난다). */
function cleanProjectTitle(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

/**
 * 폼 입력 → projects 컬럼 값. title·memo는 **입력에 키가 없으면 undefined**로 두어 수정 시 기존 값을 보존한다
 * (`/new`의 접힌 '프로젝트 정보'에는 제목·메모 칸이 없다 — 빈 값으로 덮어쓰면 안 된다).
 */
function projectColumns(b) {
  const parties = resolveProjectParties(b); // 아티스트/소속사/제작사/담당자 → party 참조(+ 아티스트 표시·중복 방지)
  return {
    parties,
    cols: {
      title: b.title === undefined ? undefined : cleanProjectTitle(b.title),
      // 표시용 denormalized TEXT 유지(목록·요약 렌더). 정체성/청구는 party 참조가 진실원천.
      artist: parties.artistText, // 콤마 다중 정규화("아이유, 태연")
      artist_company: parties.agencyName, // 첫 아티스트 소속에서 파생(폼 입력 필드 폐기)
      production_company: String(b.production_company || "").trim() || null,
      artist_id: parties.artistId,
      agency_id: parties.agencyId,
      production_id: parties.productionId,
      contact_party_id: parties.contactId,
      manager_id: b.manager_id ? Number(b.manager_id) : null,
      memo: b.memo === undefined ? undefined : String(b.memo || "").trim() || null,
      internal_support: b.internal_support === "on" || b.internal_support === "1" ? 1 : 0,
    },
  };
}

/** 프로젝트 생성 → 새 id. 제목이 비면 PROJECT_TITLE_REQUIRED. project_type은 session 고정(레거시 컬럼). */
function createProjectRecord(b) {
  const title = cleanProjectTitle(b.title);
  if (!title) throw new Error("PROJECT_TITLE_REQUIRED");
  // projects 행(denormalized 컬럼) + 다대다 아티스트·담당자를 한 트랜잭션으로 — 중간 실패 시 컬럼↔조인 불일치·빈 담당자 방지.
  return withTx(() => {
    const { parties, cols } = projectColumns({ ...b, title });
    const info = db()
      .prepare(
        `INSERT INTO projects (title, project_type, artist, artist_company, production_company,
           artist_id, agency_id, production_id, contact_party_id, manager_id, memo, internal_support)
         VALUES (@title, 'session', @artist, @artist_company, @production_company,
           @artist_id, @agency_id, @production_id, @contact_party_id, @manager_id, @memo, @internal_support)`
      )
      .run({ ...cols, memo: cols.memo === undefined ? null : cols.memo });
    const id = Number(info.lastInsertRowid);
    setProjectArtists(id, parties.artistIds); // 다대다 전체 기록(각 아티스트 상세 '연결 프로젝트' 매칭)
    setProjectContacts(id, parties.contactIds); // 고객측 담당자 다대다(첫=contact_party_id)
    return id;
  });
}

/**
 * 프로젝트 수정. 입력에 title/memo 키가 없으면 그 컬럼은 건드리지 않는다(위 projectColumns).
 * 제목 키가 있는데 비면 PROJECT_TITLE_REQUIRED. project_type은 UPDATE에서 제외(레거시 값 보존).
 */
function updateProjectRecord(id, b) {
  if (b.title !== undefined && !cleanProjectTitle(b.title)) throw new Error("PROJECT_TITLE_REQUIRED");
  // UPDATE + 다대다 통째 교체를 한 트랜잭션으로 — 담당자만 지워지고 컬럼은 옛값으로 남는 반쪽 갱신 방지.
  return withTx(() => {
    const { parties, cols } = projectColumns(b);
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    db()
      .prepare(`UPDATE projects SET ${keys.map((k) => `${k}=@${k}`).join(", ")} WHERE id=@id`)
      .run({ ...Object.fromEntries(keys.map((k) => [k, cols[k]])), id: Number(id) });
    setProjectArtists(id, parties.artistIds); // 다대다 목록 통째 교체
    setProjectContacts(id, parties.contactIds); // 고객측 담당자 다대다 통째 교체(첫=contact_party_id)
  });
}

/**
 * 제목이 같은(공백 정리 후 정확 일치) 프로젝트 목록 — `/new` 동명 확인용(2026-10-13 사용자 결정: 항상 확인).
 * 최근 활동(마지막 세션 날짜) 순. 후보 표시에 쓰는 아티스트·세션 수·최근 일정을 함께 싣는다.
 */
function findProjectsByTitle(title) {
  const t = cleanProjectTitle(title);
  if (!t) return [];
  return db()
    .prepare(
      `SELECT p.id, p.title, p.artist,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_cnt,
              (SELECT MAX(s.session_date) FROM sessions s WHERE s.project_id = p.id) AS last_date
       FROM projects p
       WHERE TRIM(p.title) = ?
       ORDER BY COALESCE(last_date, p.created_at) DESC, p.id DESC`
    )
    .all(t);
}

module.exports = {
  resolveProjectParties,
  cleanProjectTitle,
  createProjectRecord,
  updateProjectRecord,
  findProjectsByTitle,
};
