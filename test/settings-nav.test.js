"use strict";

// ── 환경설정 좌측 메뉴(2026-07-28 재설계) 계약 테스트 ──
// 9개 화면·메뉴 부제·현재 항목 표시 + 옛 탭 잔재 제거 + 화면당 저장 버튼 1개 이하(핵심 약속)는
// views.settings만 있으면 되므로 서버 없이 검증한다. 신규 통합 라우트(/alerts·/booking-defaults)의
// 원자성·권한 배선은 실제 동작이라 실서버(dev-login)로 검증한다(아래 하단 블록).
process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(5300 + (process.pid % 200)); // 다른 서버 테스트(3500·3900·4500·4800·5000대)와 포트 충돌 회피
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const V = require("../src/views.settings");

test("좌측 메뉴: 9개 항목 + 부제 + 그룹 라벨, 현재 항목 표시", () => {
  const html = V.settingsMenu("rates", 3);
  for (const [key, label] of [["rooms","장소"],["rates","요금표"],["tasks","작업 종류"],["booking","예약 기본값"],["users","스태프 계정"],["studio","스튜디오 정보"],["google","구글 연동"],["alerts","알림"],["system","시스템"]]) {
    assert.ok(html.includes(`/settings?s=${key}`), `${label} 링크`);
    assert.ok(html.includes(label), `${label} 라벨`);
  }
  for (const g of ["자주 쓰는 것", "가끔 보는 것", "한 번만 하는 것", "상태 보기"]) assert.ok(html.includes(g), `그룹 ${g}`);
  assert.ok(html.includes("룸·외부 장소") && html.includes("녹음·촬영 단가"), "항목 부제(이름만으론 내용을 모르는 문제의 해법)");
  assert.match(html, /aria-current="page"/, "현재 항목 표시");
  assert.ok(html.includes("⚠️3"), "시스템 경고 배지");
});

test("옛 탭 이름이 사용자 노출 문구에 남아 있지 않다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/settings.routes.js"), "utf8");
  assert.ok(!/SETTINGS_TABS/.test(src), "옛 탭 정의 제거");
  assert.ok(!/tab=settings|tab=content|tab=people/.test(src.replace(/TAB_MAP[\s\S]{0,200}/, "")), "옛 tab= 리다이렉트 잔재 없음(호환 매핑 제외)");
});

// ⚠️ `data-dirty-save` 마커만 세면 그 마커를 안 쓰는 화면(예약 기본값·알림·스튜디오 정보)은 **항상 0이라 무조건 통과**한다
// (최종 리뷰가 '3/6 화면에서 이 테스트가 공허하다'고 지적). 그래서 **'저장' 성격의 제출 버튼 자체**를 센다 —
// 추가·삭제·이동·업로드·테스트 발송 같은 액션 버튼은 라벨이 달라 걸리지 않고, 폼을 다시 쪼개면 즉시 실패한다.
test("화면당 값-편집 저장 버튼은 1개 이하", () => {
  const panes = { 장소: V.roomsSection(), 요금표: V.ratesPane(), "작업 종류": V.taskTypesPane(), "예약 기본값": V.bookingDefaultsSection(), 알림: V.alertsSection(true), "스튜디오 정보": V.studioInfoSection() };
  for (const [name, html] of Object.entries(panes)) {
    // <button ...>저장</button> / <button ...>통합 저장</button> — '저장'으로 끝나는 라벨만(‘분류 추가’·‘테스트 발송’ 등 제외).
    const saveButtons = (html.match(/<button[^>]*>[^<]*저장<\/button>/g) || []);
    assert.ok(saveButtons.length <= 1, `${name}: 저장 버튼 ${saveButtons.length}개(1개 이하여야 함) — ${saveButtons.join(" | ")}`);
  }
});

// 화면 골격: 9화면 모두 카드 안에 담겨야 한다. `SETTING_BLOCK`만 두른 섹션(장소·스튜디오 정보·구글 연동)은
// **바깥 카드를 호출부가 준다는 전제**라, 라우터가 안 감싸면 맨바닥에 렌더된다(재설계 첫 구현에서 기본 화면인
// 장소가 그랬고 최종 리뷰가 잡았다). 렌더 결과에 카드가 있는지로 잠근다.
test("모든 설정 화면이 카드 안에 렌더된다(맨바닥 렌더 방지)", () => {
  const wrapped = (html) => /class="[^"]*\bcard\b/.test(html);
  const selfCarded = { 요금표: V.ratesPane(), "작업 종류": V.taskTypesPane(), "예약 기본값": V.bookingDefaultsSection(), 알림: V.alertsSection(true) };
  for (const [name, html] of Object.entries(selfCarded)) assert.ok(wrapped(html), `${name}: 스스로 카드를 두른다`);
  // 아래 셋은 라우터가 감싸 준다 — 함수 자체엔 카드가 없다는 사실을 명시적으로 잠가, 나중에 누가 라우터의
  // 래퍼를 지우면 이 테스트가 '왜 감싸야 하는지'를 알려 준다.
  for (const [name, html] of Object.entries({ 장소: V.roomsSection(), "스튜디오 정보": V.studioInfoSection() })) {
    assert.ok(!wrapped(html), `${name}: 카드는 라우터가 씌운다(settings.routes.js의 card() 참조)`);
  }
});

