"use strict";

/** 프로젝트 상세/목록 렌더 — projects.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션과 동일). */

const { TASK_STATUS_LABELS, TASK_STATUS_BADGE, docNumberWithType } = require("./config");
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
const { formatYmdShort, todayYmd, kstYmd } = require("./lib/date");
const {
  clientOptions,
  contactOptions,
  listProjectContacts,
  partyOptions,
  getParty,
  listProjectManagers,
  activeTaskTypes,
  taskTypeLabel,
  taskTypeUnitPrice,
  payerDocMeta,
  peekInvoiceNumber,
  listGroupsForPicker,
} = require("./data");

/** 목록 상단 버튼 — 개편 1단계(2026-10-13)부터 '새 프로젝트' 대신 빠른 생성(/new). 프로젝트는 이름을 쓰면 자동 생성된다. */
function newProjectMenu() {
  return `<a href="/new?return=%2Fprojects" class="btn-primary ml-auto">+ 새로 만들기</a>`;
}


/**
 * 다음 방문(다가오는 세션) 한 줄 — `listProjects`가 파생하는 next_session_date(오늘 이후·취소 제외 최소일).
 * 임박(D-3 이내)하면 브랜드색으로 강조해 "다음 방문이 언제인지"를 목록에서 바로 파악.
 */
function nextSessionLine(p) {
  if (!p.next_session_date) return "";
  // 디데이만 임박도 색 단계로 강조(2026-07-11 사용자 요청 — PM 밑, 디데이만 눈에 띄게): 공용 ddayPill(views.js).
  // 3일 이내=빨강 / 2주 이내=주황 / 그 외=흐린 회색(멀리·뒤로 물러남). 옅은 보더 pill·크게(text-sm).
  return `<span class="proj-next inline-flex items-center gap-1.5 text-xs text-muted">
    <span>${esc(formatYmdShort(p.next_session_date))}</span>
    ${ddayPill(p.next_session_date)}
  </span>`;
}


/** 프로젝트의 항목(트랙) 개수. track_titles("||" 연결)에서 파생. */
function trackCount(p) {
  if (!p || !p.track_titles) return 0;
  return String(p.track_titles).split("||").map((s) => s.trim()).filter(Boolean).length;
}


/** 카드 정체성 줄: "아티스트 · 회사". 회사가 아티스트 본인으로 파생된 경우 아티스트만. 여러 아티스트면 "외 N". 둘 다 없으면 null(→ 제목 승격). */
function projectIdentity(p) {
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  let artistPart = "";
  if (artists.length === 1) artistPart = artists[0];
  else if (artists.length > 1) artistPart = `${artists[0]} 외 ${artists.length - 1}`;
  const company = String(p.client_name || "").trim();
  const parts = [];
  if (artistPart) parts.push(artistPart);
  if (company && company !== artistPart && !artists.includes(company)) parts.push(company);
  return parts.length ? parts.join(" · ") : null;
}


/**
 * 목록 카드 → 상세 진입 탭(2026-07-14 사용자 요청 — "어차피 그거 보러 들어가는 것"):
 *  - 청구 필요 탭  → 청구 탭 직행
 *  - 진행 중 탭    → 세션 일정. 세션이 하나도 없고 곡·콘텐츠만 있으면 곡·콘텐츠 탭.
 *  - 완료 탭·그 외 → 기본(정보 탭)
 * 청구 탭은 canBill(치프·대표·스태프=전원)이라 권한으로 막히지 않는다.
 */
function projectRowHref(p, tab, listQuery = "") {
  const base = `/projects/${p.id}`;
  // 상세 백링크가 **보던 목록(탭·검색·내 프로젝트만)** 으로 돌아오도록 복귀 경로를 실어 보낸다
  // (2026-07-14 사용자 요청 — 완료 탭에서 들어갔다가 나오면 진행 중 탭으로 떨어지던 것). 청구 상세 return과 동일 패턴.
  const ret = listQuery ? `return=${encodeURIComponent(listQuery)}` : "";
  const with_ = (qs) => (qs ? `${base}?${qs}${ret ? `&${ret}` : ""}` : ret ? `${base}?${ret}` : base);
  if (tab === "billing") return with_("tab=invoice");
  if (tab === "active") {
    if (Number(p.sess_cnt) > 0) return with_("tab=sessions");
    if (trackCount(p) > 0) return with_("tab=tracks");
  }
  return with_("");
}


/** 아티스트 열(지메일의 '보낸사람') — 여러 명이면 "외 N", 아티스트가 없으면 회사, 둘 다 없으면 제목. */
function projectArtistLabel(p) {
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (artists.length === 1) return artists[0];
  if (artists.length > 1) return `${artists[0]} 외 ${artists.length - 1}`;
  const company = String(p.client_name || "").trim();
  return company || String(p.title || "제목 없음");
}

/** 부제 열(지메일의 '제목·미리보기') — "제작사 · 프로젝트명". 아티스트 열이 이미 그 값이면 그 조각은 생략. */
function projectSubLabel(p) {
  const head = projectArtistLabel(p);
  const company = String(p.client_name || "").trim();
  const title = String(p.title || "").trim();
  const artists = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  const parts = [];
  if (company && company !== head && !artists.includes(company)) parts.push(company);
  if (title && title !== head) parts.push(title);
  return parts.join(" · ");
}


/** 아티스트만(폴백 없음) — 표의 아티스트 열용. 여러 명이면 "외 N", 없으면 빈 문자열(제작사·프로젝트명은 별도 열). */
function projectArtistOnly(p) {
  const a = String(p.artist || "").split(",").map((s) => s.trim()).filter(Boolean);
  return a.length > 1 ? `${a[0]} 외 ${a.length - 1}` : a[0] || "";
}

/**
 * 프로젝트 목록 표 헤더(2026-07-16 사용자 요청 — 청구 표처럼 항목명·칸칸이). 각 행 summary와 같은 grid 열.
 * 컬럼: 아티스트 · 제작사 · 프로젝트 · PM · 다음 세션 · 금액 · 작성일 · [⌄].
 */
function projectTableHead() {
  // 헤더 클래스(pt-h-pm/amount/created)는 좁을 때 해당 열을 행 셀과 함께 CSS로 숨기기 위함.
  // 열 순서 = 제작사 → 아티스트(2026-07-20 사용자 요청으로 맞바꿈).
  // **항목명 클릭 = 정렬**(2026-07-20 사용자 요청): 청구 목록과 같은 공용 코어(app.js wireSortHeaders)를 쓴다.
  // key는 행 셀의 data-sort-key와 짝이고(인덱스가 아니라 key로 찾으므로 열이 숨어도 안전), type은 비교 방식.
  // ⚠️`aria-sort`는 columnheader/rowheader/gridcell 롤에서만 유효하다 — role="button"에 붙이면 화살표는
  // 보이는데 **정렬 상태가 음성으로 안 읽힌다**(2026-07-20 메인터넌스). 헤더 줄을 표 시맨틱으로 올린다
  // (청구 목록은 진짜 <th>라 원래 정상이었다). 시각·CSS는 그대로.
  const th = (label, key, type = "text", cls = "") =>
    `<span class="pt-h pt-sortable ${cls}" data-sort-key="${key}" data-sort-type="${type}" role="columnheader" tabindex="0" aria-sort="none">${esc(label)}<span class="pt-sort-arrow" aria-hidden="true"></span></span>`;
  // 작성일이 맨 앞(2026-07-20 사용자 요청). 좁아지면 여전히 **작성일부터** 숨는다(자리만 앞으로 온 것).
  return `<div class="proj-thead" role="row">${th("작성일", "created", "date", "pt-h-created")}${th("제작사", "company")}${th("아티스트", "artist")}${th("프로젝트", "title")}${th("PM", "pm", "text", "pt-h-pm")}${th("다음 세션", "next", "date")}${th("금액", "amount", "num", "pt-h-amount")}<span aria-hidden="true"></span></div>`;
}

