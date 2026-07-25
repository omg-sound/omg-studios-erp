"use strict";

/**
 * SQLite 드라이버 어댑터.
 * - 운영(권장, 플레이북1 스택): better-sqlite3(네이티브, prebuild). Render의 Node 20/22에서 사용.
 * - 폴백: Node 내장 node:sqlite(DatabaseSync). 네이티브 빌드가 불가한 최신 Node 환경에서 사용.
 *
 * 두 드라이버 모두 동기 API이며 .exec(sql) / .prepare(sql).run|get|all 를 공유한다.
 * 차이는 PRAGMA 호출 방식뿐이라 db.js에서 PRAGMA는 exec로 통일한다.
 */

function openDatabase(filePath) {
  // DB_DRIVER=node:sqlite 로 폴백 드라이버를 강제할 수 있다.
  // 운영(Render)은 네이티브 빌드가 안 돼 node:sqlite 로 떨어지는데 로컬·테스트는
  // better-sqlite3 로 돌아, **드라이버 차이로 생기는 버그가 테스트를 통과해 배포된다.**
  // 2026-07-26 "Unknown named parameter 'today'" 가 실제로 그렇게 새어나갔다
  // (better-sqlite3는 SQL이 안 쓰는 명명 파라미터를 무시, node:sqlite는 거부).
  // 배포 전 `DB_DRIVER=node:sqlite npm test` 로 운영과 같은 드라이버를 한 번 태운다.
  if (process.env.DB_DRIVER === "node:sqlite") {
    const { DatabaseSync } = require("node:sqlite");
    return { driver: "node:sqlite", handle: new DatabaseSync(filePath) };
  }
  // 1순위: better-sqlite3
  try {
    const Database = require("better-sqlite3");
    const handle = new Database(filePath);
    return { driver: "better-sqlite3", handle };
  } catch (e) {
    // 2순위: Node 내장
    try {
      const { DatabaseSync } = require("node:sqlite");
      const handle = new DatabaseSync(filePath);
      return { driver: "node:sqlite", handle };
    } catch (e2) {
      const msg =
        "SQLite 드라이버를 찾을 수 없습니다. better-sqlite3 설치(권장) 또는 node:sqlite 지원 Node가 필요합니다.\n" +
        `  better-sqlite3 오류: ${e.message}\n  node:sqlite 오류: ${e2.message}`;
      throw new Error(msg);
    }
  }
}

module.exports = { openDatabase };