// ── 신규 통합 라우트 회귀(리뷰 finding A) ──
// Task 2가 만든 POST /settings/booking-defaults(pro_hours·default_booker·studio_location 통합)와
// POST /settings/alerts(웹훅+이메일 통합)는 로직 자체는 옛 핸들러에서 그대로 복사했지만,
// "한 폼에 합쳐 함께 저장"이라는 조합은 이번에 새로 생긴 동작이라 검증·원자성·권한 배선을 잠근다.
test("통합 저장 라우트 회귀: /settings/alerts·/settings/booking-defaults(원자성·권한 배선)", async () => {
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('nav-chief@t.t','chief','치프',1)").run();
  db().prepare("INSERT INTO users (email, role, name, active) VALUES ('nav-staff@t.t','staff','스태프',1)").run();

  const server = require("../src/server");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const alerts = require("../src/notify");
  const mailer = require("../src/mailer");
  const { getProMinutes } = require("../src/data");
  const calendar = require("../src/calendar");

  const loginAs = async (role) => {
    const res = await fetch(base + "/dev-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body: "as=" + role,
      redirect: "manual",
    });
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")];
    return cookies.filter(Boolean).map((c) => String(c).split(";")[0]).join("; ");
  };
  const post = (cookie, p, body) =>
    fetch(base + p, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
      body,
      redirect: "manual",
    });

  try {
    const chief = await loginAs("chief");
    const staff = await loginAs("staff");

    // ① 권한 배선: 스태프는 /alerts 저장 차단(외부로 나가는 알림 채널 = 치프 전용, requireChief).
    const staffTry = await post(staff, "/settings/alerts", "webhook_url=" + encodeURIComponent("https://hooks.slack.com/services/staff-blocked") + "&alert_email=owner@omgworks.kr");
    assert.strictEqual(staffTry.status, 403, "스태프는 /alerts 저장 차단(requireChief 배선 확인)");
    assert.strictEqual(alerts.getConfiguredWebhook(), "", "차단된 요청은 저장되지 않음");

    // ② 원자성: 이메일 형식이 잘못되면, 함께 보낸 유효한 웹훅도 저장되지 않는다(검증이 저장보다 먼저).
    const bad = await post(chief, "/settings/alerts",
      "webhook_url=" + encodeURIComponent("https://hooks.slack.com/services/atomic-test") + "&alert_email=" + encodeURIComponent("owner@omgworks.kr, 이상한주소"));
    assert.strictEqual(bad.status, 302);
    const badLoc = decodeURIComponent(String(bad.headers.get("location")));
    assert.match(badLoc, /형식이 올바르지 않습니다/);
    assert.match(badLoc, /s=alerts/, "알림 화면으로 복귀");
    assert.strictEqual(alerts.getConfiguredWebhook(), "", "이메일 검증 실패 시 웹훅도 저장 안 됨(원자적 저장)");
    assert.deepStrictEqual(mailer.getRecipients(), [], "이메일도 당연히 저장 안 됨");

    // ③ 정상 입력이면 웹훅·이메일 둘 다 저장.
    const ok = await post(chief, "/settings/alerts",
      "webhook_url=" + encodeURIComponent("https://hooks.slack.com/services/atomic-ok") + "&alert_email=" + encodeURIComponent("owner@omgworks.kr"));
    assert.strictEqual(ok.status, 302);
    assert.match(decodeURIComponent(String(ok.headers.get("location"))), /s=alerts&flash=saved/);
    assert.strictEqual(alerts.getConfiguredWebhook(), "https://hooks.slack.com/services/atomic-ok");
    assert.deepStrictEqual(mailer.getRecipients(), ["owner@omgworks.kr"]);

    // ④ 권한 배선: /booking-defaults는 스태프도 저장 가능(requireStaff — 치프 전용 아님).
    const r1 = await post(staff, "/settings/booking-defaults",
      "pro_hours=4&default_booker=&studio_location=" + encodeURIComponent("OMG 스튜디오 테스트"));
    assert.strictEqual(r1.status, 302, "스태프도 예약 기본값 저장 가능(requireStaff 배선 확인)");
    assert.match(decodeURIComponent(String(r1.headers.get("location"))), /s=booking&flash=saved/);

    // ⑤ 세 값이 함께 저장됐는지(통합 폼의 핵심 약속).
    assert.strictEqual(getProMinutes(), 240, "4시간 → 240분 저장");
    assert.strictEqual(calendar.getStudioLocation(), "OMG 스튜디오 테스트", "기본 장소도 같은 제출로 저장");

    // ⑥ 잘못된 pro_hours(0·음수·문자) — 옛 /pro-minutes(git show 7f130cb)와 동일 규칙: null 저장 → 기본값(210분) 폴백.
    for (const bad of ["0", "-3", "abc"]) {
      const r = await post(chief, "/settings/booking-defaults", "pro_hours=" + encodeURIComponent(bad) + "&studio_location=유지");
      assert.strictEqual(r.status, 302);
      assert.strictEqual(getProMinutes(), 210, `pro_hours=${bad} → 기본값(210분) 폴백(옛 /pro-minutes와 동일)`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