/**
 * 목록 행(2026-07-16 청구 표식 재설계 — 컬럼 정렬 + 항목명 헤더 + 작성일 열, 밀도 토글 폐지).
 *  - `<details>` 한 벌: summary=grid 셀(헤더와 같은 열).
 *  - **행 전체가 이동 링크**(2026-07-18 사용자 요청 — 모든 데이터 셀이 `projectRowHref`로 가는 `<a>`, 셀별 밑줄·색강조 없음·어포던스는 행 배경 호버만).
 *    `<summary>` 안의 `<a>`는 클릭 시 이동만 하고 토글 안 함(브라우저 기본), 유일하게 **오른쪽 끝 `.proj-toggle`(비인터랙티브 span)만 클릭 시 펼침**(세션·곡 요약 + 완료 토글).
 *  - 다음 세션=진행 중 탭만(디데이 pill), 금액=프로젝트 버짓(청구 필요 탭은 '청구 필요 N' 배지 병기), 작성일=전 탭.
 *  - 반응형: <640px면 thead 숨기고 아티스트·프로젝트 + 탭 값만 2줄 카드(제작사·PM·작성일 숨김).
 */
// mineQ = 복귀 경로에 실을 '내 프로젝트만' 상태 파라미터(`&mine=0`·`&mine=1`·기본값이면 빈 문자열).
// ⚠️불리언이 아니라 문자열인 이유: 기본값이 역할마다 다르다(스태프=켜짐·대표=꺼짐, 2026-08-02) — 여기서
// 불리언으로 되돌리면 어느 쪽이 기본인지 뷰가 알 수 없어 대표의 '켬' 상태가 복귀 때마다 풀린다.
function projectListRow(p, summary, { tab = "active", isAdmin = false, openId = null, mineQ = "", listQuery = "" } = {}) {
  const href = projectRowHref(p, tab, listQuery);
  const dash = '<span class="text-muted">—</span>';
  // sortVal = 정렬 원값(헤더 클릭 정렬). **항상 명시한다** — 보이는 텍스트로 정렬하면 틀리는 열이 많다:
  // 금액 '₩1,200,000'(문자열 정렬 불가)·다음 세션 'D-3'(날짜순 아님)·빈 칸의 '—'(빈 값으로 안 쳐서 뒤로 안 감).
  // app.js는 빈 문자열을 방향 무관 뒤로 보내므로, 값 없는 칸은 ""를 넘겨야 의도대로 놓인다.
  const cellLink = (val, cls, label, key, sortVal) =>
    `<a href="${href}" class="pt-cell proj-link ${cls}" data-label="${esc(label)}" data-sort-key="${key}" data-sort-value="${esc(String(sortVal == null ? "" : sortVal))}">${val}</a>`;
  const artistRaw = projectArtistOnly(p);
  const companyRaw = String(p.client_name || "").trim();
  const titleRaw = String(p.title || "제목 없음").trim();
  const pmRaw = p.manager_name ? String(p.manager_name) : "";
  const artist = esc(artistRaw);
  const company = esc(companyRaw);
  const title = esc(titleRaw);
  const pm = esc(pmRaw);
  const next = tab === "active" ? nextSessionLine(p) : ""; // 다음 세션·디데이 = 진행 중 탭만(완료·청구필요는 next_session_date 없음)
  const amt = projectAmount(p);
  const amount = amt ? formatKRW(amt) : "";
  // 미청구가 있으면 어느 탭에서든 배지(2026-07-23) — 예전엔 청구 필요 탭에만 띄워서, 다가오는 세션이 하나라도
  // 있으면(=진행 중 탭) 이미 끝난 세션의 미청구가 어디에도 안 보였다. 장기 앨범일수록 청구가 늦어지던 원인.
  const billingBadge = Number(p.unbilled_cnt) > 0
    ? ` <span class="badge bg-warning/10 text-warning">청구 필요 ${p.unbilled_cnt}</span>` : "";
  const internalBadge = p.internal_support ? ` <span class="badge badge-neutral">내부</span>` : "";
  const created = p.created_at ? esc(kstYmd(p.created_at)) : ""; // DB는 UTC — KST로 변환해 표시(2026-07-20)
  const isOpen = openId != null && Number(p.id) === Number(openId);
  return `
    <details class="proj-row group/proj"${isOpen ? " open" : ""} id="proj-${p.id}" data-sort-row>
      <summary class="proj-summary">
        ${cellLink(created, "pt-created tabular text-muted", "작성일", "created", created)}
        ${cellLink(company || dash, "pt-company text-muted", "제작사", "company", companyRaw)}
        ${cellLink(artist || dash, "pt-artist font-medium", "아티스트", "artist", artistRaw)}
        ${cellLink(`${title}${internalBadge}`, "pt-title", "프로젝트", "title", titleRaw)}
        ${cellLink(pm || dash, "pt-pm text-muted", "PM", "pm", pmRaw)}
        ${cellLink(next, "pt-next", "다음 세션", "next", p.next_session_date || "")}
        ${cellLink(`${amount}${billingBadge}`, "pt-amount tabular", "금액", "amount", amt || "")}
        <span class="proj-toggle" aria-hidden="true" title="펼치기"><svg class="proj-chevron transition-transform group-open/proj:rotate-180" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4" /></svg></span>
      </summary>
      <div class="proj-expand border-t border-border/40 bg-elevated/40 px-4 py-3 text-xs leading-relaxed">${projectSummaryHtml(summary, { isAdmin, projectId: p.id, tab, mineQ })}</div>
    </details>`;
}


