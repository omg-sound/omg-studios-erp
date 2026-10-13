"use strict";

// ── 개편 4단계 정리(redesign_cleanup_v1) — docs/redesign/04-cleanup.md ──
// 잠그는 계약:
//  ① 지운 테이블·컬럼은 **기동을 반복해도 되살아나지 않는다** — init의 CREATE·addColumn이 남아 있으면 다음 기동에서
//     빈 채로 돌아온다(2026-07 legacy_drop_v1이 지운 director_contact_id가 실제로 그랬다).
//  ② 세션을 만들고 지울 수 있다 — rate_item_id(REFERENCES rate_items)가 남은 채 rate_items만 사라지면
//     세션 INSERT·DELETE가 'no such table'로 실패한다.
//  ③ 소스에 지운 이름이 다시 나타나지 않는다(정리 이행 함수만 예외).
//  ④ 운영 모양 DB에서 이행: 메모 이관·연결 보존·외래키 무결.
//  ⑤ 곡 계층이 남은 옛 DB는 열지 않는다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
const D = require("../src/data");
const d = db();
test.after(() => cleanupDb(process.env.DB_PATH, d));

const CHIEF = { id: 1, role: "chief", email: "chief@omg.test" };
const DROPPED_TABLES = ["rate_items", "rate_categories", "session_segments", "project_tracks", "surcharges"];
const DROPPED_COLUMNS = [
  ["sessions", "rate_item_id"], ["sessions", "surcharge_key"], ["sessions", "surcharge_memo"],
  ["sessions", "billing_memo"], ["sessions", "director_contact_id"], ["track_tasks", "billing_memo"],
  ["task_types", "unit_price"], ["task_types", "billing_type"], ["task_types", "price_type"],
];
const tables = () => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

function assertClean(label) {
  const ts = tables();
  for (const t of DROPPED_TABLES) assert.ok(!ts.includes(t), `${label}: 테이블 ${t}가 없어야 한다`);
  for (const [t, c] of DROPPED_COLUMNS) assert.ok(!cols(t).includes(c), `${label}: ${t}.${c}가 없어야 한다`);
}

test("① 새 DB에도 없고, 기동을 반복해도 되살아나지 않는다", () => {
  assertClean("첫 기동");
  init();
  init();
  assertClean("재기동 2회");
});

test("② 세션을 만들고 지울 수 있다", () => {
  const pid = Number(d.prepare("INSERT INTO projects (title) VALUES ('세션 생성 확인')").run().lastInsertRowid);
  const s = D.createSession(CHIEF, pid, { session_type: "녹음", session_date: "2099-05-01", start_time: "10:00", end_time: "12:00" });
  assert.ok(s && s.id, "세션 생성");
  D.deleteSession(CHIEF, s.id);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sessions WHERE id = ?").get(s.id).n, 0, "세션 삭제");
});

test("③ src·app.js에 지운 이름이 다시 나타나지 않는다(정리 이행 함수만 예외)", () => {
  // director_contact_id는 뺀다 — 세션 폼 입력칸 이름(personCombo idField)이기도 하고, 옛 정체성 이관(clients가
  // 있을 때만 도는 코드)이 읽는다. 컬럼이 되살아나지 않는지는 ①이 본다.
  const NAMES = [...DROPPED_TABLES, "rate_item_id", "surcharge_key", "surcharge_memo", "billing_memo"];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(__dirname, "../src"));
  files.push(path.join(__dirname, "../public/js/app.js"));
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")          // 블록 주석
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")      // 줄 주석(URL의 :// 제외)
    .replace(/(^|\s)--\s.*$/gm, "$1");         // SQL 주석
  const hits = [];
  for (const f of files) {
    let src = fs.readFileSync(f, "utf8");
    if (f.endsWith(path.join("src", "db.js"))) {
      // 정리 이행 함수 본문은 지울 대상의 이름을 불러야 한다 — 그 함수만 뺀다.
      const a = src.indexOf("function redesignCleanup(");
      const b = src.indexOf("\n}\n", a);
      assert.ok(a > 0 && b > a, "db.js에 redesignCleanup이 있어야 한다");
      src = src.slice(0, a) + src.slice(b);
    }
    src = strip(src);
    for (const n of NAMES) if (new RegExp(`\\b${n}\\b`).test(src)) hits.push(`${path.relative(path.join(__dirname, ".."), f)}: ${n}`);
  }
  assert.deepEqual(hits, [], `지운 이름이 코드에 남아 있다:\n${hits.join("\n")}`);
});

