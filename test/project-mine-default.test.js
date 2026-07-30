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

test("프로젝트 목록: '내 프로젝트만' 기본 켜짐 · ?mine=0으로 끄기 · 상태 보존 · 빈 화면 탈출구", async () => {
  const { db, init } = require("../src/db");
  init();
  const D = db();
  // 치프·스태프·대표 계정. 담당자(project_managers) 행은 치프·스태프에만 둔다 —
  // 대표는 관여 개념이 없어(담당자 행 없음) 토글이 숨고 전체를 본다.
  const chiefId = D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-chief@t.t','chief','마인치프',1)").run().lastInsertRowid;
  const staffId = D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-staff@t.t','staff','마인스태프',1)").run().lastInsertRowid;
  D.prepare("INSERT INTO users (email, role, name, active) VALUES ('mine-owner@t.t','owner','마인대표',1)").run();
  const myMgr = D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('마인치프', ?, 1)").run(chiefId).lastInsertRowid;
  D.prepare("INSERT INTO project_managers (name, user_id, active) VALUES ('마인스태프', ?, 1)").run(staffId); // 관여 0건(빈 화면 시나리오)
  const otherMgr = D.prepare("INSERT INTO project_managers (name, active) VALUES ('남엔지', 1)").run().lastInsertRowid;
  D.prepare("INSERT INTO projects (title, project_type, artist, manager_id, rate) VALUES ('내 프로젝트', 'session', '루나', ?, 0)").run(myMgr);
  D.prepare("INSERT INTO projects (title, project_type, artist, manager_id, rate) VALUES ('남의 프로젝트', 'session', '태연', ?, 0)").run(otherMgr);

  const server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  test.after(() => {
    server.close();
    cleanupDb(process.env.DB_PATH, db());
  });

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
