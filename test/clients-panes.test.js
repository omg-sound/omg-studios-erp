"use strict";
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(4800 + (process.pid % 200)); // 다른 서버 테스트 대역과 겹치지 않게(contacts-panes=4500대)
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("업체·그룹 2단: 목록/상세/편집", async (t) => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('c-chief@t.t','chief','치프',1)").run();
  const companyId = db().prepare("INSERT INTO parties (kind, name, roles, biz_no, email, phone, address) VALUES ('company', '(주)테스트', '제작사', '111-11-11111', 'a@b.com', '010-1', '서울') ").run().lastInsertRowid;
  const groupId = db().prepare("INSERT INTO parties (kind, name, activity_name) VALUES ('group', '더윈드', '더윈드')").run().lastInsertRowid;
  const personId = db().prepare("INSERT INTO parties (kind, name) VALUES ('person', '홍길동')").run().lastInsertRowid;

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/dev-login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" }, body: "as=chief", redirect: "manual" });
  const cookie = (login.headers.getSetCookie() || []).map((c) => String(c).split(";")[0]).join("; ");
  const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return { status: r.status, html: await r.text() }; };
  const raw = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); return { status: r.status, location: r.headers.get("location") }; };

  await t.test("GET /clients = 2단(업체/그룹 탭 + 이름 목록 + 빈 패널)", async () => {
    const { status, html } = await get("/clients?group=company");
    assert.equal(status, 200);
    assert.match(html, /업체 \d+/, "업체 탭 개수");
    assert.match(html, /그룹 \d+/, "그룹 탭 개수");
    assert.match(html, /data-filter-list/, "이름 목록(마스터)");
    assert.match(html, /업체·그룹을 선택하세요/, "빈 패널");
    assert.ok(!/<table class="dt"/.test(html), "표(dataTable) 없음");
  });
  // Task 4·5가 여기 아래에 서브테스트를 추가한다(companyId·groupId·personId·get·raw 재사용).

  await t.test("GET /clients/:id(업체) = 읽기 뷰(사업자번호·계산서 이메일·[편집]·폼 없음)", async () => {
    const { status, html } = await get(`/clients/${companyId}`);
    assert.equal(status, 200);
    assert.match(html, /111-11-11111/, "사업자번호");
    assert.match(html, /계산서 발행 이메일/, "계산서 이메일 라벨");
    assert.match(html, new RegExp(`href="/clients/${companyId}/edit"[^>]*>편집<`), "[편집] 링크");
    assert.ok(!/data-dirty-form/.test(html), "읽기 뷰엔 편집 폼 없음");
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
  });

  await t.test("GET /clients/:id(사람) = /contacts/:id로 302", async () => {
    const { status, location } = await raw(`/clients/${personId}`);
    assert.equal(status, 302);
    assert.match(location, new RegExp(`^/contacts/${personId}`));
  });

  await t.test("GET /clients/:id/edit(업체) = 편집 폼(data-dirty-form)+취소", async () => {
    const { status, html } = await get(`/clients/${companyId}/edit`);
    assert.equal(status, 200);
    assert.match(html, /data-dirty-form/, "편집 폼");
    assert.match(html, /data-filter-list/, "왼쪽 목록 유지");
    assert.match(html, /← 취소/, "취소 링크");
  });

  await t.test("GET /clients/:id/edit(그룹) = 멤버 섹션", async () => {
    const { html } = await get(`/clients/${groupId}/edit`);
    assert.match(html, new RegExp(`/clients/${groupId}/members`), "멤버 추가 폼 action");
  });

  await t.test("GET /clients/:id/edit?ferr= = 업로드 오류 메시지 표시", async () => {
    const { html } = await get(`/clients/${companyId}/edit?ferr=${encodeURIComponent("업로드 실패 테스트")}`);
    assert.match(html, /업로드 실패 테스트/, "첨부 오류 메시지가 편집 화면에 표시");
  });

  await t.test("GET /clients/:groupId (?group 없음) = 왼쪽 목록이 그룹 탭·선택 강조(sel.kind 폴백)", async () => {
    // ?group 없이 그룹 상세를 열면(유입 링크·[편집]) 왼쪽 목록이 업체 탭으로 떨어져 그 그룹이 목록에서 사라지던 것 방지.
    const { html } = await get(`/clients/${groupId}`);
    assert.match(html, /더윈드/, "선택한 그룹이 왼쪽 목록에 있음(그룹 탭 활성 — 업체 탭 폴백이면 목록에서 사라졌을 것)");
    assert.match(html, /aria-current="true">더윈드</, "그룹 행이 선택 강조됨");
  });

  // 초성 검색(2026-08-02 사용자 요청) — 연락처와 같은 매처(lib/chosung)를 라우트가 실제로 배선했는지.
  // 매처 단위 테스트는 contact-chosung-search가 잠그고, 여기선 **라우트 배선**(탭·완성형 비회귀)을 본다.
  await t.test("GET /clients?q=초성 = 상호 초성으로 검색(탭 유지·완성형 비회귀)", async () => {
    const cho = await get("/clients?group=company&q=" + encodeURIComponent("ㅌㅅㅌ"));
    assert.equal(cho.status, 200);
    // ⚠️업체 행 라벨은 법인 표기를 muted span으로 갈라 렌더하므로("(주)"+"테스트") 이름 문자열로 단언하면 안 된다 —
    // 행의 data-cho(초성열)로 확인한다(그 자체가 실시간 필터가 쓰는 키라 검증 가치도 더 크다).
    assert.match(cho.html, /data-cho="ㅈㅌㅅㅌ"/, "'(주)테스트' → ㅈㅌㅅㅌ 안의 ㅌㅅㅌ 부분일치");

    const grp = await get("/clients?group=group&q=" + encodeURIComponent("ㄷㅇㄷ"));
    assert.match(grp.html, /더윈드/, "그룹 탭에서도 초성 검색");

    const miss = await get("/clients?group=company&q=" + encodeURIComponent("ㄷㅇㄷ"));
    assert.match(miss.html, /검색 결과가 없습니다/, "탭 밖(그룹)은 안 잡힌다 — 초성 분기가 탭 필터를 지우지 않는다");

    const plain = await get("/clients?group=company&q=" + encodeURIComponent("테스트"));
    assert.match(plain.html, /data-cho="ㅈㅌㅅㅌ"/, "완성형 상호 검색은 종전 그대로");
  });

  server.close(); // 서버가 이벤트 루프를 붙잡아 node --test가 안 끝나는 것 방지(contacts-panes와 동일)
  t.after(() => cleanupDb(process.env.DB_PATH, db()));
});
