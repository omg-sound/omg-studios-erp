"use strict";

// ── 프로젝트 목록 '내 프로젝트만' 기본 켜짐 회귀 잠금(2026-07-30 사용자 요청) ──
// 기본값 뒤집기는 URL 파라미터 하나가 아니라 **여섯 자리의 합의**로 성립한다: 필터 판정·탭/더보기 링크 보존·
// 토글 pill 방향·검색 폼 hidden·빈 화면 탈출구·상세 복귀 경로. 한 곳만 어긋나면 "토글을 껐는데 탭을 누르면
// 다시 켜진다" 류로 조용히 샌다 → 실서버에 실제 데이터를 넣고 HTML을 확인한다(라우트 안 인라인 로직이라
// 순수 함수로는 검증 불가). 시나리오를 한 테스트에 모으는 이유: 서버·DB를 파일당 한 번만 띄운다(smoke와 동일).
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(3600 + (process.pid % 200)); // 다른 테스트 파일과 포트 충돌 회피
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

// 서버·DB는 파일당 한 번(smoke와 동일). ⚠️정리 훅은 **모듈 최상위**에 둔다 — 테스트 콜백 안에서 test.after를
// 부르면 그 테스트가 끝나는 순간 서버가 닫혀 뒤따르는 테스트가 주소를 못 얻는다(실제로 겪음).
let server = null;
let base = "";
test.after(() => {
  if (server) server.close();
  const { db } = require("../src/db");
  cleanupDb(process.env.DB_PATH, db());
});

test("프로젝트 목록: '내 프로젝트만' 기본 켜짐 · ?mine=0으로 끄기 · 상태 보존 · 빈 화면 탈출구", async () => {
  const { db, init } = require("../src/db");
  init();
  const D = db();
  // 치프·스태프·대표 계정. 담당자(project_managers) 행은 치프·스태프에만 둔다 —
  // 여기 대표는 '담당자 행 없는 계정'의 대표 사례로 쓴다(토글이 숨고 전체를 본다).
  // ⚠️실제 운영의 대표는 2026-08-02부터 담당자 행을 갖는다(작업 배정) → 그 계정엔 토글이 뜬다.
  const chiefId = D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-chief@t.t','chief','마인치프',1)").run().lastInsertRowid;
  const staffId = D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-staff@t.t','staff','마인스태프',1)").run().lastInsertRowid;
  D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-owner@t.t','owner','마인대표',1)").run();
  const myMgr = D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('마인치프', ?, 1)").run(chiefId).lastInsertRowid;
  D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('마인스태프', ?, 1)").run(staffId); // 관여 0건(빈 화면 시나리오)
  const otherMgr = D.prepare("INSERT INTO project_managers (name, active) VALUES ('남엔지', 1)").run().lastInsertRowid;
  D.prepare("INSERT INTO projects (title, project_type, artist, manager_id, rate) VALUES ('내 프로젝트', 'session', '루나', ?, 0)").run(myMgr);
  D.prepare("INSERT INTO projects (title, project_type, artist, manager_id, rate) VALUES ('남의 프로젝트', 'session', '태연', ?, 0)").run(otherMgr);

  server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  base = `http://127.0.0.1:${server.address().port}`;

  const loginAs = async (role) => {
    const r = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=" + role,
      redirect: "manual",
    });
    assert.equal(r.status, 302, `dev-login(${role})`);
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    return set.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
  };
  const get = async (path, cookie) => {
    const r = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
    assert.equal(r.status, 200, `GET ${path}`);
    return r.text();
  };

  const chief = await loginAs("chief");
  const owner = await loginAs("owner");
  const staff = await loginAs("staff");

  // ① 기본(파라미터 없음) = 내 프로젝트만
  const dflt = await get("/projects", chief);
  assert.match(dflt, /내 프로젝트/, "기본: 내 프로젝트 보임");
  assert.ok(!/남의 프로젝트/.test(dflt), "기본: 남의 프로젝트는 안 보임(필터가 기본으로 켜짐)");
  assert.match(dflt, /✓ 내 프로젝트만/, "pill 켜짐 표시");
  assert.match(dflt, /href="\/projects\?tab=active&mine=0"/, "pill 클릭 = 끄기(mine=0)");

  // ② ?mine=0 = 전체
  const all = await get("/projects?mine=0", chief);
  assert.match(all, /내 프로젝트/, "끔: 내 프로젝트");
  assert.match(all, /남의 프로젝트/, "끔: 남의 프로젝트도 보임");
  assert.ok(!/✓ 내 프로젝트만/.test(all), "pill 꺼짐 표시");

  // ③ 끔 상태가 탭·검색 폼에 보존된다(한 곳만 빠지면 탭을 누르는 순간 기본으로 되돌아간다)
  // ⚠️tabBar·emptyState는 href를 esc()하므로 `&`가 `&amp;`로 렌더된다(HTML상 정상) — 둘 다 허용.
  assert.match(all, /href="\/projects\?tab=done(&|&amp;)mine=0"/, "탭 링크에 mine=0 보존");
  assert.match(all, /name="mine" value="0"/, "검색 폼 hidden에 mine=0 보존");

  // ④ 담당자 행이 없는 계정(대표)은 토글이 없고 전체를 본다(기본 켜짐 미적용)
  const ownerView = await get("/projects", owner);
  assert.match(ownerView, /내 프로젝트/, "대표: 전부 1");
  assert.match(ownerView, /남의 프로젝트/, "대표: 전부 2");
  assert.ok(!/내 프로젝트만/.test(ownerView), "대표: 토글 pill 없음");

  // ⑤ 관여 0건이면 빈 화면에 탈출구를 준다(새 스태프의 첫 진입이 빈 목록이 되므로)
  const staffView = await get("/projects", staff);
  assert.match(staffView, /내가 관여한 프로젝트가 없습니다/, "관여 0건 안내");
  assert.match(staffView, /전체 프로젝트 보기/, "전체 보기 탈출구 라벨");
  assert.match(staffView, /href="\/projects\?tab=active(&|&amp;)mine=0"/, "탈출구가 mine=0으로 간다");
});

