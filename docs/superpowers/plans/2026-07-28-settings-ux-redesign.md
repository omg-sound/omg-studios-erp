# 환경설정 UX 재설계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 환경설정을 4탭(한 탭 2~2.6화면)에서 **좌측 세로 메뉴 + 화면당 한 주제**로 바꿔, 찾기 쉽고 스크롤 없이 쓰게 만든다.

**Architecture:** 새 레이아웃을 만들지 않고 앱이 이미 쓰는 2단 골격 `contactPanes`(연락처·업체·매출·외주)를 재사용한다. 왼쪽=설정 메뉴(그룹 라벨 + 항목 + 한 줄 부제), 오른쪽=선택된 설정 한 주제. 각 화면은 제목→설명(상시)→컨트롤→하단 [변경사항 저장] 하나. 기존 섹션 렌더 함수(`roomsSection`·`contentTab` 등)는 **최대한 그대로 재배치**하고, 통합이 필요한 곳(예약 기본값·알림·스튜디오 정보)만 폼을 합친다.

**Tech Stack:** Express + 서버 렌더(`views.settings.js`·`views.contacts.js`의 `contactPanes`), Tailwind, node:test.

**스펙:** `docs/superpowers/specs/2026-07-28-settings-ux-redesign-design.md`

## Global Constraints

- **설정 값·동작은 바꾸지 않는다** — 이번은 배치·레이아웃만. 요금 계산·권한 규칙·저장 의미론 무변경.
- **기존 라우트 경로·요청 계약 불변**(`POST /settings/rooms` 등 18개) — 바뀌는 건 **리다이렉트 목적지**뿐. 기존 테스트가 그대로 통과해야 한다.
- 권한 현행 유지: 환경설정 진입 `requireStaff`, 계정 관리·웹훅은 치프 전용(스태프는 열람만·폼 숨김).
- 새 주소 `/settings?s=<key>`, 기본 `rooms`. 키: `rooms`·`rates`·`tasks`·`booking`·`users`·`studio`·`google`·`alerts`·`system`.
- 옛 `?tab=` 4종은 302 매핑: `settings`→`rooms`, `content`→`rates`, `people`→`users`, `system`→`system`.
- CSP: 서버 인라인 style/script 금지. Tailwind 임의값은 리터럴 클래스.
- 중첩 `<form>` 금지(행 액션은 `form=` 형제 폼 — 이미 적용된 패턴 유지).
- 커밋 메시지 끝 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. **배포 금지**.

---

### Task 1: 골격 — 좌측 메뉴 + 9화면 라우팅

**Files:**
- Modify: `src/routes/settings.routes.js`(GET `/` 재구성 ~L73-120)
- Modify: `src/views.settings.js`(메뉴 렌더 추가 + exports)

**Interfaces:**
- Consumes: `contactPanes`(`src/views.contacts.js`), 기존 섹션 함수 전부(`roomsSection`·`sessionDurationSection`·`defaultBookerSection`·`contentTab`·`peopleTab`·`systemTab`·`studioCalendarSection`·`driveStorageSection`·`googleContactsSection`·`studioInfoSection`·`alertWebhookSection`·`alertEmailSection`).
- Produces: `SETTINGS_NAV`(키·라벨·부제·그룹 정의)와 `settingsMenu({current, warnCount, chief})` 렌더러를 `views.settings.js`에서 export. Task 2가 화면 내용을 다듬을 때 이 키를 쓴다.

- [ ] **Step 1: 메뉴 정의·렌더러 추가** — `src/views.settings.js`에 추가(exports에도):

