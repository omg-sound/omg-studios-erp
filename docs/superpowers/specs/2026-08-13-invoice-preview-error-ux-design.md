# 견적서 미리보기 오류 UX 개선 — 설계

- 요청일: 2026-08-13 (사용자 — 스크린샷으로 리포트: "이게 너무 404 페이지 오류 같다")
- 상태: 설계 승인됨 — 구현 전
- 관련 코드: `src/routes/projects.routes.js`(`/:id/invoices/preview/:type/:name`) · `src/data/invoices.js`(`computeInvoiceDraft`) · `src/views.projects.js`(`unbilledInvoiceForm`) · `public/js/app.js`(청구처 콤보 submit 가드) · `src/views.js`(`errorPage`, 손대지 않음)

## 1. 무엇을 바꾸나

프로젝트 청구 탭의 "청구 생성" 폼에서 **견적서/내역서/거래명세서 미리보기 버튼**(`formtarget="_blank"`)을 항목(작업·세션)을 하나도 체크하지 않은 채 누르면, 새 탭이 열리고 공용 `errorPage()`(큰 "400" 숫자 + "홈으로")가 뜬다. 사용자에겐 이게 죽은 링크를 밟은 404처럼 보인다.

두 가지를 고친다:

1. **항목 미선택은 애초에 새 탭을 열지 않는다** — 클릭 시점에 클라이언트에서 막고, 원래 화면의 항목 박스를 하이라이트한다.
2. **그래도 새 탭이 열리는 드문 경우**(동시편집으로 그 사이 항목이 청구되거나 청구처가 삭제된 경우)엔, 이 라우트 전용의 더 작고 실행 가능한 에러 화면을 보여준다.

범위는 **프로젝트 청구 탭의 이 폼 하나**로 한정한다. 공용 `errorPage()`는 앱 전역 40여 곳에서 쓰이므로 건드리지 않는다.

## 2. 지금 구조 (바꾸기 전)

```
unbilledInvoiceForm() 렌더
  ├─ 항목 체크박스 목록(작업·세션)         ← 체크 안 해도 막는 코드 없음
  ├─ [견적서] [내역서] [거래명세서]  formtarget="_blank" formmethod=get
  └─ [청구 생성]                     기본 submit

app.js 기존 submit 가드 (같은 폼, 서로 다른 IIFE)
  ├─ 0원 항목 확인창 — formtarget=_blank면 건너뜀(의도적, 미리보기는 참고용이라)
  └─ 청구처 미선택 → preventDefault + 토스트 + input.focus()
       (항목 미선택에 대응하는 가드가 없다)

서버 computeInvoiceDraft()
  └─ selectedTasks/selectedSessions 둘 다 비면 throw TASK_IDS_REQUIRED
       → 라우트가 errorPage({code:400, title:"문서 오류", message:"문서로 만들 작업·세션을 선택하세요."})
       → 사이드바 포함한 정식 레이아웃 + 큰 "400" 숫자 + "홈으로" 버튼만
```

`청구처 미선택`은 이미 클릭 전에 막히므로 새 탭이 안 열린다. `항목 미선택`만 가드가 빠져 있어 스크린샷처럼 새 탭이 뜬 채로 사용자가 오류를 마주친다.

## 3. 설계

### 3.1 클라이언트 가드 — 항목 미선택은 새 탭을 열지 않는다

`unbilledInvoiceForm()`(`src/views.projects.js`)의 항목 목록 컨테이너에 마커를 추가한다:

```html
<div class="rounded-lg border border-border bg-surface px-3" data-invoice-items-box>
  ${sessionList}${taskList}
</div>
```

`app.js`의 기존 "청구처 미선택 차단" 리스너(청구처 콤보 IIFE, `form.addEventListener("submit", …)` — `public/js/app.js:2917` 부근)에 **분기를 하나 추가**한다. 새 리스너를 따로 만들지 않고 기존 리스너에 얹는 이유는, 두 조건(항목·청구처)이 모두 비어 있을 때 토스트 두 개가 같은 자리(`fixed left-1/2 top-4`)에 겹쳐 뜨는 것을 막기 위해서다 — 항목 체크를 먼저 검사하고, 걸리면 그 자리에서 return(청구처 검사는 안 감):