// ── 대표(담당자 행 있음)는 기본 꺼짐 = 전체를 본다(2026-08-02 사용자 결정) ──
// 대표도 작업에 배정되므로 담당자 행이 생겼는데(2026-08-02), 기본까지 '내 프로젝트만'이면
// 대표가 프로젝트 목록에서 전사 현황을 못 본다 — 대표의 일은 청구(계산서·입금)라 전체가 기본이어야 한다.
// 토글은 남긴다(필요하면 켠다) → 기본과 다른 상태는 `mine=1`로 보존돼야 한다(스태프의 mine=0과 대칭).
test("프로젝트 목록: 대표는 담당자 행이 있어도 기본 꺼짐 · ?mine=1로 켜기 · 상태 보존", async () => {
  const { db } = require("../src/db");
  const D = db();
  const ownerUser = D.prepare("SELECT id FROM users WHERE email='mine-owner@t.t'").get();
  const ownerMgr = D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('마인대표', ?, 1)").run(ownerUser.id).lastInsertRowid;
  D.prepare("INSERT INTO projects (title, project_type, artist, manager_id, rate) VALUES ('대표 프로젝트', 'session', '아이유', ?, 0)").run(ownerMgr);

  const r = await fetch(base + "/dev-login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
    body: "as=owner",
    redirect: "manual",
  });
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
  const owner = set.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { cookie: owner }, redirect: "manual" });
    assert.equal(res.status, 200, `GET ${path}`);
    return res.text();
  };

  // ① 기본(파라미터 없음) = 전체 — 대표 본인 것도, 남의 것도 다 보인다
  const dflt = await get("/projects");
  assert.match(dflt, /대표 프로젝트/, "대표: 내 것");
  assert.match(dflt, /남의 프로젝트/, "대표: 남의 것도 보임(기본 꺼짐)");
  assert.ok(!/✓ 내 프로젝트만/.test(dflt), "대표: pill 꺼짐 표시");
  assert.match(dflt, /내 프로젝트만/, "대표: 토글 pill 자체는 있다(켤 수 있어야 한다)");
  assert.match(dflt, /href="\/projects\?tab=active&mine=1"/, "pill 클릭 = 켜기(mine=1)");
  assert.ok(!/name="mine" value="0"/.test(dflt), "기본 상태에는 파라미터를 달지 않는다");

  // ② ?mine=1 = 내 것만
  const onlyMine = await get("/projects?mine=1");
  assert.match(onlyMine, /대표 프로젝트/, "켬: 내 것");
  assert.ok(!/남의 프로젝트/.test(onlyMine), "켬: 남의 것은 빠진다");
  assert.match(onlyMine, /✓ 내 프로젝트만/, "pill 켜짐 표시");

  // ③ 켬(기본과 다른 상태)이 탭·검색 폼에 보존된다 — 안 실으면 탭을 누르는 순간 전체로 튄다
  assert.match(onlyMine, /href="\/projects\?tab=done(&|&amp;)mine=1/, "탭 링크에 mine=1 보존");
  assert.match(onlyMine, /name="mine" value="1"/, "검색 폼 hidden에 mine=1 보존");
});
