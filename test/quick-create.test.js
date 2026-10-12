"use strict";

// ── /new 빠른 생성(개편 1단계, 2026-10-13 — docs/redesign/01-quick-create.md) ──
// 실서버(임시 DB·전용 포트)로 화면·저장 경로를 끝까지 검증한다. 잠그는 계약:
//  · 새 이름 = 프로젝트 + 세션을 한 번에(한 트랜잭션 — 세션이 거부되면 프로젝트도 남지 않는다)
//  · 같은 이름이 있으면 **항상 확인**(사용자 결정) — 확인 표시 없이는 아무것도 만들지 않는다
//  · 기존 프로젝트 정보는 '고쳤다는 표시'가 있을 때만 갱신 — 빈 칸·세션 메모가 프로젝트로 새지 않는다
//  · 작업 = 곡을 자동으로 찾거나 만들고, 작업일을 저장한다
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4400 + (process.pid % 500)); // 병렬 테스트 파일과 포트 충돌 회피
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
init();
db().prepare("INSERT INTO users (email, role, name, active) VALUES ('qc-chief@t.t','chief','빠른치프',1)").run();
const roomA = Number(db().prepare("INSERT INTO rooms (name, active, bookable) VALUES ('A룸',1,1)").run().lastInsertRowid);

let base, cookie, server;

test.before(async () => {
  server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/dev-login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
    body: "as=chief",
    redirect: "manual",
  });
  const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
  cookie = setCookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  cleanupDb(process.env.DB_PATH, db());
});

/** 폼 제출(같은 이름 칸 반복 = 배열 — [['k','v'], ...] 쌍 목록도 받는다). */
function post(path, fields) {
  const body = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields)).toString();
  return fetch(base + path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
    body,
    redirect: "manual",
  });
}
const get = (path, headers = {}) => fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
const projectsTitled = (t) => db().prepare("SELECT * FROM projects WHERE title = ?").all(t);
const sessionsOf = (pid) => db().prepare("SELECT * FROM sessions WHERE project_id = ?").all(pid);

const SESSION = { kind: "session", session_date: "2026-11-03", start_time: "14:00", end_time: "18:00", session_type: "녹음", room_id: String(roomA), status: "예정" };

test("GET /new — 세션·작업 화면이 렌더되고, 상세 정보는 접혀 있다", async () => {
  for (const p of ["/new", "/new?type=task", "/new?date=2026-12-24"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /name="project_title"/, `${p}: 프로젝트 이름 칸`);
    assert.match(html, /<details class="group[^"]*" data-detail-section>/, `${p}: 상세 정보는 기본 접힘(open 없음)`);
  }
  const taskHtml = await (await get("/new?type=task")).text();
  assert.match(taskHtml, /<option value="Vocal_Recording" selected>/, "작업 종류 기본값 = 보컬 녹음");
  const html = await (await get("/new?date=2026-12-24")).text();
  assert.match(html, /name="session_date" value="2026-12-24"/, "캘린더 '+'의 날짜가 채워진다");
});

test("새 이름 → 프로젝트 + 세션을 함께 만들고, 그 달 캘린더에서 방금 만든 세션을 연다", async () => {
  const r = await post("/new", { ...SESSION, project_title: "  빠른  생성 앨범 " });
  assert.equal(r.status, 302);
  const rows = projectsTitled("빠른 생성 앨범");
  assert.equal(rows.length, 1, "제목은 공백 정리 후 저장");
  const ss = sessionsOf(rows[0].id);
  assert.equal(ss.length, 1);
  assert.equal(ss[0].start_time, "14:00");
  assert.match(r.headers.get("location"), new RegExp(`^/sessions\\?view=calendar&month=2026-11&open=${ss[0].id}&flash=added`));
});

test("같은 이름이 있으면 확인 없이는 아무것도 만들지 않는다 → 후보 패널", async () => {
  await post("/new", { ...SESSION, session_date: "2026-11-04", project_title: "동명 테스트" });
  assert.equal(projectsTitled("동명 테스트").length, 1);
  const r = await post("/new", { ...SESSION, session_date: "2026-11-05", project_title: "동명 테스트" });
  assert.equal(r.status, 200, "저장하지 않고 폼을 다시 그린다");
  const html = await r.text();
  assert.match(html, /같은 이름의 프로젝트가 있습니다/);
  assert.match(html, /name="project_id" value="\d+"[^>]*>이 프로젝트에 추가/);
  assert.match(html, /name="project_new_confirmed" value="1"/);
  assert.match(html, /name="session_date" value="2026-11-05"/, "입력한 날짜는 보존");
  assert.equal(projectsTitled("동명 테스트").length, 1, "프로젝트가 새로 생기지 않았다");
  assert.equal(sessionsOf(projectsTitled("동명 테스트")[0].id).length, 1, "세션도 생기지 않았다");
});

test("같은 이름 확인: [새 프로젝트로 만들기]면 새로, [이 프로젝트에 추가]면 기존에", async () => {
  await post("/new", { ...SESSION, session_date: "2026-11-06", project_title: "동명 확인" });
  const [first] = projectsTitled("동명 확인");
  // hidden 빈 값 + 버튼 값 = 배열로 온다(실제 폼과 같은 모양)
  const asNew = await post("/new", [...Object.entries({ ...SESSION, session_date: "2026-11-07", project_title: "동명 확인" }), ["project_new_confirmed", ""], ["project_new_confirmed", "1"]]);
  assert.equal(asNew.status, 302);
  assert.equal(projectsTitled("동명 확인").length, 2, "확인하면 새로 만든다");
  const toExisting = await post("/new", { ...SESSION, session_date: "2026-11-08", project_title: "동명 확인", project_id: String(first.id) });
  assert.equal(toExisting.status, 302);
  assert.equal(projectsTitled("동명 확인").length, 2, "기존을 고르면 새로 만들지 않는다");
  assert.equal(sessionsOf(first.id).length, 2, "고른 프로젝트에 세션이 붙는다");
});

