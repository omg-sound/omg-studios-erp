"use strict";

// ── 연락처 초성 검색(2026-08-02 사용자 요청) ──
// 두 경로가 같은 결과를 내야 한다: 타이핑 중 실시간 필터(행의 data-cho)와 Enter(서버 listContacts).
// 갈리면 "치는 동안엔 보이다가 엔터를 치면 사라진다"가 된다. 초성열은 lib/chosung.js 한 곳에서만 만든다.
process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { listContacts } = require("../src/data");
const { contactNameList } = require("../src/views.contacts");

const D = db();
const add = (name, activity) =>
  D.prepare("INSERT INTO parties (kind, name, activity_name) VALUES ('person', ?, ?)").run(name, activity || null).lastInsertRowid;
add("박광현");
add("박서준"); // 성만 같고 초성열은 다르게(ㅂㅅㅈ) — 'ㅂㄱㅎ'가 이 사람까지 잡으면 안 된다
add("김보종");
add("까치산", null);
add("이수민", "루나"); // 활동명으로도 찾혀야 한다
add("Various Artists");

const names = (rows) => rows.map((r) => r.name).sort();

test("서버 검색: 초성만 치면 초성으로 찾는다", () => {
  assert.deepEqual(names(listContacts({ q: "ㅂㄱㅎ" })), ["박광현"]);
});

// 🔒 부분 일치 = 기존 텍스트 필터와 같은 성격('보'가 김보종을 잡는 것과 동일). 이름 앞에서만 맞추면
// 'ㄱㅎ'로 박광현을 찾는 흔한 입력이 죽는다. 대신 한 글자 질의는 중간 초성까지 걸려 넓게 잡힌다(의도).
test("서버 검색: 부분 일치 — 이름 중간 초성도 잡는다", () => {
  assert.deepEqual(names(listContacts({ q: "ㄱㅎ" })), ["박광현"], "이름 뒷부분만으로도");
  assert.deepEqual(names(listContacts({ q: "ㅂ" })), ["김보종", "박광현", "박서준"], "김'보'종의 중간 초성도 포함");
  assert.deepEqual(names(listContacts({ q: "ㅂㅎ" })), [], "연속하지 않으면 안 잡힌다");
});

test("서버 검색: 쌍자음 질의는 기본 자음과 같게 취급", () => {
  assert.deepEqual(names(listContacts({ q: "ㄲㅊㅅ" })), ["까치산"]);
  assert.deepEqual(names(listContacts({ q: "ㄱㅊㅅ" })), ["까치산"], "저장된 초성열이 병합돼 있어 둘 다 잡힌다");
});

test("서버 검색: 활동명도 대상", () => {
  assert.deepEqual(names(listContacts({ q: "ㄹㄴ" })), ["이수민"], "루나 → ㄹㄴ");
});

test("완성형·전화 검색은 종전 그대로(초성 분기가 기존 검색을 가로채지 않는다)", () => {
  assert.deepEqual(names(listContacts({ q: "박광" })), ["박광현"]);
  assert.deepEqual(names(listContacts({ q: "Various" })), ["Various Artists"]);
  assert.equal(listContacts({ q: "" }).length, 6, "빈 검색어는 전체");
});

test("탭 필터와 함께 동작한다(초성 분기가 tab 조건을 지우지 않는다)", () => {
  const uid = D.prepare("INSERT INTO users (email, role, name, active) VALUES ('bg@t.t','staff','박관리',1)").run().lastInsertRowid;
  D.prepare("UPDATE parties SET user_id = ? WHERE name = '박광현'").run(uid);
  assert.deepEqual(names(listContacts({ q: "ㅂ", tab: "staff" })), ["박광현"], "스태프 탭 안에서만");
  D.prepare("UPDATE parties SET user_id = NULL WHERE name = '박광현'").run();
});

test("목록 행에 초성열이 실린다 — 실시간 필터가 쓰는 키(서버가 찍고 클라이언트는 비교만)", () => {
  const rows = listContacts({});
  const html = contactNameList({ rows, hrefFn: (c) => `/contacts/${c.id}` });
  assert.match(html, /data-cho="ㅂㄱㅎ"/, "본명 초성열");
  assert.match(html, /data-cho="ㅇㅅㅁ ㄹㄴ"/, "본명·활동명을 공백으로 이어 붙인다");
  assert.ok(!/data-cho="[^"]*Various/.test(html), "영문 이름은 초성열이 비어 속성 자체가 없다");
});

// ── 업체·그룹(/clients)도 같은 규칙(2026-08-02) ──
// 라우트가 JS로 거르므로(listClients는 q를 안 받는다) 매처를 공유하는지가 핵심이다.
// 갈리면 연락처는 초성으로 찾히는데 업체는 안 찾히는 비대칭이 생긴다.
const { chosungMatcher } = require("../src/lib/chosung");

test("업체·그룹: 법인 표기가 붙어도 상호 초성으로 찾힌다(부분 일치)", () => {
  const m = chosungMatcher("ㅇㅁㄱ");
  assert.ok(m, "초성 질의");
  assert.equal(m("주식회사 오메가"), true, "'주식회사' 접두가 있어도 상호 초성이 부분일치로 잡힌다");
  assert.equal(m("오메가미디어그룹"), true);
  assert.equal(m("블루노트 레코즈"), false);
});

test("업체·그룹: 초성이 아니면 매처가 null → 라우트가 종전 상호 검색을 쓴다", () => {
  assert.equal(chosungMatcher("오메가"), null);
  assert.equal(chosungMatcher(""), null);
});

test("chosungMatcher: 연락처 서버 검색과 같은 결과(규칙이 한 곳임을 잠금)", () => {
  const m = chosungMatcher("ㅂㄱㅎ");
  const viaMatcher = listContacts({}).filter((r) => [r.name, r.activity_name].some((v) => v && m(v))).map((r) => r.name);
  assert.deepEqual(viaMatcher.sort(), names(listContacts({ q: "ㅂㄱㅎ" })), "매처 직접 적용 == listContacts 결과");
});