```js
/**
 * 환경설정 메뉴(2026-07-28 재설계) — 손 가는 순서로 그룹화. 그룹 헤더는 라벨일 뿐 클릭 대상이 아니다.
 * 각 항목의 부제는 '이름만 보고 뭐가 들었는지 모르는' 문제의 직접 해법이라 비워 두지 말 것.
 */
const SETTINGS_NAV = [
  { group: "자주 쓰는 것", items: [
    { key: "rooms", label: "장소", desc: "룸·외부 장소" },
    { key: "rates", label: "요금표", desc: "녹음·촬영 단가 + 분류" },
    { key: "tasks", label: "작업 종류", desc: "믹싱·보컬튠 등" },
    { key: "booking", label: "예약 기본값", desc: "기본 세션 시간·예약 담당자" },
  ] },
  { group: "가끔 보는 것", items: [
    { key: "users", label: "스태프 계정", desc: "로그인 허용·역할" },
    { key: "studio", label: "스튜디오 정보", desc: "사업자·로고(거래명세서)" },
  ] },
  { group: "한 번만 하는 것", items: [
    { key: "google", label: "구글 연동", desc: "캘린더·Drive·연락처" },
    { key: "alerts", label: "알림", desc: "청구 메일·웹훅" },
  ] },
  { group: "상태 보기", items: [
    { key: "system", label: "시스템", desc: "백업·연동·감사 로그" },
  ] },
];

const SETTINGS_KEYS = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.key));

/** 좌측 설정 메뉴(마스터). 연락처 이름 목록과 같은 자리·같은 조작감. */
function settingsMenu(current, warnCount = 0) {
  return SETTINGS_NAV
    .map((g) => `
      <div class="px-1 pb-1 pt-3 text-xs font-medium text-muted first:pt-1">${esc(g.group)}</div>
      ${g.items.map((i) => {
        const on = i.key === current;
        const warn = i.key === "system" && warnCount ? ` <span class="text-warning">⚠️${warnCount}</span>` : "";
        return `<a href="/settings?s=${i.key}" ${on ? 'aria-current="page"' : ""}
            class="block rounded-lg px-3 py-2 ${on ? "bg-elevated font-medium text-fg" : "text-fg/90 hover:bg-elevated/60"}">
            <span class="block text-sm">${esc(i.label)}${warn}</span>
            <span class="block text-xs text-muted">${esc(i.desc)}</span>
          </a>`;
      }).join("")}`)
    .join("");
}
```

- [ ] **Step 2: GET `/` 재구성** — `src/routes/settings.routes.js`의 GET `/` 핸들러를 다음 구조로. **옛 `SETTINGS_TABS`·`tabBar`·앵커 네비(`anchorNav`)·그룹 카드 조립 코드는 제거**한다:

```js
router.get("/", requireStaff, asyncHandler(async (req, res) => {
  // 옛 ?tab= 링크 호환(리다이렉트·북마크·코드 잔재) — 새 키로 302.
  const TAB_MAP = { settings: "rooms", content: "rates", people: "users", system: "system" };
  if (req.query.tab && TAB_MAP[req.query.tab]) {
    const q = new URLSearchParams(req.query); q.delete("tab"); q.set("s", TAB_MAP[req.query.tab]);
    return res.redirect(`/settings?${q.toString()}`);
  }
  const cur = SETTINGS_KEYS.includes(req.query.s) ? req.query.s : "rooms";
  const chief = isChief(req.user);
  const warnCount = systemWarnings().length;

  let pane;
  if (cur === "rooms") pane = roomsSection();
  else if (cur === "rates") pane = ratesPane();
  else if (cur === "tasks") pane = taskTypesPane();
  else if (cur === "booking") pane = bookingDefaultsSection();
  else if (cur === "users") pane = peopleTab(req.user);
  else if (cur === "studio") pane = studioInfoSection();
  else if (cur === "google") pane = (await studioCalendarSection(chief)) + driveStorageSection() + googleContactsSection(chief);
  else if (cur === "alerts") pane = alertsSection(chief);
  else pane = systemTab(chief);

  const left = `<div class="card p-2">${settingsMenu(cur, warnCount)}</div>`;
  const right = `<div class="space-y-3">${flashBanner(req.query)}${pane}</div>`;
  const body = `
    ${pageHeader({ title: "환경설정" })}
    ${contactPanes({ left, right, hasSelection: true, backHref: "/settings", backLabel: "환경설정", widthKey: "setListW" })}`;
  res.send(layout({ title: "환경설정", user: req.user, current: "/settings", body, wide: true }));
}));
```