test("④ 운영 모양 DB: 조정 사유·촬영 구간은 메모로, 청구 연결은 그대로, 지운 뒤 외래키 무결", () => {
  // 3단계 직후 운영 DB의 모양을 재현한다(정리 전 테이블·컬럼 + 값).
  d.exec("PRAGMA foreign_keys = OFF;");
  d.exec(`CREATE TABLE rate_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
          CREATE TABLE rate_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
          CREATE TABLE project_tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT);
          CREATE TABLE session_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);`);
  d.exec("ALTER TABLE sessions ADD COLUMN rate_item_id INTEGER REFERENCES rate_items(id) ON DELETE SET NULL");
  d.exec("ALTER TABLE sessions ADD COLUMN billing_memo TEXT");
  d.exec("ALTER TABLE sessions ADD COLUMN director_contact_id INTEGER");
  d.exec("ALTER TABLE track_tasks ADD COLUMN billing_memo TEXT");
  d.exec("ALTER TABLE task_types ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0");
  d.exec("PRAGMA foreign_keys = ON;");

  const ri = Number(d.prepare("INSERT INTO rate_items (name) VALUES ('보컬녹음')").run().lastInsertRowid);
  const pid = Number(d.prepare("INSERT INTO projects (title, memo) VALUES ('정리 리허설', '기존 메모')").run().lastInsertRowid);
  const s1 = Number(d.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, rate_item_id, billing_amount, billing_memo) VALUES (?, '녹음', '2026-09-01', '10:00', '13:30', '완료', ?, 280000, '단골 할인')").run(pid, ri).lastInsertRowid);
  const s2 = Number(d.prepare("INSERT INTO sessions (project_id, session_type, session_date, start_time, end_time, status, memo) VALUES (?, '촬영 대관', '2026-09-02', '09:00', '19:00', '예정', '촬영 메모')").run(pid).lastInsertRowid);
  d.prepare("INSERT INTO session_segments (session_id, kind, start_time, end_time, sort_order) VALUES (?, 'setup', '09:00', '10:00', 0), (?, 'shoot', '10:00', '18:00', 10)").run(s2, s2);
  const t1 = Number(d.prepare("INSERT INTO track_tasks (project_id, song_title, task_type, total_price, status, billing_memo) VALUES (?, '월광', 'Mixing', 500000, 'Completed', '두 번 수정')").run(pid).lastInsertRowid);
  const inv = Number(d.prepare("INSERT INTO invoices (project_id, title, amount, tax_amount, status) VALUES (?, '청구', 858000, 78000, '발행')").run(pid).lastInsertRowid);
  d.prepare("INSERT INTO invoice_items (invoice_id, session_id, description, amount) VALUES (?, ?, '녹음', 280000)").run(inv, s1);
  d.prepare("INSERT INTO invoice_items (invoice_id, task_id, description, amount) VALUES (?, ?, '믹싱', 500000)").run(inv, t1);

  d.prepare("DELETE FROM admin_state WHERE key = 'redesign_cleanup_v1'").run();
  init();

  assertClean("정리 이행 후");
  assert.equal(d.prepare("SELECT memo FROM sessions WHERE id = ?").get(s1).memo, "금액 조정 사유: 단골 할인");
  assert.equal(d.prepare("SELECT memo FROM sessions WHERE id = ?").get(s2).memo, "촬영 메모\n촬영 구간: 반입·설치 09:00–10:00 · 촬영 10:00–18:00");
  assert.equal(d.prepare("SELECT memo FROM projects WHERE id = ?").get(pid).memo, "기존 메모\n금액 조정 사유(월광 믹싱): 두 번 수정");
  const lines = d.prepare("SELECT session_id, task_id FROM invoice_items WHERE invoice_id = ? ORDER BY id").all(inv);
  assert.deepEqual(lines.map((l) => [l.session_id, l.task_id]), [[s1, null], [null, t1]], "청구 라인 ↔ 세션·작업 연결 보존");
  assert.equal(d.prepare("SELECT billing_amount FROM sessions WHERE id = ?").get(s1).billing_amount, 280000, "확정액 보존");
  assert.deepEqual(d.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(d.prepare("SELECT value FROM admin_state WHERE key = 'redesign_cleanup_v1'").get(), "게이트 기록");

  init(); // 한 번 더 — 메모가 두 번 붙거나 지운 것이 돌아오지 않는다
  assertClean("정리 이행 후 재기동");
  assert.equal(d.prepare("SELECT memo FROM sessions WHERE id = ?").get(s1).memo, "금액 조정 사유: 단골 할인");
});

test("⑤ 곡 계층이 남은 옛 DB(track_tasks.track_id)는 열지 않는다", () => {
  d.exec("ALTER TABLE track_tasks ADD COLUMN track_id INTEGER");
  try {
    assert.throws(() => init(), /옛 구조 DB/);
  } finally {
    d.exec("ALTER TABLE track_tasks DROP COLUMN track_id");
  }
});
