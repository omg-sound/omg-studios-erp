# 견적서 미리보기 오류 UX 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 청구 탭에서 견적서/내역서/거래명세서 미리보기 버튼을 항목(작업·세션) 미선택 상태로 누르면 지금은 빈 새 탭에 404처럼 보이는 400 오류 페이지가 뜬다 — 이 새 탭 자체를 열지 않고 원래 화면에서 안내하도록 바꾸고, 드물게 경합으로 새 탭이 열리는 경우엔 더 실행 가능한(닫기/돌아가기) 오류 화면을 보여준다.

**Architecture:** (1) 클라이언트 가드 — 폼 제출 시 체크된 항목이 하나도 없으면 `preventDefault`로 새 탭 자체를 막고 항목 박스를 빨간 테두리로 반짝인다. (2) 서버 폴백 — 그래도 도달하는 드문 오류(TASK_NOT_BILLABLE·CLIENT_NOT_FOUND 등 동시편집 경합)는 이 라우트 전용의 작은 오류 화면(큰 "400" 숫자 없이, [이 창 닫기]/[청구 탭으로 이동] 버튼)으로 대체한다. 공용 `errorPage()`는 무변경.

**Tech Stack:** Express(서버 렌더 HTML) · Vanilla JS(`public/js/app.js`, CSP 인라인 0) · Tailwind 클래스 · `node:test` + jsdom(`test/helpers-dom.js`)

## Global Constraints

- 공용 `errorPage()`(`src/views.js`)는 손대지 않는다 — 다른 40여 곳의 400/403/404/409 화면에 영향 주지 않는다.
- CSP: 인라인 `onclick` 등 인라인 이벤트 핸들러 금지. 새 버튼은 `data-*` 마커 + `app.js`의 위임 클릭 핸들러로 동작시킨다.
- 서버가 렌더하는 인라인 `style="…"`는 CSP `style-src`에 막혀 무시된다(함정 #27) — 치수·하이라이트는 JS가 `el.style.x = …`로 세팅해야 한다(이건 무방).
- 커밋 메시지는 한국어, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` 포함.
- 스펙 문서: `docs/superpowers/specs/2026-08-13-invoice-preview-error-ux-design.md`(이미 커밋됨) — 각 태스크는 이 문서의 해당 절을 구현한다.

---

### Task 1: 클라이언트 가드 — 항목 미선택 시 새 탭을 열지 않는다

**Files:**
- Modify: `src/views.projects.js:961` (`unbilledInvoiceForm` 내부 — 항목 목록 컨테이너에 마커 추가)
- Modify: `public/js/app.js:2916-2924` (청구처 콤보 IIFE 안의 기존 submit 가드에 분기 추가 + `flashHighlight` 헬퍼 신설)
- Test: `test/ui-interactions.test.js` (파일 끝 부근에 새 테스트 2개 추가)

**Interfaces:**
- Consumes: 없음(기존 `unbilledInvoiceForm(project, taskRows, sessionRows, opts)`, 기존 `[data-picker-combo]` submit 리스너 — 신규 의존 없음).
- Produces: `[data-invoice-items-box]` 마커(항목 목록 컨테이너, Task 2에서는 참조하지 않음 — 이 태스크 전용).

- [ ] **Step 1: 항목 목록 컨테이너에 마커 추가**

`src/views.projects.js:961`을 수정:

```js
      <div class="rounded-lg border border-border bg-surface px-3" data-invoice-items-box>${sessionList}${taskList}</div>
```

(기존: `<div class="rounded-lg border border-border bg-surface px-3">${sessionList}${taskList}</div>`)

- [ ] **Step 2: 실패하는 테스트 작성**

`test/ui-interactions.test.js` 끝에 추가(파일 상단에 이미 `const { unbilledInvoiceForm } = require("../src/views.projects");`가 있으므로 재사용):

```js
// ── 청구 항목 미선택 제출 차단(2026-08-13 사용자 리포트: 견적서 버튼이 빈 새 탭에 404 같은 오류를 띄움) ──
test("청구 생성 폼: 항목을 하나도 체크 안 하면 제출이 막히고 항목 박스가 하이라이트된다", async () => {
  const project = { id: 7, title: "테스트 프로젝트" };
  // status가 'Completed'가 아니면 체크박스가 기본 미체크로 렌더된다(대기 작업 흐리게 규칙).
  const tasks = [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Pending", total_price: 0, waived: 0 }];
  const html = unbilledInvoiceForm(project, tasks, []);
  const { win, doc } = mountDom(html);
  doc.querySelector("[data-picker-combo]").__pkSet({ cid: "999", label: "테스트 청구처" }); // 청구처는 채워 둠(항목 검사만 단독으로 확인)

  const itemsBox = doc.querySelector("[data-invoice-items-box]");
  assert.ok(itemsBox, "항목 박스 마커 존재");
  assert.equal(doc.querySelectorAll('input[type="checkbox"][data-line-amount]:checked').length, 0, "대기 작업은 기본 미체크");

  const form = doc.querySelector("[data-discount-form]");
  const ev = new win.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "submitter", { value: doc.querySelector("[data-invoice-submit]") });
  form.dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true, "항목 미선택이면 제출이 막힌다");
  assert.match(itemsBox.style.boxShadow, /rgb\(var\(--color-danger\)\)/, "항목 박스가 하이라이트된다");
  await tick(1700);
  assert.equal(itemsBox.style.boxShadow, "", "하이라이트는 시간이 지나면 사라진다");
});

