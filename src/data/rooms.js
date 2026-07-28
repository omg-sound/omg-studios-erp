"use strict";

/**
 * 룸(스튜디오 공간) 도메인 — 룸별 겹침 검사 단위. 치프가 /settings에서 CRUD.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * db()만 사용해 완전 독립적이다.
 *
 * 명칭 체계(2026-07-26): Studio A · Studio B · Studio C · Lounge. 예약 대상이 아닌 장소(Lounge 등)는
 * bookable=0이라 세션 폼 장소 목록에서 빠진다.
 *
 * 🚫 **룸 계층(상위/하위) 폐지**(2026-07-28 사용자 지시): 2026-07-26에 Studio A를 Control Room A + Booth A의
 * 상위 단위로 두는 2단 계층을 넣었으나, 예약은 어차피 최상위 단위로만 잡아 하위 행은 **관리 화면에서 자리만
 * 차지하고 아무 판단에도 쓰이지 않았다**. 계층 코드(상위 select·들여쓰기·2단 제한·상위 안 순서 이동)를 걷어내고
 * 하위로 만들어 뒀던 두 행도 삭제했다(`rooms_drop_hierarchy_v1`). `rooms.parent_id`는 **레거시 컬럼으로만 잔존**
 * (읽는 코드 0 — sessions는 큰 테이블이 아니지만 DROP COLUMN은 이득 없이 위험만 있어 director_contact_id와 같은 취급).
 */

const { db } = require("../db");

/**
 * 룸 목록. 정렬: sort_order → 이름.
 * bookableOnly=true면 **예약 대상만**(Lounge 등 작업 공간이 아닌 장소 제외) — 세션 폼 장소 select이 쓴다.
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

/** 폼 입력 → 룸 필드(계층 폐지 2026-07-28 — 상위 룸 개념 없음). */
function roomFields(input = {}) {
  const name = String(input.room_name != null ? input.room_name : input.name || "").trim();
  if (!name) throw new Error("ROOM_NAME_REQUIRED");
  const on = (v) => v === "1" || v === "on" || v === true;
  return {
    name,
    bookable: on(input.bookable) ? 1 : 0,
    is_external: on(input.is_external) ? 1 : 0,
  };
}

function createRoom(input = {}) {
  const f = roomFields(input);
  const sort = Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 900; // 새 장소는 목록 맨 뒤(이후 ↑↓로 이동)
  const info = db()
    .prepare(
      `INSERT INTO rooms (name, bookable, is_external, sort_order, active)
       VALUES (@name, @bookable, @is_external, @sort_order, 1)`
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
  const f = roomFields(input);
  db()
    .prepare("UPDATE rooms SET name=@name, bookable=@bookable, is_external=@is_external WHERE id=@id")
    .run({ ...f, id: cur.id });
  return getRoom(cur.id);
}

/**
 * 통합 저장(2026-07-27 인라인 편집) — rate-items의 bulkUpdateRateItems와 같은 규약.
 * 검증은 2단 구조: 이름 입력이 `required`라 정상 브라우저에서는 빈 이름 행이 있으면 제출 자체가 막힌다.
 * 여기의 이름 누락 skip은 required를 우회한 경우(JS-off·직접 제출)를 위한 안전망이다.
 */
function bulkUpdateRooms(body = {}) {
  const d = db();
  const ids = d.prepare("SELECT id FROM rooms").all().map((r) => r.id);
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of ids) {
      if (body[`room_name_${id}`] == null) continue;
      const input = {
        room_name: body[`room_name_${id}`],
        bookable: body[`bookable_${id}`],
        is_external: body[`is_external_${id}`],
      };
      try { updateRoom(id, input); updated++; }
      catch (e) { if (e.message !== "ROOM_NAME_REQUIRED") throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
}

/**
 * 표시 순서 이동(위/아래 한 칸) — 단가표 분류·작업 종류의 moveRateCategory/moveTaskType과 같은 방식.
 * 현재 표시 순서를 물질화해 이웃과 자리를 바꾸고 sort_order를 10 간격으로 재부여(기본값 중복 상태에서도 결정적).
 * (계층 폐지 2026-07-28 — 이전엔 '같은 상위 안에서만' 움직였으나 이제 전체 목록이 한 축이다.)
 */
function moveRoom(id, dir) {
  const cur = getRoom(id);
  if (!cur) return;
  const sibs = db().prepare("SELECT id FROM rooms ORDER BY sort_order ASC, name COLLATE NOCASE").all();
  const i = sibs.findIndex((r) => r.id === cur.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  const upd = db().prepare("UPDATE rooms SET sort_order = ? WHERE id = ?");
  sibs.forEach((r, idx) => upd.run((idx + 1) * 10, r.id));
}

/** 장소(룸)가 외부 장소(주소 입력 대상)인지. 세션 저장 시 location 저장 여부 판정. */
function isExternalRoom(roomId) {
  if (!roomId) return false;
  const r = db().prepare("SELECT is_external FROM rooms WHERE id = ?").get(Number(roomId));
  return !!(r && r.is_external);
}

/**
 * 룸 삭제(하드). FK가 없으므로 참조를 코드가 정리한다(SET NULL 의미): 참조 세션의 room_id → NULL.
 */
function deleteRoom(id) {
  const rid = Number(id);
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE sessions SET room_id = NULL WHERE room_id = ?").run(rid);
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
  bulkUpdateRooms,
  moveRoom,
  isExternalRoom,
  deleteRoom,
};
