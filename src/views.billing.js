"use strict";

/**
 * 청구 대기함 · 청구서 작성 화면(개편 3단계, 2026-10-13 — docs/redesign/03-billing-inbox.md).
 * 대기함 = 모든 프로젝트의 미청구 세션·작업 → 골라서 → 작성 화면에서 내용·금액을 직접 기입 → 발행.
 * 무JS 동작: 대기함은 GET 폼(체크 → /invoices/new?items=…), 작성은 일반 POST. JS는 합계·줄 추가/빼기·0원 확인만.
 */

const { esc, formatKRW, pageHeader, explain, dateCombo, payerCombo, emptyState, tabBar, detailsChevron } = require("./views");
const { clientOptions, contactOptions, payerDocMeta, peekInvoiceNumber } = require("./data");
const { docNumberWithType } = require("./config");
const { formatYmdShort, todayYmd } = require("./lib/date");

/** 청구 메뉴 상단 탭(대기함 | 청구서) — 두 화면이 같은 메뉴의 두 얼굴이다. */
function billingTabs(active, count) {
  return tabBar({
    tabs: [
      { key: "inbox", label: `청구 대기${count != null ? ` ${count}` : ""}` },
      { key: "list", label: "청구서" },
    ],
    activeKey: active,
    hrefFn: (k) => (k === "inbox" ? "/invoices/inbox" : "/invoices"),
  });
}

function inboxFilterForm(f) {
  return `
    <form method="get" action="/invoices/inbox" class="mb-4 flex flex-wrap items-end gap-2">
      <label class="min-w-[12rem] flex-1"><span class="label mb-0 text-xs">검색</span>
        <input class="input mt-1 block w-full py-1.5 text-sm" type="search" name="q" value="${esc(f.q || "")}" placeholder="프로젝트 · 아티스트 · 제작/운영 · 소속" autocomplete="off" /></label>
      <div><span class="label mb-0 text-xs">기간</span>
        <div class="mt-1 flex items-center gap-1">${dateCombo("from", f.from || "", { label: "시작일", inputCls: "input w-[9rem] py-1.5 text-sm", placeholder: "시작일" })}<span class="text-muted">~</span>${dateCombo("to", f.to || "", { label: "종료일", inputCls: "input w-[9rem] py-1.5 text-sm", placeholder: "종료일" })}</div></div>
      <label class="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="past" value="1" ${f.pastOnly ? "checked" : ""} /> 지난 일정만</label>
      <label class="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="waived" value="1" ${f.showWaived ? "checked" : ""} /> 청구 안 함도 보기</label>
      ${f.projectId ? `<input type="hidden" name="project" value="${Number(f.projectId)}" />` : ""}
      <button class="btn-ghost btn-sm" type="submit">적용</button>
    </form>`;
}

/** 대기함 한 줄 — 체크박스(name=items, value=s12/t34) + 설명 + 상태 + [청구 안 함]. 금액은 없다(작성 화면에서 정한다). */
function inboxRow(it, ret) {
  const waiveAction = it.kind === "session" ? `/sessions/${it.id}/waive` : `/projects/tasks/${it.id}/waive`;
  // 날짜가 안 된(오늘 이후) 세션만 표시 — 개편 5단계부터 완료 상태가 없다(작업은 등록=수주라 늘 청구 가능).
  const statusTag = it.future ? ` <span class="text-xs font-normal text-warning">일정 전</span>` : "";
  const meta = [it.time, it.engineer].filter(Boolean).join(" · ");
  if (it.waived) {
    return `
      <div class="flex items-center justify-between gap-2 py-2 opacity-60">
        <span class="min-w-0 truncate text-sm line-through">${esc(it.label)}</span>
        <button type="submit" formaction="${waiveAction}" formmethod="post" name="return" value="${esc(ret)}" class="btn-ghost btn-xs shrink-0">되돌리기</button>
      </div>`;
  }
  return `
    <div class="flex items-start gap-2 py-2 ${it.future ? "opacity-70" : ""}" data-inbox-row>
      <input class="mt-1 shrink-0" type="checkbox" name="items" value="${esc(it.key)}" id="ib-${esc(it.key)}" ${it.future ? "data-confirm-pending" : ""} data-inbox-item />
      <label for="ib-${esc(it.key)}" class="min-w-0 flex-1 cursor-pointer">
        <span class="block text-sm font-medium">${esc(it.label)}${statusTag}</span>
        ${meta ? `<span class="block text-xs text-muted">${esc(meta)}</span>` : ""}
      </label>
      <button type="submit" formaction="${waiveAction}" formmethod="post" name="return" value="${esc(ret)}" class="btn-ghost btn-xs shrink-0 whitespace-nowrap text-muted" data-waive-btn>청구 안 함</button>
    </div>`;
}