test("세션이 거부되면(룸 겹침) 새 프로젝트도 남지 않는다 — 한 트랜잭션", async () => {
  await post("/new", { ...SESSION, session_date: "2026-11-10", project_title: "겹침 원본" });
  const r = await post("/new", { ...SESSION, session_date: "2026-11-10", start_time: "15:00", end_time: "17:00", project_title: "겹침 신규" });
  assert.equal(r.status, 409, "같은 룸·같은 시간 = 겹침 화면");
  assert.equal(projectsTitled("겹침 신규").length, 0, "롤백 — 빈 프로젝트가 남지 않는다");
});

test("기존 프로젝트: '고쳤다' 표시가 없으면 프로젝트 정보를 건드리지 않는다(빈 칸·세션 메모가 새지 않음)", async () => {
  await post("/new", { ...SESSION, session_date: "2026-11-12", project_title: "정보 보존", artist: "보존아티스트", production_company: "보존제작사" });
  const [p] = projectsTitled("정보 보존");
  assert.equal(p.artist, "보존아티스트", "새 프로젝트는 보낸 정보를 저장");
  db().prepare("UPDATE projects SET memo = '프로젝트 메모' WHERE id = ?").run(p.id);

  await post("/new", { ...SESSION, session_date: "2026-11-13", project_id: String(p.id), artist: "", production_company: "", memo: "세션 메모", project_info_touched: "0" });
  const after = db().prepare("SELECT * FROM projects WHERE id = ?").get(p.id);
  assert.equal(after.artist, "보존아티스트", "표시가 없으면 빈 아티스트 칸이 지우지 않는다");
  assert.equal(after.production_company, "보존제작사");
  assert.equal(after.memo, "프로젝트 메모", "세션 메모가 프로젝트 메모로 새지 않는다");

  await post("/new", { ...SESSION, session_date: "2026-11-14", project_id: String(p.id), artist: "바뀐아티스트", production_company: "보존제작사", memo: "세션 메모2", project_info_touched: "1" });
  const changed = db().prepare("SELECT * FROM projects WHERE id = ?").get(p.id);
  assert.equal(changed.artist, "바뀐아티스트", "표시가 있으면 갱신");
  assert.equal(changed.title, "정보 보존", "제목은 그대로");
  assert.equal(changed.memo, "프로젝트 메모", "갱신해도 메모는 그대로(이 화면엔 프로젝트 메모 칸이 없다)");
});

test("작업: 프로젝트에 바로 붙고(곡명 없으면 NULL), 곡명 줄마다 작업 하나, 작업일 저장", async () => {
  const types = db().prepare("SELECT key FROM task_types WHERE active = 1 ORDER BY sort_order LIMIT 1").get();
  const r = await post("/new", { kind: "task", project_title: "작업 앨범", task_type: types.key, work_date: "2026-11-20", song_title: "" });
  assert.equal(r.status, 302);
  const [p] = projectsTitled("작업 앨범");
  assert.match(r.headers.get("location"), new RegExp(`^/projects/${p.id}\\?tab=tracks&flash=added`));
  const tasks = db().prepare("SELECT * FROM track_tasks WHERE project_id = ?").all(p.id);
  assert.equal(tasks.length, 1, "작업이 프로젝트에 바로 붙는다(곡 개체 없음 — 개편 2단계)");
  assert.equal(tasks[0].song_title, null, "곡명이 비면 NULL(표시는 프로젝트 이름)");
  assert.equal(tasks[0].work_date, "2026-11-20");

  // 곡명 칸의 줄마다 작업 하나(빈 줄·중복 줄은 건너뜀)
  await post("/new", { kind: "task", project_id: String(p.id), task_type: types.key, song_title: "타이틀곡\n\n수록곡 2\n타이틀곡" });
  const titles = db().prepare("SELECT song_title FROM track_tasks WHERE project_id = ? ORDER BY id").all(p.id).map((t) => t.song_title);
  assert.deepEqual(titles, [null, "타이틀곡", "수록곡 2"]);
});

test("저장 후 복귀: return이 있으면 그곳, 없으면 화면을 연 페이지(Referer)", async () => {
  const r1 = await post("/new", { ...SESSION, session_date: "2026-11-16", project_title: "복귀 테스트1", return: "/projects" });
  assert.match(r1.headers.get("location"), /^\/projects\?flash=added/);
  // GET /new가 Referer를 return 칸에 실어 둔다(사이드바·단축키 진입)
  const html = await (await get("/new", { referer: base + "/invoices?filter=todo" })).text();
  assert.match(html, /name="return" value="\/invoices\?filter=todo"/);
  const foreign = await (await get("/new", { referer: "https://evil.example/x" })).text();
  assert.match(foreign, /name="return" value=""/, "다른 사이트 Referer는 버린다");
});

test("프로젝트 제안·동명 조회 JSON", async () => {
  const sug = await (await get("/new/project-suggest?q=" + encodeURIComponent("빠른"))).json();
  assert.ok(sug.some((x) => x.label === "빠른 생성 앨범" && x.id), "제안에 id가 실린다(고르면 ?project_id=로 다시 불러옴)");
  const m = await (await get("/new/project-match?title=" + encodeURIComponent(" 동명  테스트 "))).json();
  assert.equal(m.length, 1, "공백 정리 후 정확 일치");
});