⚠️ 주의:
- `contactPanes`·`flashBanner`를 이 파일 상단 require에 추가(이미 있으면 생략).
- `hasSelection: true` 고정 — 설정은 항상 뭔가 선택된 상태다(좁은 화면에서 오른쪽만 보이고, `backHref`로 메뉴로 돌아간다).
- `ratesPane`·`taskTypesPane`·`bookingDefaultsSection`·`alertsSection`은 **Task 2에서 만든다.** 이 태스크에서는 임시로 기존 함수를 그대로 부른다: `ratesPane`→`contentTab()`(요금표+작업 종류가 함께 나오지만 Task 2에서 분리), `taskTypesPane`→`contentTab()`, `bookingDefaultsSection`→`sessionDurationSection() + defaultBookerSection()`, `alertsSection(chief)`→`alertWebhookSection(chief) + alertEmailSection(chief)`. **임시 배선임을 주석으로 명시**하고 Task 2에서 교체한다.
- `pageHeader`의 `desc`("일반 · 콘텐츠 · 담당자 · 시스템")는 제거(탭이 없어졌다).

- [ ] **Step 3: 검증**

Run: `node --test test/smoke.test.js 2>&1 | tail -5`
Expected: PASS(스모크가 `/settings` 200과 역할 게이트를 확인한다).

수동 확인(임시 DB 실서버, `pkill -f "src/server.js"` 먼저): `/settings` 200 + 좌측 메뉴 9항목 렌더 + `?s=system`·`?tab=content`(→302 `?s=rates`) 동작.

- [ ] **Step 4: 커밋**

```bash
git add src/views.settings.js src/routes/settings.routes.js
git commit -m "refactor: 환경설정 좌측 세로 메뉴 골격(contactPanes 재사용) + ?s= 라우팅·옛 ?tab= 302"
```

---

### Task 2: 화면별 정리 — 분리·통합·설명 상시 노출

**Files:**
- Modify: `src/views.settings.js`
- Modify: `src/routes/settings.routes.js`(Task 1의 임시 배선 교체 + 통합 폼 라우트)

**Interfaces:**
- Consumes: Task 1의 `SETTINGS_NAV`/`settingsMenu`, 기존 섹션 함수들.
- Produces: `ratesPane()`·`taskTypesPane()`·`bookingDefaultsSection()`·`alertsSection(chief)`·`settingDesc(text)`를 export. 새 통합 라우트 `POST /settings/booking-defaults`·`POST /settings/alerts`.

- [ ] **Step 1: `settingDesc` 헬퍼 추가**(views.settings.js) — `explain()`은 앱 전체 공용이라 건드리지 않는다:

```js
/** 설정 화면 설명 — 항상 보이게(옛 explain은 <details>로 접혀 판단 정보가 클릭 뒤에 숨었다, 2026-07-28). */
function settingDesc(html) {
  return html ? `<p class="mb-3 text-sm leading-relaxed text-muted">${html}</p>` : "";
}
```

- [ ] **Step 2: 요금표·작업 종류 분리** — 현재 `contentTab()`이 둘을 한 번에 그린다. 두 함수로 쪼갠다(내용은 **그대로 옮기고** 바깥 `<section class="card space-y-4">` 래퍼와 제목만 각자 갖게):

```js
/** 요금표(단가 항목 + 분류) — 옛 contentTab의 앞부분. */
function ratesPane() { /* 기존 단가표 섹션 + rateCategoriesSection() */ }
/** 작업 종류(곡·콘텐츠 후반작업) — 옛 contentTab의 뒷부분. */
function taskTypesPane() { /* 기존 작업 종류 섹션 */ }
```

