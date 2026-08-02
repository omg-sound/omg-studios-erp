"use strict";

// ── 연락처 이메일은 로그인 계정이 소유한다 회귀 잠금(2026-08-02 사용자 결정) ──
// 옛 판정은 '담당자(project_managers) 연동'만 봤는데, 대표(owner)는 getManagerByPartyId가 일부러 제외해서
// **대표 연락처에서만 이메일이 편집됐다**(실측). 폼(readonly)과 저장(기존값 유지)이 같은 판정을 봐야 한다 —
// 갈리면 화면은 막는데 서버는 저장하거나 그 반대가 되고, 둘 다 조용히 어긋난다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { emailLocked } = require("../src/routes/contacts.routes");
const { syncUserToManager, findUserById } = require("../src/auth");
const { ensurePartyForUser, getManagerByPartyId, getParty } = require("../src/data");

const D = db();
D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (1,'boss@omgworks.kr','owner','박광현',1)").run();
D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (2,'eng@omgworks.kr','staff','김엔지',1)").run();
for (const id of [1, 2]) {
  syncUserToManager(findUserById(id)); // 로그인 = 담당자 동기화
  ensurePartyForUser(findUserById(id)); // 로그인 = 연락처 party 연결
}
const partyOf = (userId) => getParty(D.prepare("SELECT id FROM parties WHERE user_id = ?").get(userId).id);
const lockOf = (p) => emailLocked(p, getManagerByPartyId(p.id));

test("대표 연락처도 이메일이 잠긴다(옛 판정이 놓치던 자리)", () => {
  const owner = partyOf(1);
  assert.equal(getManagerByPartyId(owner.id), null, "전제: 대표는 담당자 연동 조회에서 제외된다(배지는 '대표' 유지)");
  assert.equal(lockOf(owner), true, "그래도 로그인 계정이므로 이메일은 잠긴다");
});

test("하우스 엔지니어는 종전대로 잠긴다", () => {
  assert.equal(lockOf(partyOf(2)), true);
});

test("로그인 계정이 아닌 연락처·외주는 이메일 편집 가능(과잉 차단 방지)", () => {
  const plain = D.prepare("INSERT INTO parties (kind, name, email) VALUES ('person','외부인','x@x.com')").run().lastInsertRowid;
  assert.equal(lockOf(getParty(plain)), false, "일반 연락처");

  const wid = D.prepare("INSERT INTO project_managers (name, active, party_id) VALUES ('외주맨', 1, ?)").run(plain).lastInsertRowid;
  const worker = getParty(plain);
  assert.equal(emailLocked(worker, D.prepare("SELECT * FROM project_managers WHERE id=?").get(wid)), false, "외주는 전화·이메일 양방향 동기화라 잠그지 않는다");
});

test("아직 로그인한 적 없는 하우스 엔지니어(party.user_id 없음)도 담당자 연동으로 잠긴다", () => {
  const pid = D.prepare("INSERT INTO parties (kind, name) VALUES ('person','미로그인엔지')").run().lastInsertRowid;
  D.prepare("INSERT INTO users (id, email, role, name, active) VALUES (3,'new@omgworks.kr','staff','미로그인엔지',1)").run();
  const m = D.prepare("INSERT INTO project_managers (name, user_id, active, party_id) VALUES ('미로그인엔지', 3, 1, ?)").run(pid).lastInsertRowid;
  const p = getParty(pid);
  assert.equal(p.user_id, null, "전제: 로그인 전이라 party.user_id 없음");
  assert.equal(emailLocked(p, D.prepare("SELECT * FROM project_managers WHERE id=?").get(m)), true);
});

test("잠근 칸이 틀어진 채 굳지 않는다 — 로그인 때 users.email로 되맞춘다", () => {
  const owner = partyOf(1);
  D.prepare("UPDATE parties SET email = 'wrong@example.com' WHERE id = ?").run(owner.id); // 구글 pull 등으로 틀어진 상황
  ensurePartyForUser(findUserById(1));
  assert.equal(partyOf(1).email, "boss@omgworks.kr", "로그인 시 계정 이메일로 복구");
  assert.equal(D.prepare("SELECT email FROM users WHERE id = 1").get().email, "boss@omgworks.kr", "로그인 이메일 자체는 불변");
});