/**
 * 청구 대기함.
 * @param {{groups:Array, count:number, postprod:Array, filters:object, ret:string}} o
 */
function inboxPage({ groups, count, postprod = [], filters = {}, ret = "/invoices/inbox" }) {
  const postprodNote = postprod.length
    ? `<div class="mb-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
        <span class="font-medium text-warning">작업을 만들어야 청구할 수 있는 후반작업 세션 ${postprod.length}건</span>
        <span class="text-muted">— 믹싱·마스터링은 세션이 아니라 작업으로 청구합니다:</span>
        ${postprod.map((p) => `<a href="/projects/${p.id}?tab=tracks" class="ml-1 text-primary hover:underline">${esc(p.title)}</a>`).join(",")}
      </div>`
    : "";
  // 프로젝트 묶음은 **기본 접힘**(2026-10-13 사용자 요청 '다 펼쳐져 있으니 정신없다') — 대기함의 일은 '어느 프로젝트를
  // 청구할지 고르기'라 첫 화면은 프로젝트 목록이고, 접힌 줄에 건수·가장 오래된 날짜를 싣는다(금액은 작성 화면에서 정하므로 없다).
  // [모두 선택]은 접힌 채로 된다(프로젝트 하나를 통째로 청구하는 게 가장 흔하다 — 접힌 묶음 안 체크도 그대로 제출된다).
  // 자동 펼침 = 한 프로젝트로 걸러 들어왔거나(프로젝트 청구 탭 링크) 묶음이 하나뿐일 때. 펼침 상태는 기억하지 않는다.
  const autoOpen = !!filters.projectId || groups.length === 1;
  const list = groups.length
    ? groups.map((g) => {
        const p = g.project;
        const sub = [p.artist, p.production_company ? `제작 ${p.production_company}` : "", p.artist_company ? `소속 ${p.artist_company}` : ""].filter(Boolean).join(" · ");
        const live = g.items.filter((i) => !i.waived);
        const selectable = live.length > 0;
        const oldest = live.map((i) => i.date).filter(Boolean).sort()[0];
        const futureN = live.filter((i) => i.future).length;
        const facts = [
          `${live.length}건`,
          oldest ? `${formatYmdShort(oldest)}부터` : "",
        ].filter(Boolean).join(" · ");
        return `
          <details class="card group p-0" data-inbox-group${autoOpen ? " open" : ""}>
            <summary class="row-link flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-[inherit] px-4 py-3 [&::-webkit-details-marker]:hidden">
              <!-- 좁은 화면: 이름은 첫 줄 전체, 건수·버튼은 둘째 줄(한 줄에 몰면 한글 이름이 음절 단위로 쪼개진다 — 함정 #28) -->
              <div class="min-w-0 basis-full break-keep sm:basis-0 sm:flex-1">
                <span class="font-medium">${esc(p.title)}</span>
                ${sub ? `<div class="truncate text-xs text-muted">${esc(sub)}</div>` : ""}
              </div>
              <span class="whitespace-nowrap text-xs text-muted tabular">${esc(facts)}${futureN ? ` · <span class="text-warning">일정 전 ${futureN}</span>` : ""}</span>
              <span class="whitespace-nowrap text-xs font-medium text-primary" data-inbox-group-count></span>
              <span class="ml-auto flex shrink-0 items-center gap-1 sm:ml-0">
                ${selectable ? `<button type="button" class="btn-ghost btn-xs" data-inbox-select-all>모두 선택</button>` : ""}
                ${detailsChevron()}
              </span>
            </summary>
            <div class="border-t border-border px-4 pb-2">
              <div class="flex justify-end pt-2"><a href="/projects/${p.id}?tab=invoice" class="text-xs text-muted hover:text-primary">프로젝트 청구 탭 ↗</a></div>
              <div class="divide-y divide-border">${g.items.map((it) => inboxRow(it, ret)).join("")}</div>
            </div>
          </details>`;
      }).join("")
    : emptyState(filters.q || filters.from || filters.to || filters.pastOnly ? "조건에 맞는 미청구 항목이 없습니다." : "청구할 항목이 없습니다. 모두 청구했어요.", { card: true });
  return `
    ${pageHeader({ title: "청구", desc: "청구할 세션·작업을 골라 청구서를 만듭니다. 여러 프로젝트를 한 청구서로 묶을 수 있습니다." })}
    ${billingTabs("inbox", count)}
    ${inboxFilterForm(filters)}
    ${postprodNote}
    <form method="get" action="/invoices/new" data-inbox-form>
      ${groups.length > 1 ? `<div class="mb-2 flex justify-end gap-3 text-xs">
        <button type="button" class="text-muted hover:text-fg" data-inbox-expand="1">모두 펼치기</button>
        <button type="button" class="text-muted hover:text-fg" data-inbox-expand="0">모두 접기</button>
      </div>` : ""}
      <div class="space-y-3">${list}</div>
      ${groups.length ? `
      <div class="sticky bottom-0 z-20 mt-4 flex items-center justify-end gap-3 border-t border-border bg-bg/95 py-3 backdrop-blur">
        <span class="text-sm text-muted" data-inbox-count>항목을 고르세요</span>
        <button class="btn-primary" type="submit" data-inbox-submit>청구서 만들기</button>
      </div>` : ""}
    </form>`;
}