test("청구 생성 폼: 항목을 하나 체크하면 제출이 막히지 않는다(회귀 방지)", () => {
  const project = { id: 7, title: "테스트 프로젝트" };
  const tasks = [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Completed", total_price: 100000, waived: 0 }];
  const html = unbilledInvoiceForm(project, tasks, []);
  const { win, doc } = mountDom(html);
  doc.querySelector("[data-picker-combo]").__pkSet({ cid: "999", label: "테스트 청구처" });

  assert.equal(doc.querySelectorAll('input[type="checkbox"][data-line-amount]:checked').length, 1, "완료 작업은 기본 체크");
  const form = doc.querySelector("[data-discount-form]");
  const ev = new win.Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "submitter", { value: doc.querySelector("[data-invoice-submit]") });
  form.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, "항목이 있으면 이 가드는 막지 않는다");
});
```

`tick`은 이미 `test/ui-interactions.test.js:10`의 `const { mountDom, fire, tick } = require("./helpers-dom");`에 포함돼 있으므로 추가 작업 불필요.

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `node --test test/ui-interactions.test.js`
Expected: 새로 추가한 두 테스트 중 첫 번째가 `assert.equal(ev.defaultPrevented, true, ...)`에서 FAIL(아직 가드가 없으므로 `defaultPrevented`가 `false`).

- [ ] **Step 4: `app.js`에 가드 구현**

`public/js/app.js:2916-2924`(청구처 콤보 IIFE, `if (form) { … form.addEventListener("submit", …) }` 블록)를 아래로 교체:

```js
      // 청구 항목 미선택 제출 차단(2026-08-13) — 견적서 등 미리보기 버튼(formtarget=_blank)이 그대로 열려
      // 빈 새 탭에 서버 오류 화면만 뜨던 문제(사용자 리포트 "404 페이지 같다"). 항목 검사를 청구처 검사보다
      // 먼저 해서 둘 다 비어 있을 때 토스트 두 개가 같은 자리에 겹쳐 뜨는 것을 막는다.
      function flashHighlight(el) {
        if (!el) return;
        el.style.transition = "box-shadow .2s";
        el.style.boxShadow = "0 0 0 3px rgb(var(--color-danger))";
        setTimeout(function () { el.style.boxShadow = ""; }, 1600);
      }
      // 청구처 미선택 제출 차단(서버도 PAYER_REQUIRED로 막지만, 여기서 바로 알려 준다).
      form.addEventListener("submit", function (e) {
        if (e.submitter && e.submitter.hasAttribute && e.submitter.hasAttribute("data-waive-btn")) return; // 청구 안 함 토글
        var itemsBox = form.querySelector("[data-invoice-items-box]");
        if (itemsBox && !itemsBox.querySelector('input[type="checkbox"][data-line-amount]:checked')) {
          e.preventDefault();
          if (window.__toast) window.__toast("청구할 항목을 하나 이상 선택하세요.");
          flashHighlight(itemsBox);
          itemsBox.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        if (!cid.value && !pid.value) {
          e.preventDefault(); // 서버도 PAYER_REQUIRED로 막지만, 여기서 즉시 알려 준다(제출 자체를 안 보냄)
          if (window.__toast) window.__toast("청구처를 선택하세요 — 실제 결제하는 곳·사람을 고릅니다.");
          input.focus();
        }
      });
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `node --test test/ui-interactions.test.js`
Expected: PASS(새로 추가한 두 테스트 포함, 기존 테스트도 전부 그대로 PASS — 특히 "청구 초안" 테스트들이 같은 submit 리스너를 건드리므로 회귀가 없는지 주의 깊게 확인).

- [ ] **Step 6: 가드레일 확인**

Run: `node --test test/guardrails-ui.test.js`
Expected: PASS — `data-invoice-items-box`가 `app.js`(querySelector)와 서버 템플릿(`views.projects.js`) 양쪽에 존재하므로 마커 계약 가드(⑧)가 자동으로 통과해야 한다. FAIL하면 마커 철자가 양쪽에서 정확히 일치하는지 확인.

- [ ] **Step 7: 커밋**

```bash
git add src/views.projects.js public/js/app.js test/ui-interactions.test.js
git commit -m "$(cat <<'EOF'
fix: 청구 생성 폼에서 항목 미선택 시 미리보기 새 탭을 열지 않고 하이라이트

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 서버 폴백 — 경합으로 새 탭이 열려도 실행 가능한 오류 화면

**Files:**
- Modify: `src/views.projects.js` (require에 `layout` 추가, `unbilledInvoiceForm` 뒤에 `invoicePreviewErrorPage` 신설, `module.exports`에 추가)
- Modify: `src/routes/projects.routes.js` (views.projects require에 `invoicePreviewErrorPage` 추가, preview 라우트의 400 catch를 새 헬퍼로 교체)
- Modify: `public/js/app.js` (전역 `[data-close-tab]` 위임 클릭 핸들러 신설)
- Test: `test/ui-interactions.test.js`(닫기 버튼 동작) · 신규 `test/invoice-preview-error.test.js`(실제 라우트 응답)

**Interfaces:**
- Consumes: Task 1과 독립적 — 공유 상태 없음.
- Produces: `invoicePreviewErrorPage(user, { message, projectId })` → HTML 문자열(다른 태스크에서 참조하지 않음, 이 라우트 전용).

- [ ] **Step 1: 실패하는 뷰 테스트 작성**

`test/ui-interactions.test.js` 파일 상단 require 목록에 `invoicePreviewErrorPage`를 추가:

```js
const { unbilledInvoiceForm, invoicePreviewErrorPage } = require("../src/views.projects");
```

파일 끝에 추가:

```js
// ── 견적서 미리보기 오류 화면: 큰 "400" 숫자 없이, 닫기/돌아가기 버튼(2026-08-13) ──
test("invoicePreviewErrorPage: 코드 숫자 없이 메시지 + 닫기/청구 탭 이동 버튼을 렌더한다", () => {
  const html = invoicePreviewErrorPage({ id: 1, email: "a@t.t", role: "chief" }, { message: "선택한 청구처를 찾을 수 없습니다.", projectId: 42 });
  assert.match(html, /선택한 청구처를 찾을 수 없습니다\./, "메시지 포함");
  assert.doesNotMatch(html, />400</, "큰 400 숫자 마크업 없음");
  assert.match(html, /data-close-tab/, "닫기 버튼 마커 포함");
  assert.match(html, /\/projects\/42\?tab=invoice/, "청구 탭 링크에 projectId 반영");
});

// ── "이 창 닫기" 버튼 클릭 시 window.close() 호출(2026-08-13) ──
test("data-close-tab 버튼 클릭 시 window.close()가 호출된다", () => {
  const html = invoicePreviewErrorPage({ id: 1, email: "a@t.t", role: "chief" }, { message: "테스트", projectId: 1 });
  const { win, doc } = mountDom(html);
  let closed = false;
  win.close = function () { closed = true; };
  fire(win, doc.querySelector("[data-close-tab]"), "click");
  assert.equal(closed, true, "닫기 버튼이 window.close()를 호출한다");
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/ui-interactions.test.js`
Expected: 새 두 테스트가 `Cannot read properties of undefined (reading ...)` 또는 `invoicePreviewErrorPage is not a function` 류로 FAIL(아직 구현 없음).

- [ ] **Step 3: `invoicePreviewErrorPage` 구현**

`src/views.projects.js` 상단의 `require("./views")` 구조분해에 `layout`을 추가:

```js
const {
  esc,
  formatKRW,
  emptyState,
  detailsChevron,
  ddayPill,
  explain,
  dirtyActionRow,
  personCombo,
  payerCombo,
  companyCombo,
  dateCombo,
  pageHeader,
  layout,
} = require("./views");
```

`unbilledInvoiceForm` 함수(1014행 `}`로 끝남) 바로 뒤, `module.exports` 앞에 추가:

```js
/**
 * 견적서/내역서/거래명세서 미리보기 라우트 전용 오류 화면(2026-08-13) — 항목 미선택은 클라이언트에서
 * 이미 막지만(app.js), 동시편집 경합(TASK_NOT_BILLABLE·CLIENT_NOT_FOUND 등)은 새 탭이 그대로 열려
 * 여기 도달한다. 공용 errorPage()는 큰 코드 숫자 + "홈으로"뿐이라 팝업 탭에서 404처럼 보였다 — 이 화면은
 * 그 대신 원인 메시지 + [이 창 닫기]/[청구 탭으로 이동]을 보여준다. 프로젝트 자체가 없는 404는 여전히
 * 공용 errorPage()를 쓴다(진짜 "이 문서가 없다"는 상황이라 기존 화면이 맞다).
 */
function invoicePreviewErrorPage(user, { message, projectId }) {
  const body = `
    <div class="mx-auto max-w-md py-16 text-center">
      <svg class="mx-auto h-10 w-10 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
      <p class="mt-4 text-base font-medium">${esc(message)}</p>
      <p class="mt-1 text-sm text-muted">이 창을 닫고 원래 화면에서 다시 시도하세요.</p>
      <div class="mt-6 flex justify-center gap-2">
        <button type="button" class="btn-primary" data-close-tab>이 창 닫기</button>
        <a href="/projects/${projectId}?tab=invoice" class="btn-ghost">청구 탭으로 이동</a>
      </div>
    </div>`;
  return layout({ title: "문서를 만들 수 없습니다", user, body });
}
```

`module.exports`에 추가(`sessionInvoicedModal,` 다음 줄):

```js
  invoicePreviewErrorPage,
```

- [ ] **Step 4: 뷰 테스트 통과 확인**

Run: `node --test test/ui-interactions.test.js`
Expected: PASS

- [ ] **Step 5: `[data-close-tab]` 전역 핸들러 추가**

`public/js/app.js` 파일 맨 위, 스크롤 위치 보존 IIFE(1~22행, `})();`로 끝남) 바로 뒤·이중 제출 방지 IIFE(24행 주석 시작) 앞에 새 IIFE 추가:

```js
// "이 창 닫기" 버튼(2026-08-13, 견적서 미리보기 오류 화면) — formtarget=_blank로 연 팝업 탭을 닫는다.
// 그 탭은 세션 히스토리가 1개뿐이라 스펙상 window.close()가 동작한다(스크립트로 연 탭과 동일 취급).
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-close-tab]");
    if (b) window.close();
  });
})();
```

- [ ] **Step 6: 닫기 버튼 테스트 통과 확인**

Run: `node --test test/ui-interactions.test.js`
Expected: PASS(Step 1의 두 번째 테스트 포함).

- [ ] **Step 7: 라우트를 새 헬퍼로 연결**

`src/routes/projects.routes.js:62-72`의 `require("../views.projects")` 구조분해에 추가:

```js
const {
  newProjectMenu,
  projectListRow,
  projectTableHead,
  projectForm,
  projectMetaCard,
  projectMetaReadonly,
  tracksSection,
  unbilledInvoiceForm,
  sessionInvoicedModal,
  invoicePreviewErrorPage,
} = require("../views.projects");
```

preview 라우트(`721`행 부근)의 catch 블록을 교체:

```js
  } catch (e) {
    const known = { PAYER_REQUIRED: "청구처를 선택하세요. 문서에 들어갈 공급받는자입니다.", TASK_IDS_REQUIRED: "문서로 만들 작업·세션을 선택하세요.", TASK_NOT_BILLABLE: "청구 가능한 작업·세션만 선택할 수 있습니다.", CLIENT_NOT_FOUND: "선택한 청구처를 찾을 수 없습니다." };
    if (!known[e.message]) throw e;
    return res.status(400).send(invoicePreviewErrorPage(req.user, { message: known[e.message], projectId: req.params.id }));
  }