```js
form.addEventListener("submit", function (e) {
  if (e.submitter && e.submitter.hasAttribute && e.submitter.hasAttribute("data-waive-btn")) return;
  var itemsBox = form.querySelector("[data-invoice-items-box]");
  if (itemsBox && !itemsBox.querySelector('input[type="checkbox"][data-line-amount]:checked')) {
    e.preventDefault();
    if (window.__toast) window.__toast("청구할 항목을 하나 이상 선택하세요.");
    flashHighlight(itemsBox);
    itemsBox.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (!cid.value && !pid.value) {
    e.preventDefault();
    if (window.__toast) window.__toast("청구처를 선택하세요 — 실제 결제하는 곳·사람을 고릅니다.");
    input.focus();
  }
});
```

`flashHighlight(el)`은 이 IIFE 안에 작은 헬퍼로 추가한다 — 기존에 청구처 발행정보 저장 성공 시 쓰는 패턴(`fixBtn.style.boxShadow = "0 0 0 4px rgba(74,222,128,0.7)"`, `app.js:2846`)과 동일한 방식(JS로 `el.style.boxShadow` 세팅 — CSP `style-src`는 서버가 렌더한 인라인 `style=` 속성만 막고 JS의 스타일 프로퍼티 세팅은 막지 않는다, 함정 #27)이되 색은 danger로:

```js
function flashHighlight(el) {
  el.style.transition = "box-shadow .2s";
  el.style.boxShadow = "0 0 0 3px rgb(var(--color-danger))";
  setTimeout(function () { el.style.boxShadow = ""; }, 1600);
}
```

**적용 범위**: 이 가드는 폼 전체의 `submit` 이벤트에 걸리므로 견적서/내역서/거래명세서 미리보기 버튼과 "청구 생성" 버튼 모두에 자동으로 적용된다(제출 버튼이 다를 뿐 같은 `<form>`이라 이벤트가 같다). "청구 생성"도 지금까지는 항목 없이 누르면 현재 탭이 그대로 서버 에러 페이지로 바뀌었는데(팝업은 아니지만 폼 상태가 날아가는 건 마찬가지), 이 가드로 함께 해결된다.

### 3.2 서버 폴백 — 그래도 새 탭이 열리는 경우 더 친절한 화면

동시편집 경합(TASK_NOT_BILLABLE·CLIENT_NOT_FOUND — 클릭 시점엔 유효했지만 서버 처리 중 상태가 바뀐 경우)은 클라이언트 가드로 막을 수 없다. 이 라우트(`GET /:id/invoices/preview/:type/:name`)의 에러 응답만 전용 헬퍼로 바꾼다.

`views.projects.js`에 `invoicePreviewErrorPage(user, { message, projectId })`를 추가(같은 파일에 `layout`을 새로 require):

```js
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

- 큰 "400" 숫자를 없앤다(404와 헷갈리게 만드는 요소) — 대신 작은 경고 아이콘.
- 기존 `known[e.message]` 문구(`"문서로 만들 작업·세션을 선택하세요."` 등)는 그대로 재사용 — 이미 원인을 명확히 말해주는 문장이라 바꿀 필요 없음.
- **[이 창 닫기]**: `app.js`에 위임 클릭 핸들러 추가 — `document.addEventListener("click", function(e){ var b = e.target.closest("[data-close-tab]"); if (b) window.close(); })`. `formtarget="_blank"`로 열려 그 탭의 세션 히스토리가 1개뿐이므로 스펙상 `window.close()`가 동작한다.
- **[청구 탭으로 이동]**: "홈으로"보다 실질적인 목적지 — 원래 있던 프로젝트의 청구 탭으로 데려가 바로 재시도할 수 있게 한다. `window.close()`가 브라우저 정책으로 막히는 경우의 자연스러운 대안이기도 하다.

`projects.routes.js`의 preview 라우트(`721`행 부근)에서 `errorPage(...)` 대신 이 헬퍼를 쓴다:

```js
} catch (e) {
  const known = { PAYER_REQUIRED: "…", TASK_IDS_REQUIRED: "…", TASK_NOT_BILLABLE: "…", CLIENT_NOT_FOUND: "…" };
  if (!known[e.message]) throw e;
  return res.status(400).send(invoicePreviewErrorPage(req.user, { message: known[e.message], projectId: req.params.id }));
}
```

`404`(프로젝트 자체가 없는 경우, `draft` 자체가 null)는 그대로 공용 `errorPage()`를 쓴다 — 그건 실제로 "이 문서 자체가 없다"는 상황이라 기존 404 화면이 맞다.

## 4. 손대는 곳

| 파일 | 변경 |
|---|---|
| `src/views.projects.js` | 항목 박스에 `data-invoice-items-box` 추가 · `invoicePreviewErrorPage()` 신설 + export · `layout` require 추가 |
| `src/routes/projects.routes.js` | preview 라우트의 400 응답을 `invoicePreviewErrorPage()`로 교체 |
| `public/js/app.js` | 청구처 콤보 submit 가드에 항목 미선택 분기 + `flashHighlight()` 헬퍼 추가 · `[data-close-tab]` 위임 클릭 핸들러 신설 |

`errorPage()`(`src/views.js`)는 무변경 — 다른 40여 곳의 400/403/404/409 화면에 영향 없음.

## 5. 검증 계획

1. **jsdom 상호작용**(`test/ui-interactions.test.js`): 항목 미체크 상태로 폼 제출 → `preventDefault` 호출됨(`e.defaultPrevented`) 확인, `itemsBox.style.boxShadow`가 일시적으로 세팅됨, 토스트 호출 확인. 항목을 체크한 뒤 제출하면 막히지 않음(회귀 방지). 청구처만 비어 있을 때 항목 토스트가 안 뜨는 것도 함께 확인(우선순위 검증).
2. **가드레일**(`test/guardrails-ui.test.js` 기존 마커 계약이 자동 검사): `data-invoice-items-box`·`data-close-tab`이 서버 템플릿과 app.js 양쪽에 존재하는지는 기존 가드 ⑧이 이미 잡아준다 — 별도 테스트 불필요.
3. **라우트 테스트**(`test/invoice-*.test.js` 계열에 추가): 항목·세션 없이 `GET /:id/invoices/preview/견적서/x.pdf` 요청 → 400, 응답 본문에 `이 창 닫기`·`청구 탭으로 이동` 포함, `>400<` 같은 큰 코드 숫자 마크업 없음. 프로젝트 자체가 없는 경우엔 여전히 기존 404 마크업(홈으로) 확인.
4. **실브라우저 확인**(내부 도구 특성상 자동화 어려움): 견적서 버튼을 항목 미체크로 클릭 → 새 탭이 안 열리고 원래 화면에 빨간 테두리 반짝임 확인. 두 탭에서 같은 작업을 동시에 청구해 경합을 재현 → 새 탭에서 새 에러 화면 확인 → [이 창 닫기]가 실제로 탭을 닫는지 확인.

## 6. 안 하는 것

- 공용 `errorPage()`(다른 400/403/404/409 화면) 리디자인 — 이번 요청 범위 밖, 필요해지면 별도 논의.
- 청구처 미선택 케이스에 하이라이트 추가 — 이미 `input.focus()`로 단일 입력 필드에 초점이 가 있어 충분하다고 판단(항목 목록처럼 "포커스할 단일 요소가 없는" 경우에만 시각적 하이라이트가 필요).
- 동시편집 경합 자체를 막는 낙관적 잠금 등 — 발생 빈도가 매우 낮고(같은 항목을 동시에 두 탭에서 청구하는 경우) 이번 요청은 UX 개선이지 데이터 정합성 이슈가 아니다.