/** 인라인 요약 본문 — 세션 일정(날짜·시간) + 곡·콘텐츠(아티스트·제목·작업자). data.listProjectSummaries 결과 1건. */
function projectSummaryHtml(s, { isAdmin = false, projectId = null, tab = "active", mineQ = "" } = {}) {
  if (!s || (!s.sessions.length && !s.tracks.length)) {
    return `<span class="text-muted">등록된 세션·곡·콘텐츠가 없습니다.</span>`;
  }
  // 완료 후 목록으로 복귀하며 이 카드를 다시 펼친다(?open=). 스크롤은 app.js가 보존(경로 동일).
  // '내 프로젝트만' 상태를 복귀 경로에 그대로 싣는다(mineQ, 라우트가 기본값과 비교해 만들어 넘긴다)
  // — 안 실으면 전체 보기로 훑던 사람이 완료 토글 한 번에 기본 상태로 튄다.
  const ret = `/projects?tab=${esc(tab)}${mineQ}${projectId ? `&open=${projectId}` : ""}`;
  // 프로젝트 목록 펼침에서 바로 완료(2026-07-11 사용자 요청 — 프로젝트 안 안 들어가고 완료). 편집 권한자·예정/완료 세션만.
  const sessToggle = (se) => {
    if (!isAdmin || (se.status !== "예정" && se.status !== "완료")) return "";
    const done = se.status === "완료";
    return `<form method="post" action="/sessions/${se.id}/status" class="shrink-0">
        <input type="hidden" name="status" value="${done ? "예정" : "완료"}" />
        <input type="hidden" name="return" value="${ret}" />
        <button class="btn-ghost btn-xs ${done ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${done}"><span aria-hidden="true" class="inline-block w-3 text-center ${done ? "" : "opacity-60"}">${done ? "✓" : "−"}</span>완료</button>
      </form>`;
  };
  // 곡·콘텐츠 작업(후반작업)도 목록 펼침에서 바로 완료(2026-07-11 사용자 요청 — 세션과 동일). status=Pending↔Completed.
  const taskToggle = (tk) => {
    if (!isAdmin) return "";
    const done = tk.status === "Completed";
    return `<form method="post" action="/projects/tasks/${tk.id}/status" class="shrink-0">
        <input type="hidden" name="status" value="${done ? "Pending" : "Completed"}" />
        <input type="hidden" name="return" value="${ret}" />
        <button class="btn-ghost btn-xs ${done ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${done}"><span aria-hidden="true" class="inline-block w-3 text-center ${done ? "" : "opacity-60"}">${done ? "✓" : "−"}</span>완료</button>
      </form>`;
  };
  const blocks = [];
  if (s.sessions.length) {
    // 다가오는 세션(오늘 이후) 먼저, 지난 세션은 그 뒤(최근 순)로 재정렬 — 지난 세션이 앞을 먹어 다가오는 게 잘리는 것 방지.
    const today = todayYmd();
    const upcoming = s.sessions.filter((se) => se.session_date >= today);
    const past = s.sessions.filter((se) => se.session_date < today).reverse();
    const ordered = [...upcoming, ...past];
    const items = ordered.slice(0, 8).map((se) => {
      const time = se.start_time ? ` ${esc(se.start_time)}${se.end_time ? "–" + esc(se.end_time) : ""}` : "";
      const st = se.status && se.status !== "예정" ? ` <span class="text-muted">· ${esc(se.status)}</span>` : "";
      const dateCls = se.session_date < today ? "text-muted" : "text-fg/80";
      const toggle = sessToggle(se);
      const info = `<span class="min-w-0 truncate"><span class="tabular ${dateCls}">${esc(formatYmdShort(se.session_date))}${time}</span> <span class="text-muted">· ${esc(se.session_type)}</span>${st}</span>`;
      return `<li class="flex items-center justify-between gap-2">${info}${toggle}</li>`;
    }).join("");
    const more = s.sessions.length > 8 ? `<li class="text-muted">외 ${s.sessions.length - 8}건</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">세션 ${s.sessions.length}</div><ul class="space-y-0.5">${items}${more}</ul></div>`);
  }
  if (s.tracks.length) {
    // 곡별로 제목 + 그 아래 작업(믹싱·마스터링 등) 목록 — 각 작업에 완료 토글(세션과 동일). 편집 권한자만 토글, 완료는 '· 완료' 병기.
    const items = s.tracks.slice(0, 10).map((tr) => {
      const artist = tr.artist ? `<span class="text-muted">${esc(tr.artist)} · </span>` : "";
      const eng = tr.engineers.length ? ` <span class="text-muted">(${esc(tr.engineers.join(", "))})</span>` : "";
      const head = `<div class="truncate text-fg/80">${artist}${esc(tr.title)}${eng}</div>`;
      const taskLis = (tr.tasks || []).map((tk) => {
        const done = tk.status === "Completed";
        const st = done ? ` <span class="text-muted">· 완료</span>` : "";
        return `<li class="flex items-center justify-between gap-2 pl-3"><span class="min-w-0 truncate text-fg/70">${esc(tk.label)}${st}</span>${taskToggle(tk)}</li>`;
      }).join("");
      return `<li>${head}${taskLis ? `<ul class="mt-0.5 space-y-0.5">${taskLis}</ul>` : ""}</li>`;
    }).join("");
    const more = s.tracks.length > 10 ? `<li class="text-muted">외 ${s.tracks.length - 10}곡</li>` : "";
    blocks.push(`<div><div class="mb-0.5 font-medium text-fg/60">작업 · 곡 ${s.tracks.length}</div><ul class="space-y-1.5">${items}${more}</ul></div>`);
  }
  // 세로 스택(2026-07-11 사용자 요청): 세션 블록은 전폭(완료 토글이 행 오른쪽 끝에 정렬), 곡·콘텐츠는 다음 줄로.
  return `<div class="space-y-3">${blocks.join("")}</div>`;
}


/** 청구된 세션 수정·삭제 차단 모달(?error=session_invoiced). app.js의 '확인'(data-modal-close)으로 닫는다. */
function sessionInvoicedModal(projectId) {
  return `
    <div data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="card w-full max-w-md">
        <h3 class="font-display text-base font-semibold">청구된 세션</h3>
        <p class="mt-2 text-sm text-muted">이미 청구된 세션은 수정·삭제할 수 없습니다. 청구서를 삭제한 뒤 다시 시도하세요.</p>
        <div class="mt-4 flex justify-end gap-2">
          <a href="/projects/${projectId}?tab=invoice" class="btn-ghost btn-sm">청구 화면으로</a>
          <button class="btn-primary btn-sm" type="button" data-modal-close>확인</button>
        </div>
      </div>
    </div>`;
}


/** 메타 라인용 클라이언트 담당자 표기: "이름 (전화)" 또는 "이름", 없으면 null(filter(Boolean)로 제외). */
function contactMetaPart(p) {
  if (!p.contact_name) return null;
  return p.contact_phone ? `${p.contact_name} (${p.contact_phone})` : p.contact_name;
}


/** 메타 한 줄 요약(아티스트 · 거래처 · 담당자 / 견적 · 완료일). */
function projectMetaLine(p) {
  const left = [p.artist, p.client_name, p.manager_name, contactMetaPart(p)].filter(Boolean).join(" · ") || "정보 미정";
  const amount = projectAmount(p)
    ? `<div class="text-sm font-semibold">${formatKRW(projectAmount(p))}</div>`
    : `<div class="text-sm text-muted">견적 미정</div>`;
  return { left: esc(left), amount };
}