```

(기존 마지막 줄: `return res.status(400).send(errorPage({ code: 400, title: "문서 오류", message: known[e.message], user: req.user }));` — 이 한 줄만 교체. 이 라우트의 다음 줄인 `if (!draft) return res.status(404)...`는 그대로 둔다 — 프로젝트 자체가 없는 404는 공용 `errorPage()` 유지.)

- [ ] **Step 8: 실패하는 라우트 테스트 작성**

새 파일 `test/invoice-preview-error.test.js` 생성(기존 `test/smoke.test.js`의 dev-login 패턴을 따르되 이 라우트 하나만 검증):

```js
"use strict";

process.env.NODE_ENV = "test";
process.env.DEV_LOGIN = "1";
process.env.PORT = String(5500 + (process.pid % 200)); // 기존 서버 테스트(3500·3600·3900·4500·4800·5000·5300대)와 겹치지 않는 새 대역
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

test("견적서 미리보기: 항목 미선택으로 요청하면 400 + 이 창 닫기/청구 탭 이동 버튼(큰 코드 숫자 없이)", async () => {
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
    // task_id/session_id를 아예 안 실어 TASK_IDS_REQUIRED를 유발(클라이언트 가드를 우회한 것과 동일 — 서버 안전망 확인).
    const res = await fetch(`${base}/projects/${projectId}/invoices/preview/견적서/x.pdf`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.status, 400, "항목 없이 요청하면 400");
    const html = await res.text();
    assert.match(html, /문서로 만들 작업·세션을 선택하세요\./, "원인 메시지 포함");
    assert.match(html, /data-close-tab/, "이 창 닫기 버튼 포함");
    assert.match(html, new RegExp(`/projects/${projectId}\\?tab=invoice`), "청구 탭 이동 링크 포함");
    assert.doesNotMatch(html, />400</, "큰 400 코드 숫자 없음(공용 errorPage 미사용)");
  } finally {
    server.close();
  }
});