`contentTab()`은 **제거**하고 라우트의 임시 배선을 두 함수로 교체한다(테스트가 `contentTab`을 쓰면 함께 갱신).
각 화면의 `explain(...)` 호출을 `settingDesc(...)`로 바꾸되, **문구를 1~2문장으로 줄인다**(현재 설명은 상시 노출하기엔 길다 — 판단에 필요한 핵심만 남기고 세부 규칙은 덜어낸다).

- [ ] **Step 3: 예약 기본값 통합** — `sessionDurationSection()` + `defaultBookerSection()`을 `bookingDefaultsSection()` 한 폼으로. 새 라우트:

```js
// 예약 기본값 통합 저장(2026-07-28 화면당 저장 하나) — 옛 /pro-minutes·/default-booker는 계약 유지(다른 호출부 없음이나 안전상 존치).
router.post("/booking-defaults", requireStaff, (req, res) => {
  setProMinutes(req.body.pro_hours);      // 기존 /pro-minutes 핸들러 본문과 동일 로직
  setDefaultBooker(req.body.default_booker); // 기존 /default-booker 핸들러 본문과 동일 로직
  res.redirect("/settings?s=booking&flash=saved");
});
```

⚠️ 두 기존 핸들러의 **실제 본문을 확인해 그대로 옮긴다**(검증·정규화 로직이 있으면 함께). 옛 라우트는 지우지 말고 남긴다.

- [ ] **Step 4: 알림 통합** — `alertWebhookSection` + `alertEmailSection` → `alertsSection(chief)` 한 폼 + `POST /settings/alerts`. **테스트 발송 버튼(`/alert-email/test`)은 액션이라 별도 유지**. ⚠️웹훅은 치프 전용이므로 스태프에게는 그 입력만 감추고 이메일 부분은 보이게(현행 권한 유지).

- [ ] **Step 5: 스튜디오 정보 통합** — `studio-info` + `studio-location`을 한 폼으로(로고 업로드는 multipart라 별도 유지). 새 라우트 `POST /settings/studio` 또는 기존 `/studio-info`에 location 필드를 추가하는 방식 중 **더 작은 변경**을 택하고 이유를 보고서에 적어라.
  ⚠️`studio-location`이 실제로 무엇인지 코드로 확인할 것(예약 일정 기본 장소면 `booking` 화면이 맞을 수도 있다 — 확인 후 적절한 화면에 배치하고 그 판단을 보고하라).

- [ ] **Step 6: 화면당 저장 하나 점검** — 각 화면을 렌더해 **값 편집용 저장 버튼이 1개 이하**인지 확인. 추가·삭제·이동·업로드·테스트·백업·동기화는 액션이므로 개수에 포함하지 않는다.

- [ ] **Step 7: 검증**

Run: `npm test 2>&1 | tail -5`
Expected: 전부 PASS(기존 테스트가 `contentTab` 등을 참조하면 함께 갱신).

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "refactor: 환경설정 화면별 정리 — 요금표/작업 종류 분리, 예약 기본값·알림 폼 통합, 설명 상시 노출"
```

---

### Task 3: 리다이렉트 목적지 교정 + 테스트 + 문서

**Files:**
- Modify: `src/routes/settings.routes.js`(리다이렉트 ~40곳), `src/views.contacts.js:225`(`?tab=people`)
- Test: `test/settings-nav.test.js`(신규)
- Modify: `CLAUDE.md`

- [ ] **Step 1: 리다이렉트 목적지 일괄 교정** — 저장 후 **그 설정 화면에 남아야** 한다. 라우트→화면 매핑:

| 라우트 | 목적지 |
|---|---|
| `/rooms`·`/rooms/:id*` | `?s=rooms` |
| `/rate-items*`·`/rate-categories*` | `?s=rates` |
| `/task-types*` | `?s=tasks` |
| `/pro-minutes`·`/default-booker`·`/booking-defaults` | `?s=booking` |
| `/users*` | `?s=users` |
| `/studio-info`·`/studio-logo`(+`/studio-location`은 Step 5 판단에 따름) | `?s=studio` |
| `/studio-calendar`·`/resync-calendar`·`/migrate-drive`·`/push-contacts`·`/drive-check` back | `?s=google` |
| `/alert-webhook`·`/alert-email*`·`/alerts` | `?s=alerts` |
| `/backup-now` | `?s=system` |

기존 섹션 앵커(`#rooms-section`·`#rates-section`·`#task-types-section`)는 **제거**한다(화면이 한 주제라 불필요). `src/views.contacts.js:225`의 `?tab=people`도 `?s=users`로.

