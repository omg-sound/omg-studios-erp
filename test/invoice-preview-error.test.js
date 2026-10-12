"use strict";

process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(5500 + (process.pid % 200)); // 기존 서버 테스트(3500·3600·3900·4500·4800·5000·5300대)와 겹치지 않는 새 대역
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("견적서 미리보기: 줄 없이 요청하면 400 + 이 창 닫기/대기함 버튼(큰 코드 숫자 없이)", async () => {
  const { db, init } = require("../src/db");
  init();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('preview-chief@t.t','chief','미리보기치프',1)").run();
  const pj = db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('견적테스트', 'task', 0)").run();
  const projectId = Number(pj.lastInsertRowid);

  const server = require("../src/server");
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(base + "/dev-login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
    body: "as=chief",
    redirect: "manual",
  });
  const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get("set-cookie")];
  const cookie = setCookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");

  try {
    // 줄 없이 요청(클라이언트 가드를 우회한 것과 같음) — 서버 안전망 확인. 미리보기는 청구서 작성 화면(개편 3단계)에서 연다.
    const res = await fetch(`${base}/invoices/preview/견적서/x.pdf`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.status, 400, "줄 없이 요청하면 400");
    const html = await res.text();
    assert.match(html, /청구할 줄이 없습니다\./, "원인 메시지 포함");
    assert.match(html, /data-close-tab/, "이 창 닫기 버튼 포함");
    assert.match(html, /href="\/invoices\/inbox"/, "청구 대기함 링크 포함");
    assert.doesNotMatch(html, />400</, "큰 400 코드 숫자 없음(공용 errorPage 미사용)");
    // 옛 프로젝트 미리보기 주소는 대기함으로 보낸다(북마크·옛 탭).
    const old = await fetch(`${base}/projects/${projectId}/invoices/preview/견적서/x.pdf`, { headers: { cookie }, redirect: "manual" });
    assert.equal(old.status, 303);
    assert.match(old.headers.get("location"), new RegExp(`^/invoices/inbox\\?project=${projectId}`));
  } finally {
    server.close();
  }
});

test.after(() => cleanupDb(process.env.DB_PATH, require("../src/db").db()));