test.after(() => cleanupDb(process.env.DB_PATH, require("../src/db").db()));
```

- [ ] **Step 9: 라우트 테스트 실행**

Run: `node --test test/invoice-preview-error.test.js`
Expected: PASS(Step 7까지 마쳤다면 이 시점엔 이미 통과해야 한다 — 만약 여기서 처음 작성했다면 Step 7 이전엔 `>400<` 어서션이나 `data-close-tab` 어서션에서 FAIL했을 것을 확인 후 진행).

- [ ] **Step 10: 전체 회귀 확인**

Run: `node --test test/*.test.js`
Expected: 전부 PASS. 특히 `test/guardrails-ui.test.js`(새 마커 `data-close-tab` 계약 자동 검사)와 `test/nav.test.js`(백링크 규약에 영향 없는지)를 눈여겨본다.

- [ ] **Step 11: 커밋**

```bash
git add src/views.projects.js src/routes/projects.routes.js public/js/app.js test/ui-interactions.test.js test/invoice-preview-error.test.js
git commit -m "$(cat <<'EOF'
fix: 견적서 미리보기 오류 화면을 닫기/돌아가기 가능한 형태로 교체

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## 완료 후 수동 확인 (내부 도구 특성상 자동화 어려운 부분)

실서버(로컬 `npm run dev` 등)에서:
1. 프로젝트 청구 탭 → 항목 전부 미체크 상태로 [견적서] 클릭 → 새 탭이 안 열리고 항목 박스가 빨간 테두리로 반짝이는지 확인.
2. 항목을 체크하고 청구처도 선택한 뒤 [견적서] 클릭 → 정상적으로 새 탭에 PDF가 뜨는지 확인(회귀 없음).
3. (선택, 재현 번거로우면 생략 가능) 두 탭에서 같은 항목을 동시에 청구해 TASK_NOT_BILLABLE 유도 → 새 탭에 새 오류 화면이 뜨고 [이 창 닫기]가 실제로 탭을 닫는지 확인.