- [ ] **Step 2: 계약 테스트 작성** — `test/settings-nav.test.js` 신규:

```js
"use strict";

process.env.NODE_ENV = "test";
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

test("화면당 값-편집 저장 버튼은 1개 이하", () => {
  const panes = { 장소: V.roomsSection(), 요금표: V.ratesPane(), "작업 종류": V.taskTypesPane(), "예약 기본값": V.bookingDefaultsSection(), 알림: V.alertsSection(true), "스튜디오 정보": V.studioInfoSection() };
  for (const [name, html] of Object.entries(panes)) {
    const saves = (html.match(/data-dirty-save/g) || []).length;
    assert.ok(saves <= 1, `${name}: 값 편집 저장 버튼 ${saves}개(1개 이하여야 함)`);
  }
});
```

⚠️ 테스트가 부르는 함수가 export돼 있어야 한다(`roomsSection`·`ratesPane`·`taskTypesPane`·`bookingDefaultsSection`·`alertsSection`·`studioInfoSection`·`settingsMenu`). 없으면 exports에 추가.
⚠️ 셋째 테스트가 실패하면 **테스트를 고치지 말고 화면을 고쳐라**(저장 버튼 통합이 이 재설계의 핵심 약속이다). 다만 dirty 패턴을 안 쓰는 저장 버튼이 있으면 계수 방식을 실제 마크업에 맞게 조정하되, 근거를 보고서에 남길 것.

- [ ] **Step 3: 전체 테스트 + 실측**

Run: `npm test 2>&1 | tail -5` → 전부 PASS.
실측(임시 DB 실서버 + 오프스크린 iframe): 9개 화면 각각 ①1400px에서 세로 길이(목표: 대부분 1화면 ≈900px 내외 — 요금표·시스템처럼 목록이 긴 화면은 예외로 두고 수치를 보고서에 남긴다) ②390px 가로 오버플로우 0.

- [ ] **Step 4: 육안 확인** — 좌측 메뉴 + 화면 3개(장소·요금표·시스템)를 데스크톱(1400px)·모바일(390px)로 렌더해 이미지로 확인(크롬 자동화 또는 오프스크린 iframe 스크린샷). 메뉴 강조·부제·저장 버튼 위치·모바일에서 메뉴↔화면 전환이 정상인지.

- [ ] **Step 5: CLAUDE.md 현행화** — Read → Edit(부분 수정, 전체 재작성 금지). 환경설정 섹션의 **4탭 서술을 좌측 메뉴 9화면으로** 교체하고, 화면당 저장 하나·`?s=` 주소·옛 `?tab=` 302 호환·`contactPanes` 재사용을 한 문단으로. 스크린 상세는 `SCREENS.md` 이관 규칙에 따라 필요하면 그쪽에.

- [ ] **Step 6: 커밋 + push**

```bash
git add -A
git commit -m "refactor: 환경설정 리다이렉트 목적지 정리 + 메뉴 계약 테스트 + 문서 현행화"
git push -u origin <현재 브랜치>
```

(배포는 하지 않는다.)