/** 클라이언트(읽기 전용) 메타 카드. */
function projectMetaReadonly(p) {
  const { left, amount } = projectMetaLine(p);
  const extra = [
    p.artist_company ? `소속 ${esc(p.artist_company)}` : "",
    p.production_company ? `제작/운영 ${esc(p.production_company)}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="card">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 text-sm text-muted">${left}</div>
        <div class="shrink-0 text-right">${amount}</div>
      </div>
      ${extra ? `<div class="mt-1 text-xs text-muted">${extra}</div>` : ""}
      ${p.memo ? `<div class="mt-2 whitespace-pre-wrap border-t border-border pt-2 text-sm">${esc(p.memo)}</div>` : ""}
    </div>`;
}


/** 관리자 메타 카드(프로젝트 탭): 편집 폼을 항상 펼쳐서 표시(접기 없음 — 한 프로젝트만 보이므로). */
function projectMetaCard(p, err = "", { chief = false } = {}) {
  // 치프 전용 작성일(생성일) 편집 — 완료/청구 필요 탭 정렬(작성일순)에 영향. 목록에서 상세로 이동(2026-07-11).
  const dateStr = esc(kstYmd(p.created_at));
  // 작성일 = 저빈도 관리 필드 → **폼 맨 아래**에 별도 줄로(2026-07-21 사용자 요청 '작성일이 정보 탭 맨 위·저장 버튼 둘이 헷갈린다').
  // 버튼 라벨도 '작성일 저장'으로 구분(위 폼의 '저장'과 혼동 방지). border-t로 본 폼과 시각 분리.
  const createdEdit = chief
    ? `<form method="post" action="/projects/${p.id}/created-at" class="mt-4 flex items-center gap-2 border-t border-border/40 pt-3">
         <label class="text-xs text-muted">작성일</label>
         <input type="hidden" name="return" value="/projects/${p.id}?tab=project" />
         ${dateCombo("created_at", dateStr, { label: "작성일", inputCls: "w-[8.5rem] rounded border border-border/70 bg-surface px-1.5 py-0.5 text-xs text-muted tabular focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30" })}
         <button type="submit" class="btn-ghost btn-xs shrink-0">작성일 저장</button>
       </form>`
    : "";
  return `
    <div class="card">
      <form id="del-proj-${p.id}" method="post" action="/projects/${p.id}/delete" data-confirm="프로젝트를 삭제하면 세션·곡·콘텐츠·자료가 모두 삭제됩니다. 정말 삭제할까요?" class="hidden"></form>
      ${projectEditForm(p, err)}
      ${createdEdit}
    </div>`;
}


function projectAmount(project) {
  const task = Number(project.task_total || 0);
  const sess = Number(project.session_amount_total || 0);
  // 청구서 단위 할인(from-tasks 청구서)은 라인 금액에 분배되지 않으므로 여기서 차감 — 할인 반영 실수령 기준(2026-07-05 사용자 리포트).
  const disc = Number(project.invoice_discount_total || 0);
  const combined = task + sess;
  if (combined) return Math.max(0, combined - disc);
  return Number(project.rate || 0) || 0;
}


// ── 폼 렌더 ──
function projectForm(p = {}, err = "") {
  const e = err || p._err || "";
  const action = "/projects";
  return `
    ${pageHeader({ title: "새 프로젝트" })}
    <!-- data-artist-confirm: 아티스트를 안 적고 제출하면 app.js가 한 번 더 묻는다(2026-08-03 사용자 요청).
         막지는 않는다 — 아티스트가 정해지기 전에 프로젝트를 먼저 여는 경우가 실제로 있다. -->
    <form method="post" action="${action}" class="card space-y-3" data-artist-confirm>
      <input type="hidden" name="project_type" value="session" />
      ${e ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(e)}</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-0">프로젝트 명<input class="input mt-1 block" name="title" value="${esc(p.title || "")}" placeholder="예: OOO 세션 (가제)" required /></label>
        </div>
        <div>
          <label class="label mb-0">프로젝트 매니저${managerSelect(p.manager_id)}</label>
        </div>
      </div>
      <div>
        <label class="label">아티스트</label>
        ${artistCombo(p)}
      </div>
      <div>
        <label class="label">제작/운영</label>
        ${companyCombo("production_company", p.production_company, "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: p.production_id })}
      </div>
      <div>
        <label class="label mb-0 flex items-center gap-2"><input type="checkbox" name="internal_support" value="1" ${p.internal_support ? "checked" : ""} /> 내부 지원(청구 대상 아님)</label>
        <p class="mt-1 text-xs text-muted">사내 다른 부서 지원 등 외부 청구가 없는 프로젝트입니다. 제작사·청구처는 비워둬도 됩니다.</p>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${(() => { const sel = p.id ? listProjectContacts(p.id) : []; return personCombo({ multi: true, selected: sel, options: contactOptions(), companyOptions: partyOptions({ role: "company" }), placeholder: sel.length ? "" : "담당자 — 검색 또는 새로 등록" }); })()}
      </div>
      <div>
        <label class="label mb-0">메모<textarea class="input mt-1 block" name="memo" rows="3" placeholder="비고">${esc(p.memo || "")}</textarea></label>
      </div>
      <div class="flex items-center justify-between gap-3 pt-1">
        <a href="/projects" class="btn-ghost btn-sm">취소</a>
        <button class="btn-primary" type="submit">추가</button>
      </div>
    </form>`;
}


/**
 * '프로젝트 정보' 칸 묶음 — `/new` 상세 섹션 전용(개편 1단계, 2026-10-13). 정보 탭 폼과 같은 위젯·같은 필드명이라
 * 서버(updateProjectRecord)가 그대로 해석한다. **제목·메모 칸은 없다**(세션 메모와 이름이 겹치고, 제목은 위 콤보).
 * 기존 프로젝트면 JS가 칸이 실제로 바뀔 때만 `project_info_touched=1`을 세팅하고, 서버는 그 표시가 있을 때만
 * 저장한다 — 섹션을 안 열고 저장해도 빈 칸이 기존 아티스트·담당자를 지우지 않게.
 */
function projectInfoFields(p = {}, { existing = false, optionsRef = "" } = {}) {
  const sel = p.id ? listProjectContacts(p.id) : [];
  return `
    <div class="space-y-3" data-project-info>
      <input type="hidden" name="project_info_touched" value="0" data-project-info-touched />
      <div class="flex items-baseline justify-between gap-2">
        <div class="text-xs font-semibold text-muted">프로젝트 정보</div>
        <div class="text-xs text-muted">${existing ? "이 프로젝트의 모든 세션·작업에 공통" : "새 프로젝트에 저장"}</div>
      </div>
      ${existing ? `<p class="hidden rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" data-project-info-warn>프로젝트 정보가 바뀌었습니다 — 저장하면 이 프로젝트 전체에 반영됩니다.</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div><label class="label mb-0">아티스트</label>${artistCombo(p)}</div>
        <div><label class="label mb-0">프로젝트 매니저${managerSelect(p.manager_id)}</label></div>
      </div>
      <div>
        <label class="label">제작/운영</label>
        ${companyCombo("production_company", p.production_company, "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: p.production_id })}
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${personCombo({ multi: true, selected: sel, options: optionsRef ? [] : contactOptions(), optionsRef, companyOptions: optionsRef ? [] : partyOptions({ role: "company" }), companyOptionsRef: optionsRef ? "pc-company-shared" : "", placeholder: sel.length ? "" : "담당자 — 검색 또는 새로 등록" })}
      </div>
      <label class="label mb-0 flex items-center gap-2"><input type="checkbox" name="internal_support" value="1" ${p.internal_support ? "checked" : ""} /> 내부 지원(청구 대상 아님)</label>
    </div>`;
}

/** 접힘 요약 줄용 프로젝트 조각(아티스트·제작·PM) — 값이 있는 것만. */
function projectInfoSummary(p = {}) {
  const pm = p.manager_id ? listProjectManagers({ includeInactive: true }).find((m) => Number(m.id) === Number(p.manager_id)) : null;
  return [
    p.artist ? `아티스트 ${p.artist}` : "",
    p.production_company ? `제작 ${p.production_company}` : "",
    pm ? `PM ${pm.name}` : "",
  ].filter(Boolean);
}

function projectEditForm(p = {}, err = "") {
  // 명시적 저장 버튼(변경 시 하이라이트) — app.js [data-dirty-form] 공통 처리.
  return `
    <form method="post" action="/projects/${p.id}" class="space-y-3" data-dirty-form>
      ${err ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(err)}</p>` : ""}
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label mb-0">프로젝트 명<input class="input mt-1 block" name="title" value="${esc(p.title || "")}" required /></label>
        </div>
        <div>
          <label class="label mb-0">프로젝트 매니저${managerSelect(p.manager_id)}</label>
        </div>
      </div>
      <div>
        <label class="label">아티스트</label>
        ${artistCombo(p)}
      </div>
      <div>
        <label class="label">제작/운영</label>
        ${companyCombo("production_company", p.production_company, "제작사", "제작/운영", { partyIdField: "production_party_id", partyIdValue: p.production_id })}
      </div>
      <div>
        <label class="label mb-0 flex items-center gap-2"><input type="checkbox" name="internal_support" value="1" ${p.internal_support ? "checked" : ""} /> 내부 지원(청구 대상 아님)</label>
        <p class="mt-1 text-xs text-muted">사내 다른 부서 지원 등 외부 청구가 없는 프로젝트입니다. 제작사·청구처는 비워둬도 됩니다.</p>
      </div>
      <div>
        <label class="label">고객측 담당자</label>
        ${(() => { const sel = p.id ? listProjectContacts(p.id) : []; return personCombo({ multi: true, selected: sel, options: contactOptions(), companyOptions: partyOptions({ role: "company" }), placeholder: sel.length ? "" : "담당자 — 검색 또는 새로 등록" }); })()}
      </div>
      <div>
        <label class="label mb-0">메모<textarea class="input mt-1 block" name="memo" rows="3">${esc(p.memo || "")}</textarea></label>
      </div>
      ${dirtyActionRow({ deleteFormId: `del-proj-${p.id}`, deleteLabel: "프로젝트 삭제", cancelHref: "/projects" })}
    </form>`;
}


/**
 * 아티스트 콤보(커스텀) — 타이핑=기존 아티스트·사람 검색, 빈 입력=[검색]/[새 아티스트] 팝업(전체 목록 덤프 방지).
 * 기존 사람을 고르면 hidden artist_contact_id로 연결(저장 시 중복 사람 방지). '그룹' 체크=밴드/팀(연락처 연결 안 함).
 * CSP-safe: 옵션은 <script type="application/json">로 정적 임베드, 상호작용은 app.js([data-artist-combo]).
 */
function artistCombo(p = {}) {
  // 현재 아티스트 party(있으면)에서 콤보 초기값 파생: 연결 party id·그룹 여부·본명(활동명과 다르면).
  const artistParty = p.artist_id ? getParty(p.artist_id) : null; // getParty=getParty(compat)
  // 표시 이름 = artist TEXT 우선, 없으면 party 활동명/본명 폴백(TEXT denorm 비어도 콤보에 이름 표시).
  const artistName = p.artist || (artistParty ? artistParty.activity_name || artistParty.name || "" : "");
  // 콤마 다중("아이유, 태연")이면 단일 전용 메타(명시 id·그룹·본명) 비활성 — 서버가 이름별 해석(resolveProjectParties 다중 경로).
  const multi = artistName.includes(",");
  const meta = {
    contactId: !multi && artistParty ? artistParty.id : "",
    isGroup: !multi && artistParty ? artistParty.kind === "group" : false,
    realName: !multi && artistParty && artistParty.kind === "person" && artistParty.name && artistParty.name !== artistName ? artistParty.name : "",
  };
  // 아티스트 후보 = is_artist party(사람 solo + 그룹). 콤보 옵션 shape {name, contactId, realName, sub}.
  const opts = partyOptions({ role: "artist" }).map((o) => ({
    name: o.activity_name || o.name,
    contactId: o.id,
    realName: o.kind === "person" && o.activity_name && o.name && o.name !== o.activity_name ? o.name : "", // 본명(활동명과 다를 때)
    sub: o.sub,
    agency: o.company || "", // 현재 소속사 → 아티스트 선택 시 소속사/레이블 필드 자동 채움
  }));
  const json = JSON.stringify(opts).replace(/</g, "\\u003c"); // </script> 브레이크아웃 방지
  const companies = partyOptions({ role: "company" }); // 모달 소속사 미니콤보용
  const groups = listGroupsForPicker(); // 모달 소속 그룹 미니콤보용(개인 아티스트가 속한 밴드·팀)
  // Gmail식 칩(2026-07-10 — 콤마 텍스트 방식에서 전환, 담당자·디렉터·대표자와 통일).
  // **서버 계약 불변**: hidden `artist`=활동명 콤마 목록, `artist_contact_id`=단일 선택일 때만 명시 id.
  // 칩 라벨은 '활동명 (본명)' 병기(본명은 단일 프리필 또는 옵션에서 옴). app.js chipEl과 마크업 형식 동일.
  const names = artistName.split(",").map((x) => x.trim()).filter(Boolean);
  const chipHtml = names.map((nm, i) => {
    const rn = names.length === 1 ? meta.realName : ""; // 다중 프리필은 본명을 알 수 없음(표시 TEXT만 저장)
    const label = rn && rn !== nm ? `${nm} (${rn})` : nm;
    const cid = names.length === 1 ? meta.contactId || "" : "";
    return `<span class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-elevated py-0.5 pl-2.5 pr-1 text-sm" data-artist-chip data-artist-chip-name="${esc(nm)}" data-artist-chip-cid="${esc(String(cid))}">
      <span class="truncate">${esc(label)}</span>
      <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg" data-artist-chip-remove aria-label="${esc(nm)} 제거">✕</button>
    </span>`;
  }).join("");
  return `
    <div data-artist-combo>
      <input type="hidden" name="artist_contact_id" value="${meta.contactId || ""}" data-artist-cid />
      <input type="hidden" name="artist" value="${esc(names.join(", "))}" data-artist-hidden />
      <div class="relative">
        <!-- 보이는 검색칸은 name 없음(제출은 위 hidden) — 칩이 값의 진실원천 -->
        <div class="input flex flex-wrap items-center gap-1.5 py-1.5" data-artist-chips>
          ${chipHtml}
          <input class="min-w-[3rem] flex-1 border-0 bg-transparent p-0 text-inherit outline-none focus:ring-0" type="text" size="1" data-artist-input autocomplete="off"
            role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="${names.length ? "" : "아티스트명 — 검색 또는 새로 등록"}" />
        </div>
        <div class="absolute left-0 z-30 mt-1 hidden max-h-64 w-max min-w-[14rem] max-w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-artist-pop role="listbox"></div>
      </div>
      <script type="application/json" data-artist-options>${json}</script>
      <!-- 간이 등록 모달(프로젝트 폼 이탈 없이 새 아티스트/그룹 등록). name 없음(프로젝트 폼과 분리), app.js가 fetch로 생성. -->
      <div data-artist-modal class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
        <div class="w-full max-w-sm space-y-3 rounded-xl border border-border bg-bg p-4 shadow-xl" role="dialog" aria-modal="true">
          <div class="font-display text-lg font-semibold">새 아티스트 등록</div>
          <!-- 유형 먼저(2026-07-14 사용자 리포트 '그룹 체크가 [이 사람이 그룹 소속]인지 [이름 자체가 그룹]인지 불명확').
               개인=사람 party(활동명·본명·소속 그룹), 그룹=group party(그룹명). name 없는 select(폼 제출 안 됨·app.js가 읽음). -->
          <div><label class="label mb-0">등록 유형<select class="input mt-1 block" data-am-type>
              <option value="artist" selected>개인 아티스트 (솔로·멤버)</option>
              <option value="group">그룹 (밴드 · 팀 자체)</option>
            </select></label>
          </div>
          <div><label class="label" data-am-name-label>활동명</label><input class="input" data-am-name placeholder="아티스트 활동명" /></div>
          <div data-am-real-wrap><label class="label mb-0">본명 <span class="text-xs font-normal text-muted">(활동명과 다르면)</span><input class="input mt-1 block" data-am-real placeholder="본명(선택)" /></label></div>
          <div data-am-group-wrap><label class="label">소속 그룹 <span class="text-xs font-normal text-muted">(선택 · 밴드·팀 멤버면)</span></label>
            <input type="hidden" data-am-group-id value="" />
            <div class="relative">
              <input class="input" data-am-group-input autocomplete="off" placeholder="그룹 검색 또는 새로 등록" role="combobox" aria-expanded="false" aria-autocomplete="list" />
              <div class="absolute left-0 right-0 z-10 mt-1 hidden max-h-40 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-am-group-pop role="listbox"></div>
            </div>
            <script type="application/json" data-am-group-options>${JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name }))).replace(/</g, "\\u003c")}</script>
          </div>
          <div><label class="label">소속사 <span class="text-xs font-normal text-muted">(선택)</span></label>
            <div class="relative">
              <input class="input" data-am-agency-input autocomplete="off" placeholder="소속사 검색 또는 새로 등록" role="combobox" aria-expanded="false" aria-autocomplete="list" />
              <div class="absolute left-0 right-0 z-10 mt-1 hidden max-h-40 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-am-agency-pop role="listbox"></div>
            </div>
            <script type="application/json" data-am-agency-options>${JSON.stringify(companies.map((co) => ({ id: co.id, name: co.name }))).replace(/</g, "\\u003c")}</script>
          </div>
          <div data-am-person-only><label class="label mb-0">전화 <span class="text-xs font-normal text-muted">(선택)</span><input class="input mt-1 block" data-am-phone autocomplete="off" /></label></div>
          <div data-am-person-only><label class="label mb-0">이메일 <span class="text-xs font-normal text-muted">(선택)</span><input class="input mt-1 block" type="email" data-am-email autocomplete="off" /></label></div>
          <div class="flex items-center gap-2 pt-1">
            <button type="button" class="btn-primary" data-am-save>등록</button>
            <button type="button" class="btn-ghost" data-am-cancel>취소</button>
            <span class="ml-1 hidden text-xs text-danger" data-am-err></span>
          </div>
        </div>
      </div>
    </div>`;
}

// companyCombo는 views.js 공용 헬퍼로 이동(연락처 폼과 공유, 2026-07-04).


/** 내부 담당자(프로젝트 매니저) 선택 — 하우스/외주 엔지니어 목록. 고객측 담당자(personCombo)와 별개 필드.
 * 🔒 **현재값이 목록에 없어도 보존한다**(2026-08-02 사용자 결정 '기록은 기록이다 — PM이었던 기록이 남아도 된다').
 * 목록은 활성 담당자만인데(`listProjectManagers`) 퇴사·비활성 처리된 사람이 PM인 프로젝트가 있다. 보존 옵션이
 * 없으면 그 프로젝트의 폼이 **'미지정'으로 열리고**, 정보 탭에서 **다른 항목만 고쳐 저장해도 PM이 조용히 지워졌다**
 * (`manager_id: b.manager_id ? … : null`). 목록의 PM 컬럼은 active를 안 봐서 이름이 그대로 보이던 터라
 * '목록엔 있는데 상세는 미지정'인 불일치이기도 했다. 세션 폼의 예약 담당자(`managerOptions`)는 이미 같은
 * 보존을 하고 있었고 PM만 빠져 있었다 — 그 비대칭을 없앤다. */
function managerSelect(selectedId) {
  const opts = listProjectManagers();
  const cur = Number(selectedId) || null;
  // 활성 목록에 없을 때만 추가 조회(평소엔 쿼리 1회 그대로).
  const missing = cur && !opts.some((m) => m.id === cur)
    ? listProjectManagers({ includeInactive: true }).find((m) => m.id === cur) || null
    : null;
  // mt-1 block: 호출부가 이 select을 label.label(mb-0)로 감싸므로(스크린리더 연결), 라벨 텍스트와의
  // 간격(옛 .label mb-1)을 여기서 만든다. 인라인 배치면 라벨 텍스트 줄에 붙고 아래로 디센더 여백이 생긴다.
  return `
    <select name="manager_id" class="input mt-1 block">
      <option value="">프로젝트 매니저 미지정</option>
      ${missing ? `<option value="${missing.id}" selected>${esc(missing.name)} (목록에 없음)</option>` : ""}
      ${opts.map((m) => `<option value="${m.id}" ${cur === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
    </select>`;
}


/**
 * 프로젝트 '작업' 탭(개편 2단계 — 곡 계층 제거). 같은 곡명끼리 **보기로만** 묶는다(곡은 개체가 아니라 작업의 곡명 칸).
 * @param {{project:object, groups:Array<{key:string,title:string,artist:?string,tasks:Array}>}} o
 */
function tracksSection({ project, groups = [], isAdmin, managers = [], expandTaskId = null }) {
  const list = groups.length
    ? groups.map((g) => songGroupCard(project, g, { isAdmin, managers, expandTaskId })).join("")
    : emptyState("등록된 작업이 없습니다.");
  const hint = isAdmin
    ? explain(`세션(예약)과 <span class="text-muted">별개로</span> 후반작업(보컬튠·믹싱·마스터링 등)을 기록합니다. 곡명이 같은 작업끼리 묶어 보여 줍니다. 여기선 <span class="text-fg">종류·담당·진행 상태</span>만 기록하고, <span class="text-fg">금액은 청구 탭에서</span> 정합니다.`)
    : "";
  return `
    <section class="card mt-3 space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-display text-base font-semibold">작업</h2>
      </div>
      ${hint}
      <div class="space-y-3">${list}</div>
      ${isAdmin ? `<div class="border-t border-border pt-4"><div class="mb-2 text-sm font-medium text-muted">작업 추가</div>${taskCreateForm(project, managers)}</div>` : ""}
    </section>`;
}


/** 작업 추가 폼 — 곡명 칸의 **줄마다** 작업 하나(옛 '곡 일괄 추가' 대체. 예: 믹싱 10곡을 한 번에). */
function taskCreateForm(project, managers = []) {
  return `
    <form method="post" action="/projects/${project.id}/tasks" class="space-y-2 rounded-lg border border-border bg-bg p-3" data-worker-rate-form>
      <div class="grid gap-2 sm:grid-cols-3">
        <div><label class="label mb-0 text-xs">작업 종류<select class="input mt-0.5 block py-1.5 text-sm" name="task_type">${taskTypeOptions(defaultTaskType())}</select></label></div>
        <div><label class="label mb-0 text-xs">담당 엔지니어<select class="input mt-0.5 block py-1.5 text-sm" name="engineer_id">${engineerSelect(managers, {})}</select></label></div>
        <div><span class="label mb-0 text-xs">작업일 <span class="font-normal text-muted">(선택)</span></span><div class="mt-0.5">${dateCombo("work_date", "", { label: "작업일", inputCls: "input w-full py-1.5 text-sm", placeholder: "비우면 미정" })}</div></div>
      </div>
      <div data-worker-rate><label class="label mb-0 text-xs">외주 지급단가 <span class="font-normal text-muted">(원 · 작업마다 같은 값)</span><input class="input mt-0.5 block py-1.5 text-sm" name="worker_rate" inputmode="numeric" placeholder="0" /></label></div>
      <div>
        <label class="label mb-0 text-xs">곡명 <span class="font-normal text-muted">— 여러 곡은 줄바꿈(곡마다 작업 하나) · 비우면 프로젝트 이름</span></label>
        <div class="mt-0.5 flex gap-2">
          <textarea class="input flex-1 py-1.5 text-sm" name="song_title" rows="2" placeholder="곡명&#10;한 줄에 하나씩"></textarea>
          <button class="btn-primary shrink-0 self-end px-4 py-1.5 text-sm" type="submit">추가</button>
        </div>
      </div>
      <input type="hidden" name="status" value="Pending" />
    </form>`;
}


function songGroupCard(project, group, { isAdmin, managers = [], expandTaskId = null }) {
  const tasks = group.tasks.map((task) => taskRow(task, { isAdmin, managers, open: task.id === expandTaskId })).join("");
  const unnamed = !group.key;
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="mb-2 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium">${esc(group.title)}${unnamed ? `<span class="ml-1.5 text-xs font-normal text-muted">(곡명 없음)</span>` : ""}${group.artist ? `<span class="ml-1.5 text-xs font-normal text-muted">${esc(group.artist)}</span>` : ""}</div>
        </div>
        ${isAdmin ? songRenameMenu(project, group) : ""}
      </div>
      ${trackProgressSummary(group.tasks)}
      <div class="space-y-2">${tasks}</div>
      ${isAdmin ? taskQuickAdd(project, group) : ""}
    </div>`;
}

/** 곡의 진행 요약: 단계 그룹별 가장 진전된 상태를 한 줄로(믹스 완료 · 마스터 대기). */
function trackProgressSummary(tasks) {
  if (!tasks || !tasks.length) return "";
  const order = { Pending: 0, Completed: 1 };
  // 분류 폐기 — 작업 종류별(보컬튠·믹싱 등)로 최고 진행 상태를 요약(이전 그룹 묶음 대체).
  const byType = {};
  for (const t of tasks) {
    const label = taskTypeLabel(t.task_type);
    if (byType[label] == null || (order[t.status] || 0) > (order[byType[label]] || 0)) byType[label] = t.status;
  }
  const parts = Object.keys(byType).map((label) => `${label} ${TASK_STATUS_LABELS[byType[label]] || byType[label]}`);
  return parts.length ? `<div class="mb-2 text-xs text-muted">진행: ${esc(parts.join(" · "))}</div>` : "";
}


/** 곡 이름 바꾸기 — 이 곡명의 미청구 작업 전부(청구된 작업은 스냅샷 잠금이라 그대로, 서버가 안내). */
function songRenameMenu(project, group) {
  return `
    <details class="group shrink-0 text-right">
      <summary class="flex cursor-pointer list-none items-center justify-end gap-1 whitespace-nowrap text-xs text-muted hover:text-fg">이름 바꾸기 ${detailsChevron()}</summary>
      <form method="post" action="/projects/${project.id}/songs/rename" class="mt-2 flex gap-2 rounded-lg border border-border bg-surface p-3 text-left">
        <input type="hidden" name="from" value="${esc(group.key)}" />
        <input class="input flex-1 py-1.5 text-sm" name="to" value="${esc(group.key)}" placeholder="비우면 곡명 없음(프로젝트 이름)" aria-label="새 곡명" />
        <button class="btn-primary btn-xs shrink-0 self-center" type="submit">바꾸기</button>
      </form>
    </details>`;
}


function taskRow(task, { isAdmin, managers = [], open = false } = {}) {
  const label = taskTypeLabel(task.task_type);
  const status = TASK_STATUS_LABELS[task.status] || task.status;
  const statusCls = TASK_STATUS_BADGE[task.status] || "bg-muted/10 text-muted";
  // 금액은 청구 탭에서 확정 — 작업 행엔 청구된 작업의 확정액만 표시(미청구는 숨김, '기록만' 일관).
  const amount = `<span class="text-sm font-semibold">${task.is_invoiced && task.total_price ? formatKRW(task.total_price) : ""}</span>`;
  // 종류·담당은 '작업 저장' 후 서버 재렌더로 갱신된다(자동저장은 2026-07-01 명시 저장 버튼으로 전환).
  const title = `<span class="min-w-0 truncate text-sm"><span class="font-medium">${esc(label)}</span><span class="text-xs text-muted">${task.engineer_name ? " · " + esc(task.engineer_name) : ""}${task.work_date ? " · " + esc(formatYmdShort(task.work_date)) : ""}</span></span>`;
  const statusBadge = `<span class="badge ${statusCls}">${esc(status)}</span>`;

  // 비관리자/청구된 작업: 편집 불가 → 단순 행(접기 없음).
  if (!isAdmin || task.is_invoiced) {
    const billed = task.is_invoiced ? `<span class="badge bg-success/10 text-success">청구됨</span>` : "";
    return `
      <div id="task-${task.id}" class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-1.5">${amount}${statusBadge}${billed}</span>
      </div>`;
  }
  // 완료 토글(2026-07-05 사용자 요청 — 세션 완료 버튼과 동일 UX): 배지 대신 버튼 활성/비활성이 상태를 표시.
  // 대기=비활성 '− 완료'(누르면 완료), 완료=활성 '✓ 완료'(다시 누르면 대기로). 독립 폼(POST /status)이라 접힌 채로도 즉시 전환.
  const isDone = task.status === "Completed";
  const completeToggle = `
    <form method="post" action="/projects/tasks/${task.id}/status">
      <input type="hidden" name="status" value="${isDone ? "Pending" : "Completed"}" />
      <button class="btn-ghost btn-xs ${isDone ? "border-success/40 bg-success/10 text-success" : "text-success"}" type="submit" aria-pressed="${isDone}"><span aria-hidden="true" class="inline-block w-3.5 text-center ${isDone ? "" : "opacity-60"}">${isDone ? "✓" : "−"}</span>완료</button>
    </form>`;
  return `
    <details id="task-${task.id}" class="group rounded-lg border border-border bg-surface"${open ? " open" : ""}>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-2 p-2.5">
        ${title}
        <span class="flex shrink-0 items-center gap-2">
          ${amount}
          ${completeToggle}
          ${detailsChevron()}
        </span>
      </summary>
      <div class="border-t border-border p-2.5">
        ${taskEditForm(task, managers)}
      </div>
    </details>`;
}


/**
 * 담당 엔지니어 select 옵션(담당자 마스터, value=manager.id). 선택 기준은 task.engineer_id.
 * 레거시(engineer_id 없이 engineer_name만 있는) 작업은 value='legacy' 보존 옵션으로 표시 — 저장 시 이름이 유지된다.
 */
function engineerSelect(managers, task) {
  const curId = task && task.engineer_id ? Number(task.engineer_id) : null;
  const legacyName = !curId && task && task.engineer_name ? String(task.engineer_name) : "";
  const out = [`<option value="">담당자 미지정</option>`];
  if (legacyName) {
    out.push(`<option value="legacy" selected>${esc(legacyName)} (목록에 없음)</option>`);
  }
  // 🔒 비활성(퇴사·계정 비활성) 담당자가 배정돼 있으면 활성 목록에 없다 → 보존 옵션(2026-08-02 전수 점검).
  // 없으면 폼이 '미지정'으로 열리고, 종류만 바꿔 저장해도 **engineer_id·engineer_name이 통째로 null이 되고
  // worker_rate까지 0으로 리셋**된다(실측). 지급완료(worker_paid=1) 작업에서도 그래서 정산·원천세 근거가
  // 소급 소멸한다 — PAYOUT_LOCKED는 '삭제'만 막고 이 UPDATE는 막지 않는다.
  // 담당자 행을 되짚는 이유: 이름뿐 아니라 `data-external`(외주 지급단가 칸 노출)이 user_id에 달려 있다.
  const missing = curId && !managers.some((m) => Number(m.id) === curId)
    ? listProjectManagers({ includeInactive: true }).find((m) => Number(m.id) === curId) || null
    : null;
  if (missing) {
    out.push(`<option value="${missing.id}" selected data-external="${missing.user_id ? "" : "1"}">${esc(missing.name)} (목록에 없음)</option>`);
  }
  for (const m of managers) {
    // data-external: 외주 작업자(user_id 없음)=1 → app.js가 외주 지급단가 토글. 하우스 엔지니어는 단가 숨김.
    out.push(`<option value="${m.id}" ${curId === m.id ? "selected" : ""} data-external="${m.user_id ? "" : "1"}">${esc(m.name)}${m.user_id ? "" : " · 외주"}</option>`);
  }
  return out.join("");
}


/** 작업 종류 기본값 = 보컬 녹음(2026-10-13 사용자 지정 — /new·작업 추가 폼 공통). 키는 라벨을 바꿔도 고정 — 삭제됐으면 기본값 없이 첫 항목. */
const DEFAULT_TASK_TYPE = "Vocal_Recording";
function defaultTaskType() {
  return activeTaskTypes().some((t) => t.key === DEFAULT_TASK_TYPE) ? DEFAULT_TASK_TYPE : "";
}

/** 작업 종류 select 옵션 — 활성 종류 + 현재값이 비활성/삭제됐으면 보존용 옵션(과거 작업 깨짐 방지). */
function taskTypeOptions(current) {
  const types = activeTaskTypes();
  const out = types.map((t) => `<option value="${esc(t.key)}" ${t.key === current ? "selected" : ""}>${esc(t.label)}</option>`);
  if (current && !types.some((t) => t.key === current)) {
    out.unshift(`<option value="${esc(current)}" selected>${esc(taskTypeLabel(current))} (삭제됨)</option>`);
  }
  return out.join("");
}


function taskEditForm(task, managers = []) {
  const legacyName = !task.engineer_id && task.engineer_name ? String(task.engineer_name) : "";
  // 상태(완료 여부)는 헤더의 독립 토글 버튼(POST /tasks/:id/status)이 전담(2026-07-05) — 이 폼엔 상태 필드 없음(종류·담당·외주단가만).
  // 명시적 저장 버튼(변경 시 하이라이트) — app.js [data-dirty-form] 공통.
  return `
    <form method="post" action="/projects/tasks/${task.id}" id="task-form-${task.id}" class="grid gap-2 sm:grid-cols-2" data-dirty-form>
      <div>
        <label class="label mb-0 text-xs">작업 종류<select class="input mt-0.5 block py-1.5 text-sm" name="task_type">${taskTypeOptions(task.task_type)}</select></label>
      </div>
      <div>
        <label class="label mb-0 text-xs">담당 엔지니어<select class="input mt-0.5 block py-1.5 text-sm" name="engineer_id">${engineerSelect(managers, task)}</select></label>
      </div>
      <div>
        <span class="label mb-0 text-xs">작업일 <span class="font-normal text-muted">(선택)</span></span>
        <div class="mt-0.5">${dateCombo("work_date", task.work_date || "", { label: "작업일", placeholder: "비우면 미정" })}</div>
      </div>
      <div>
        <label class="label mb-0 text-xs">곡명 <span class="font-normal text-muted">(비우면 프로젝트 이름)</span><input class="input mt-0.5 block py-1.5 text-sm" name="song_title" value="${esc(task.song_title || "")}" autocomplete="off" /></label>
      </div>
      <div>
        <label class="label mb-0 text-xs">곡 아티스트 <span class="font-normal text-muted">(프로젝트와 다를 때만)</span><input class="input mt-0.5 block py-1.5 text-sm" name="song_artist" value="${esc(task.song_artist || "")}" autocomplete="off" /></label>
      </div>
      <div data-worker-rate>
        <label class="label mb-0 text-xs">외주 지급단가 <span class="font-normal text-muted">(정산 기준 · 원)</span><input class="input mt-0.5 block py-1.5 text-sm" name="worker_rate" inputmode="numeric" placeholder="0" value="${esc(String(task.worker_rate || ""))}" /></label>
      </div>
      ${legacyName ? `<input type="hidden" name="engineer_name" value="${esc(legacyName)}" />` : ""}
      <div class="flex items-center justify-end gap-2 sm:col-span-2">
        <button class="btn-ghost btn-xs text-danger mr-auto" type="submit" form="del-task-${task.id}">작업 삭제</button>
        <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
        <button class="btn-primary btn-xs transition" type="submit" data-dirty-save>작업 저장</button>
      </div>
    </form>
    <form method="post" action="/projects/tasks/${task.id}/delete" id="del-task-${task.id}" data-confirm="이 작업을 삭제할까요?" class="hidden"></form>`;
}


/** 다음 단계 빠른 추가 — is_quick 종류 버튼(기본 단가 주입), +기타는 전체 활성 종류 그룹 + 금액 인라인 입력(0원 강제 방지). 추가하면 편집이 펼쳐져 조정할 수 있다. */
function taskQuickAdd(project, group) {
  const types = activeTaskTypes();
  const quickTypes = types.filter((t) => t.is_quick);
  const quick = (t) => `
    <form method="post" action="/projects/${project.id}/tasks">
      <input type="hidden" name="song_title" value="${esc(group.key)}" />
      <input type="hidden" name="task_type" value="${esc(t.key)}" />
      <input type="hidden" name="status" value="Pending" />
      <button class="rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary" type="submit">${esc(t.label)}</button>
    </form>`;
  const flatOptions = types.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join(""); // 분류 폐기 — optgroup 없이 평면 목록
  const other = `
    <details class="align-top">
      <summary class="cursor-pointer list-none rounded-md border border-border bg-bg btn-xs hover:border-primary hover:text-primary">+ 기타</summary>
      <form method="post" action="/projects/${project.id}/tasks" class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <input type="hidden" name="song_title" value="${esc(group.key)}" />
        <select class="input py-1.5 text-sm" name="task_type">${flatOptions}</select>
        <input type="hidden" name="status" value="Pending" />
        <button class="btn-primary btn-xs" type="submit">추가</button>
      </form>
    </details>`;
  return `
    <div class="mt-3">
      <div class="mb-1.5 text-xs text-muted">다음 단계 추가</div>
      <div class="flex flex-wrap items-center gap-1.5">${quickTypes.map(quick).join("")}${other}</div>
    </div>`;
}


module.exports = { artistCombo,
  newProjectMenu,
  projectListRow,
  projectTableHead,
  projectArtistOnly,
  projectIdentity,
  projectArtistLabel,
  projectSubLabel,
  projectRowHref,
  projectSummaryHtml,
  projectForm,
  projectMetaCard,
  projectMetaReadonly,
  tracksSection,
  sessionInvoicedModal,
  projectInfoFields,
  projectInfoSummary,
  engineerSelect,
  taskTypeOptions,
  defaultTaskType,
};
