"use strict";

/**
 * 룸(스튜디오 공간) 도메인 — 룸별 겹침 검사 단위. 치프가 /settings에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * db()만 사용해 완전 독립적이다.
 *
 * 명칭 체계(2026-07-26): Studio A는 Control Room A + Booth A를 합친 **상위 단위**이고 그 둘은
 * Studio A의 하위로만 존재한다. 예약은 최상위 단위로만 잡으므로 하위 공간과 Lounge는 bookable=0이다.
 * 계층은 `parent_id`(FK 없음 — sessions.room_id와 같은 앱 레벨 정합).
 */

const { db } = require("../db");

/**
 * 룸 목록. 정렬: sort_order → 이름.
 * bookableOnly=true면 **예약 대상만**(하위 공간·Lounge 제외) — 세션 폼 장소 select이 쓴다.
 */
function listRooms({ includeInactive = false, bookableOnly = false } = {}) {
  const where = [];
  if (!includeInactive) where.push("active = 1");
  if (bookableOnly) where.push("bookable = 1");
  return db()
    .prepare(
      `SELECT * FROM rooms
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY sort_order ASC, name COLLATE NOCASE`
    )
    .all();
}

/** id로 룸 1건(없으면 null). 세션 폼이 '예약 대상이 아니지만 이미 잡혀 있는 장소'를 살려 두는 데 쓴다. */
function getRoom(id) {
  if (!id) return null;
  return db().prepare("SELECT * FROM rooms WHERE id = ?").get(Number(id)) || null;
}

/** 폼 입력 → 룸 필드. 상위 룸은 자기 자신·순환을 막고, 하위 공간은 예약 대상이 될 수 없다. */
function roomFields(input = {}, selfId = null) {
  const name = String(input.room_name != null ? input.room_name : input.name || "").trim();
  if (!name) throw new Error("ROOM_NAME_REQUIRED");
  const on = (v) => v === "1" || v === "on" || v === true;
  let parentId = Number(input.parent_id) || null;
  // 자기 자신을 상위로 두거나, 이미 하위인 룸을 상위로 지정하면(2단 초과) 계층이 꼬인다 → 무시하고 최상위로.
  if (parentId && selfId && parentId === Number(selfId)) parentId = null;
  if (parentId) {
    const p = getRoom(parentId);
    if (!p || p.parent_id) parentId = null;
  }
  return {
    name,
    parent_id: parentId,
    // 하위 공간은 단독 예약 대상이 아니다(규칙) — 상위가 있으면 체크와 무관하게 0.
    bookable: parentId ? 0 : on(input.bookable) ? 1 : 0,
    is_external: on(input.is_external) ? 1 : 0,
  };
}

function createRoom(input = {}) {
  const f = roomFields(input);
  const sort = Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 900; // 새 장소는 목록 맨 뒤(이후 ↑↓로 이동)
  const info = db()
    .prepare(
      `INSERT INTO rooms (name, parent_id, bookable, is_external, sort_order, active)
       VALUES (@name, @parent_id, @bookable, @is_external, @sort_order, 1)`
    )
    .run({ ...f, sort_order: sort });
  return getRoom(info.lastInsertRowid);
}

/**
 * 룸 정보 수정(2026-07-26 사용자 요청) — 이전에는 추가·삭제만 있어서 오타를 고치려면 지웠다 만들어야 했고,
 * 그러면 그 장소로 잡힌 세션이 전부 '장소 미지정'이 됐다(deleteRoom이 room_id를 NULL로 밀기 때문).
 * 이름을 바꿔도 id는 그대로이므로 기존 예약이 유지된다.
 */
function updateRoom(id, input = {}) {
  const cur = getRoom(id);
  if (!cur) return null;
  const f = roomFields(input, cur.id);
  db()
    .prepare("UPDATE rooms SET name=@name, parent_id=@parent_id, bookable=@bookable, is_external=@is_external WHERE id=@id")
    .run({ ...f, id: cur.id });
  return getRoom(cur.id);
}

/**
 * 표시 순서 이동(위/아래 한 칸) — 단가표 분류·작업 종류의 moveRateCategory/moveTaskType과 같은 방식.
 * 현재 표시 순서를 물질화해 이웃과 자리를 바꾸고 sort_order를 10 간격으로 재부여(기본값 중복 상태에서도 결정적).
 * **같은 상위 안에서만** 움직인다(하위 공간이 다른 스튜디오 밑으로 튀지 않게).
 */
function moveRoom(id, dir) {
  const cur = getRoom(id);
  if (!cur) return;
  const sibs = db()
    .prepare(
      `SELECT id FROM rooms WHERE IFNULL(parent_id, 0) = ? ORDER BY sort_order ASC, name COLLATE NOCASE`
    )
    .all(cur.parent_id || 0);
  const i = sibs.findIndex((r) => r.id === cur.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  const upd = db().prepare("UPDATE rooms SET sort_order = ? WHERE id = ?");
  // 하위 공간은 상위 바로 뒤에 붙어야 하므로(sort_order 오름차순 한 줄 목록) 상위의 순서를 기준으로 오프셋을 준다.
  const base = cur.parent_id ? (getRoom(cur.parent_id) || { sort_order: 0 }).sort_order : 0;
  sibs.forEach((r, idx) => upd.run(base + (idx + 1) * 10, r.id));
}

/** 장소(룸)가 외부 장소(주소 입력 대상)인지. 세션 저장 시 location 저장 여부 판정. */
function isExternalRoom(roomId) {
  if (!roomId) return false;
  const r = db().prepare("SELECT is_external FROM rooms WHERE id = ?").get(Number(roomId));
  return !!(r && r.is_external);
}

/**
 * 룸 삭제(하드). FK가 없으므로 참조를 코드가 정리한다(SET NULL 의미):
 * 참조 세션의 room_id → NULL, **하위 룸의 parent_id → NULL**(상위가 사라진 하위가 유령 참조로 남지 않게).
 */
function deleteRoom(id) {
  const rid = Number(id);
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE sessions SET room_id = NULL WHERE room_id = ?").run(rid);
    // 상위가 사라지면 하위는 최상위가 된다 — 예약 대상 여부는 사람이 다시 정하도록 0 유지.
    d.prepare("UPDATE rooms SET parent_id = NULL WHERE parent_id = ?").run(rid);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(rid);
    d.exec("COMMIT;");
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

module.exports = {
  listRooms,
  getRoom,
  createRoom,
  updateRoom,
  moveRoom,
  isExternalRoom,
  deleteRoom,
};