/** 청구처 추천 칩 — 고른 항목들이 속한 프로젝트의 당사자 전부(제작/운영·소속·아티스트, 중복 제거). */
function payerSuggestChipsFor(projects) {
  const seen = new Set();
  const chips = [];
  for (const p of projects) {
    for (const c of [
      { id: p.production_id, role: "제작/운영", name: p.production_company },
      { id: p.agency_id, role: "소속/레이블", name: p.artist_company },
      { id: p.artist_id, role: "아티스트", name: String(p.artist || "").split(",")[0].trim() },
    ]) {
      if (!c.id || !c.name || seen.has(Number(c.id))) continue;
      seen.add(Number(c.id));
      chips.push(c);
    }
  }
  if (!chips.length) return "";
  return `<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-muted">추천:</span>
      ${chips.map((c) => `<button type="button" class="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary"
           data-payer-suggest="${Number(c.id)}" data-payer-suggest-name="${esc(c.name)}">${esc(c.role)} ${esc(c.name)}</button>`).join("")}
    </div>`;
}

/** 작성 화면 한 줄. kind=session/task는 대기함 항목(설명·금액만 고침), free는 자유 줄(날짜도). */
function composeLine(l, i) {
  const free = l.kind === "free";
  const dateCell = free
    ? `<input class="input w-full py-1.5 text-sm" type="text" name="line_date" value="${esc(l.date || "")}" placeholder="날짜(선택)" aria-label="날짜" autocomplete="off" />`
    : `<input type="hidden" name="line_date" value="" /><span class="text-sm text-muted tabular">${l.date ? esc(formatYmdShort(l.date)) : "—"}</span>`;
  return `
    <div class="grid grid-cols-[minmax(0,1fr)_6.5rem_2rem] items-center gap-x-2 gap-y-1 border-b border-border/50 py-1.5 sm:grid-cols-[4.5rem_minmax(0,1fr)_8rem_2rem] sm:border-0" data-compose-line>
      <input type="hidden" name="line_kind" value="${esc(l.kind)}" />
      <input type="hidden" name="line_id" value="${l.id ? Number(l.id) : ""}" />
      <div class="col-span-3 sm:col-span-1">${dateCell}</div><!-- 모바일은 날짜를 한 줄 위로(좁은 폭에서 내용 칸이 짜부라지지 않게) -->
      <input class="input w-full py-1.5 text-sm" name="line_desc" value="${esc(l.description != null ? l.description : l.label || "")}" placeholder="${free ? "예: 계약금 · 출장비" : ""}" aria-label="내용" autocomplete="off" />
      <input class="input w-full py-1.5 text-right text-sm tabular" name="line_amount" inputmode="numeric" value="${l.amount != null && l.amount !== "" ? esc(String(l.amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")) : ""}" placeholder="금액" aria-label="금액" data-compose-amount />
      <button type="button" class="btn-ghost px-2.5 text-muted hover:text-danger" title="이 줄 빼기" aria-label="이 줄 빼기" data-compose-remove>✕</button>
    </div>`;
}

/**
 * 청구서 작성.
 * @param {{lines:Array, projects:Array, values?:object, error?:string, skipped?:number}} o
 *   lines = [{kind, id, label|description, date, amount, future}] (자유 줄은 kind='free')
 */
function composePage({ lines, projects, values = {}, error = "", skipped = 0 }) {
  const issued = values.issued_date || todayYmd();
  const one = projects.length === 1 ? projects[0] : null;
  const defaultTitle = values.title != null ? values.title : one ? `${one.title} 청구` : "";
  const base = peekInvoiceNumber(issued);
  const act = (t) => `/invoices/preview/${encodeURIComponent(t)}/${encodeURIComponent(docNumberWithType(base, t))}.pdf`;
  const freeTemplate = composeLine({ kind: "free" }, 0);
  return `
    ${pageHeader({ title: "청구서 작성", desc: "내용과 금액을 직접 적습니다. 줄을 빼면 그 항목은 청구 대기함에 남습니다." })}
    ${billingTabs("inbox")}
    ${error ? `<p class="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(error)}</p>` : ""}
    ${skipped ? `<p class="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">이미 청구됐거나 청구할 수 없는 항목 ${skipped}건은 뺐습니다.</p>` : ""}
    <form method="post" action="/invoices" class="card space-y-4" data-compose-form>
      <button type="submit" disabled hidden aria-hidden="true"></button><!-- 엔터=암묵 제출이 첫 버튼(미리보기)을 열지 않게 -->
      <input type="hidden" name="confirm_zero_amount" value="0" data-compose-zero />
      <div>
        <label class="label mb-1 text-xs">청구처 <span class="font-normal text-danger">*</span></label>
        ${payerCombo({ selectedId: values.client_id ? Number(values.client_id) : null, clientOptions: clientOptions(), contactOptions: contactOptions(), ...payerDocMeta() })}
        ${payerSuggestChipsFor(projects)}
        <div data-payer-fix class="mt-1.5 hidden rounded-lg bg-warning/10 px-3 py-2">
          <p data-payer-warn class="text-sm text-warning"></p>
          <div data-payer-tax-toggle class="mt-2 hidden flex gap-4">
            <label class="flex items-center gap-1 text-sm"><input type="radio" name="inline_tax_type" value="cash" checked> 현금영수증 (개인)</label>
            <label class="flex items-center gap-1 text-sm"><input type="radio" name="inline_tax_type" value="biz"> 세금계산서 (사업자)</label>
          </div>
          <div class="mt-2 flex gap-2">
            <input type="text" data-payer-fix-input class="input flex-1 py-1.5 text-sm" autocomplete="off" />
            <button type="button" data-payer-fix-btn class="btn-primary btn-sm shrink-0">입력</button>
          </div>
          <p class="mt-1 text-xs text-muted">여기에 입력하면 청구처 정보에 저장됩니다.</p>
        </div>
        <div data-payer-email-row class="mt-1.5 hidden">
          <label class="label mb-0 text-xs">세금계산서 발행 이메일<input class="input mt-1 block py-1.5 text-sm" type="text" name="payer_email" inputmode="email" autocomplete="off" data-payer-email /></label>
          <input type="hidden" name="payer_email_set" value="0" data-payer-email-set />
          ${explain("이번 청구서에만 적용됩니다 — 청구처 정보는 바뀌지 않습니다.")}
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label class="label mb-0 text-xs">제목<input class="input mt-1 block" name="title" value="${esc(defaultTitle)}" placeholder="비우면 '{청구처} {월}월 청구'" /></label>
        <div><span class="label mb-0 text-xs">발행일</span><div class="mt-1">${dateCombo("issued_date", issued, { label: "발행일", inputCls: "input w-full" })}</div></div>
      </div>
      <div>
        <div class="hidden grid-cols-[4.5rem_minmax(0,1fr)_8rem_2rem] gap-2 border-b border-border pb-1 text-xs text-muted sm:grid"><span>날짜</span><span>내용</span><span class="text-right">금액</span><span></span></div>
        <div data-compose-lines>${lines.map(composeLine).join("")}${composeLine({ kind: "free" }, lines.length)}</div>
        <template data-compose-free-template>${freeTemplate}</template>
        <button type="button" class="btn-ghost btn-xs mt-1" data-compose-add>+ 줄 추가</button>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-1 text-xs">할인</label>
          <div class="flex gap-2">
            <div class="relative flex-1"><input class="input py-1.5 pr-8 text-sm" inputmode="numeric" name="discount_amount" value="${esc(values.discount_amount || "")}" placeholder="0" data-compose-discount /><span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">원</span></div>
            <div class="relative w-24"><input class="input py-1.5 pr-6 text-sm" inputmode="decimal" name="discount_pct" value="${esc(values.discount_pct || "")}" placeholder="0" data-compose-pct /><span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted">%</span></div>
          </div>
        </div>
        <div class="rounded-lg border border-border bg-surface p-3">
          <div class="flex items-center justify-between text-sm"><span class="text-muted">공급가</span><span class="font-medium tabular" data-compose-supply>₩0</span></div>
          <div class="mt-1 flex items-center justify-between text-sm" data-compose-discount-row hidden><span class="text-muted">할인</span><span class="font-medium tabular text-danger" data-compose-discount-amt></span></div>
          <label class="mt-1.5 flex cursor-pointer items-center justify-between text-sm">
            <span class="flex items-center gap-1.5"><input type="checkbox" name="vat_included" value="1" ${values.vat_included === undefined || values.vat_included ? "checked" : ""} data-compose-vat /> 부가세(VAT 10%) 포함</span>
            <span class="font-medium tabular" data-compose-tax>₩0</span>
          </label>
          <div class="mt-1.5 flex items-center justify-between border-t border-border pt-1.5 text-base font-bold"><span>총 금액</span><span class="tabular" data-compose-total>₩0</span></div>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div class="flex flex-wrap gap-2">
          <button class="btn-ghost" type="submit" formmethod="get" formaction="${act("견적서")}" formtarget="_blank">견적서</button>
          <button class="btn-ghost" type="submit" formmethod="get" formaction="${act("내역서")}" formtarget="_blank">내역서</button>
          <button class="btn-ghost" type="submit" formmethod="get" formaction="${act("거래명세서")}" formtarget="_blank">거래명세서</button>
        </div>
        <div class="flex items-center gap-2">
          <a href="/invoices/inbox" class="btn-ghost">취소</a>
          <button class="btn-primary" type="submit" data-compose-submit>청구서 발행 <span data-inv-doc>(계산서 발행)</span></button>
        </div>
      </div>
    </form>`;
}

/**
 * 프로젝트 '청구' 탭의 미청구 요약(개편 3단계 — 청구서는 대기함에서만 만든다: 경로가 둘이면 규칙이 갈린다).
 * 항목 목록 + [이 프로젝트 항목으로 청구서 만들기](대기함을 이 프로젝트로 걸러 연다).
 */
function projectBillingSummary({ project, items = [], postprod = false }) {
  if (project.internal_support) return `<div class="rounded-lg border border-border bg-bg px-3 py-3 text-sm text-muted">내부 지원 프로젝트 — 청구 대상이 아닙니다.</div>`;
  const live = items.filter((i) => !i.waived);
  const note = postprod ? `<p class="mt-2 text-xs text-warning">믹싱·마스터링 세션이 있지만 작업이 없습니다 — 작업 탭에서 작업을 만들어야 청구할 수 있습니다.</p>` : "";
  if (!live.length) return `<div class="rounded-lg border border-border bg-bg px-3 py-3 text-center text-sm text-muted">청구할 세션·작업이 없습니다.</div>${note}`;
  const rows = live.slice(0, 8).map((i) => `<li class="flex items-center justify-between gap-2"><span class="min-w-0 truncate">${esc(i.label)}${i.future ? ` <span class="text-xs text-warning">일정 전</span>` : ""}</span></li>`).join("");
  const more = live.length > 8 ? `<li class="text-xs text-muted">외 ${live.length - 8}건</li>` : "";
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">미청구 ${live.length}건</h3>
        <a href="/invoices/inbox?project=${project.id}" class="btn-primary btn-sm">이 프로젝트 항목으로 청구서 만들기</a>
      </div>
      <ul class="space-y-1 text-sm">${rows}${more}</ul>
      ${note}
      <p class="mt-2 text-xs text-muted">여러 프로젝트를 한 청구서로 묶으려면 <a href="/invoices/inbox" class="text-primary hover:underline">청구 대기함</a>에서 고르세요.</p>
    </div>`;
}

/**
 * 미리보기 PDF 오류 화면 — 미리보기는 새 탭으로 열리므로 공용 errorPage(큰 코드 + 홈으로) 대신
 * 원인 + [이 창 닫기]/[청구 대기함으로]를 보여 준다(2026-08-13 사용자 리포트 '404 같다'의 해법을 이어받음).
 */
function invoicePreviewErrorPage(user, message) {
  const { layout } = require("./views");
  const body = `
    <div class="mx-auto max-w-md py-16 text-center">
      <h1 class="text-base font-medium">${esc(message)}</h1>
      <p class="mt-1 text-sm text-muted">이 창을 닫고 작성 화면에서 고친 뒤 다시 시도하세요.</p>
      <div class="mt-6 flex justify-center gap-2">
        <button type="button" class="btn-primary" data-close-tab>이 창 닫기</button>
        <a href="/invoices/inbox" class="btn-ghost">청구 대기함으로</a>
      </div>
    </div>`;
  return layout({ title: "문서를 만들 수 없습니다", user, body });
}

module.exports = { inboxPage, composePage, billingTabs, projectBillingSummary, invoicePreviewErrorPage };
