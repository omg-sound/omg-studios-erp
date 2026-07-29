"use strict";

/** 관리(/settings) 렌더 — 환경설정·콘텐츠·담당자·시스템 탭 섹션 + 행 렌더러. src/routes/settings.routes.js에서 분리(2026-07-09, views.sessions.js·views.invoices.js 컨벤션). */

const { db } = require("./db");
const { isChief } = require("./auth");
const { config, ROLES, ROLE_LABELS, BILLING_TYPES, BILLING_TYPE_LABELS, RECORDING_CATEGORIES } = require("./config");
const {
  listProjectManagers,
  listRooms,
  listRateItems,
  listRateCategories,
  listTaskTypes,
  getStudioInfo,
  getStudioLogo,
  getProMinutes,
  getDefaultBooker,
} = require("./data");
const { esc, formatBytes, emptyState, detailsChevron } = require("./views");
const drive = require("./drive");
const calendar = require("./calendar");
const alerts = require("./notify");
const mailer = require("./mailer");
const { localFileCount, driveFileCount } = require("./lib/storage-migrate");
const fs = require("fs");
const path = require("path");
const { backupDir } = require("./lib/maintenance");
const { listAudit } = require("./lib/audit");
const { kstDateTime, kstYmd, todayYmd } = require("./lib/date"); // DB는 UTC — 표시는 KST(2026-07-20)
const { getState } = require("./db");

const RATE_KIND_LABELS = { recording: "녹음", filming: "촬영", performance: "공연" };

// 감사 로그 action → 화면 라벨(2026-07-20 인증 기록 추가와 함께). 여기 없는 action은 원문 그대로 보인다 —
// 새 action을 추가할 때 이 맵을 안 고쳐도 화면이 깨지지 않게(라벨은 읽기 편의일 뿐 진실원천은 action 문자열).
// 조회는 Object.hasOwn으로 — `AUDIT_LABELS["constructor"]`는 프로토타입 체인 때문에 함수 객체가 잡힌다.
const AUDIT_LABELS = {
  "auth.login": "구글 로그인",
  "auth.access": "접속",
  "auth.deny": "로그인 거부",
};

// 환경설정 그룹 카드 안의 섹션 블록(2026-07-09 사용자 요청 '스튜디오 운영·구글 연동이 자리를 너무 차지' —
// 섹션마다 .card 하나씩(p-5 × N)이던 것을 그룹당 카드 1개 + border-t 구분으로 압축, 제목도 text-lg→text-sm).
const SETTING_BLOCK = "space-y-3 border-t border-border pt-4 mt-4 first:mt-0 first:border-t-0 first:pt-0";

/**
 * 제목 옆 ⓘ — hover(또는 포커스)하면 설명이 말풍선으로 뜬다(2026-07-29 사용자 요청).
 * ⚠️경위: 2026-07-28 재설계 때는 반대로 **상시 노출**이었다(옛 `explain()`이 `<details>`로 접혀 판단 정보가
 * 클릭 뒤에 숨은 게 문제였다). 그 교정이 지나쳐 이번엔 **이미 아는 설명이 매번 화면 위를 차지**했고(요금표는
 * 세 줄), 사용자 요청으로 설정 화면 설명을 전부 이 ⓘ로 옮겼다. 상시 노출 헬퍼(settingDesc)는 소비처가 0이
 * 되어 제거했다 — 되살릴 일이 생기면 이 경위를 먼저 읽을 것.
 * ⚠️CSP상 인라인 스크립트가 없어 순수 CSS(.hint/.hint-body)로 연다. 마우스가 없는 환경(터치·키보드)에서도
 * 열려야 하므로 트리거가 `tabindex="0"`을 갖고 CSS가 `:focus-within`까지 본다. `html`은 신뢰 HTML(호출부 esc 책임).
 */
function settingHint(html, label = "설명 보기") {
  return `<span class="hint ml-1.5 align-middle" tabindex="0" role="note" aria-label="${esc(label)}">
    <span class="cursor-help text-sm text-muted hover:text-fg" aria-hidden="true">ⓘ</span>
    <span class="hint-body rounded-lg border border-border bg-surface p-3 text-xs font-normal leading-relaxed text-muted shadow-lg">${html}</span>
  </span>`;
}

/**
 * 설정 화면의 저장 줄 — dirty 패턴(바뀐 게 없으면 흐리고, 바뀌면 강조 + 미저장 힌트).
 * ⚠️`data-dirty-form`과 짝이다: 폼에 마커가 없으면 강조도, 다른 설정으로 이동할 때의 미저장 경고도 없다
 * (재설계 실측에서 예약 기본값·알림·스튜디오 정보 세 폼이 그 상태였다 — 통합 저장의 약속이 반만 지켜졌었다).
 */
/**
 * 인라인 편집 표를 **자체 가로 스크롤 영역**에 담는다.
 * ⚠️행이 고정 rem 열로 짜여 있어 좁은 패널에서는 줄어들지 않고 **잘린다** — 2026-07-29 실측에서 요금표 행(963px)이
 * 패널(729px) 밖으로 나가 순서·삭제 버튼에 손이 닿지 않았고, 1024px에서는 세 표 모두 그랬다. 페이지 가로
 * 오버플로우로도 안 잡힌다(바깥이 잘라 버려 documentElement는 멀쩡하다) — 그래서 눈에 안 띄었다.
 * 폭을 더 줄이는 대신 넘칠 때만 스크롤되게 해, 어떤 폭에서도 모든 컨트롤에 도달 가능하게 만든다.
 */
/**
 * 행 순서 이동 버튼(↑↓) — **행의 맨 오른쪽**에 둔다(2026-07-29 사용자 요청).
 * 삭제·비활성 같은 라벨 버튼은 글자 수가 행마다 달라(비활성/활성, 삭제/분류 삭제) 화살표가 그 앞에 있으면
 * 위치가 행마다 흔들린다. 맨 끝으로 보내면 오른쪽 가장자리에 맞춰 세로로 정렬된다.
 */
function moveButtons(upFormId, downFormId) {
  return `<button class="btn-ghost btn-xs px-2" type="submit" form="${upFormId}" aria-label="위로 이동">↑</button>
      <button class="btn-ghost btn-xs px-2" type="submit" form="${downFormId}" aria-label="아래로 이동">↓</button>`;
}

function scrollX(inner, innerClass = "space-y-2") {
  return `<div class="overflow-x-auto"><div class="${innerClass}">${inner}</div></div>`;
}

function saveRow(label = "저장") {
  return `<div class="flex items-center gap-2">
    <button class="btn-primary btn-sm transition" type="submit" data-dirty-save>${esc(label)}</button>
    <span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span>
  </div>`;
}

/** 단가 항목 카테고리 select 옵션 — kind(녹음/촬영/공연)별 optgroup, DB 분류 순서(2026-07-05 config 하드코딩에서 전환). current 선택 반영. */
function rateCategoryOptions(current = "") {
  const byKind = {};
  listRateCategories().forEach((c) => { (byKind[c.kind] = byKind[c.kind] || []).push(c); });
  return Object.keys(RATE_KIND_LABELS)
    .filter((k) => byKind[k] && byKind[k].length)
    .map((k) => `<optgroup label="${esc(RATE_KIND_LABELS[k])}">${byKind[k].map((c) => `<option value="${esc(c.name)}" ${c.name === current ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`)
    .join("");
}

/** 부트스트랩 치프(ADMIN_EMAIL)는 강등/비활성 불가 — 잠금 방지. */
function isBootstrapChief(user) {
  return Boolean(config.adminEmail) && user && user.email === config.adminEmail;
}

function listUsers() {
  // 연계된 작업 담당자(project_managers)의 전화를 함께 — 하우스 엔지니어 정보 수정 폼에 표시
  return db().prepare(`SELECT u.*, pm.phone AS mgr_phone FROM users u
       LEFT JOIN project_managers pm ON pm.user_id = u.id
       ORDER BY u.active DESC, u.role, u.email`).all();
}

/** 담당자 탭: 하우스 엔지니어(로그인 계정) 관리. */
function peopleTab(currentUser) {
  const chief = isChief(currentUser); // 로그인 계정 관리(추가·역할변경·삭제)는 치프 전용 — 스태프는 열람만(권한 상승 방지)
  const users = listUsers();
  const userRows = users.length ? users.map((u) => userRow(u, currentUser, chief)).join("") : emptyState("등록된 사용자가 없습니다.");
  const addForm = chief
    ? `<form method="post" action="/settings/users" class="space-y-2">
          <div class="grid gap-2 sm:grid-cols-2">
            <input class="input" name="user_name" placeholder="이름 (작업 담당자 표시명)" autocomplete="off" />
            <input class="input" type="email" name="email" placeholder="구글 이메일" required />
          </div>
          <div class="flex gap-2">
            <select class="input" name="role">
              ${ROLES.map((r) => `<option value="${esc(r)}" ${r === "staff" ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
            </select>
            <button class="btn-primary shrink-0" type="submit">엔지니어 추가</button>
          </div>
        </form>`
    : `<p class="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">로그인 계정 추가·역할 변경·삭제는 <span class="text-fg">치프 엔지니어</span>만 할 수 있습니다(열람만 가능).</p>`;
  return `
      <section class="card space-y-4">
        <div>
          <h2 class="font-display text-lg font-semibold">하우스 엔지니어 <span class="text-sm font-normal text-muted">(로그인 계정)</span>${settingHint(`등록한 구글 계정만 로그인할 수 있고, <span class="text-fg">작업 담당자에 자동으로 포함</span>됩니다. 치프는 전체, 스태프는 프로젝트·작업·자료까지.`, "하우스 엔지니어 (로그인 계정) 설명")}</h2>
        </div>
        ${addForm}
        <div class="space-y-2">${userRows}</div>
      </section>`;
      // (외주 작업자 안내 카드는 2026-07-09 제거 — /workers 일원화(07-01) 직후의 과도기 안내였고,
      //  사이드바에 외주 작업자 메뉴가 상시 노출돼 중복. 담당자 탭 = 로그인 계정 관리로 정체성 정리.)
}

/**
 * 요금표 트리 — **분류(어미) → 단가 항목(하위)** 2단(2026-07-29 사용자 결정, 지메일 라벨식).
 * 옛 구조는 목록이 분류로 묶여 있으면서 정작 분류 자체는 아래쪽 접이식 '분류 관리'에서 따로 고쳐야 했고,
 * 순서는 종류(녹음/촬영/공연)로 먼저 갈려 자유롭게 배치할 수 없었다 — 한 화면에서 다 되게 합쳤다.
 * 분류 행이 곧 편집 행(이름·종류·↑↓·삭제)이고, 그 아래에 그 분류의 항목들과 '+ 항목 추가' 줄이 붙는다.
 * ⚠️저장 버튼은 트리 전체에 하나(호출부의 통합 저장) — 행마다 저장을 두지 않는다.
 * 반환 {list, actionForms}: actionForms는 ↑↓·삭제용 형제 hidden 폼(중첩 폼 금지라 통합 저장 폼 밖에 둔다).
 */
function ratesTree(rates) {
  const cats = listRateCategories();
  const byCat = {};
  rates.forEach((r) => { (byCat[r.category || ""] = byCat[r.category || ""] || []).push(r); });
  // 등록된 분류에 속하지 않는 항목(분류를 지웠거나 옛 데이터)도 잃어버리지 않게 맨 아래 묶음으로 보여준다.
  const known = new Set(cats.map((c) => c.name));
  const orphanNames = Object.keys(byCat).filter((n) => !known.has(n));

  const itemRows = (name) => {
    const items = byCat[name] || [];
    return `<div class="space-y-1.5">${items.map((r) => rateItemRow(r)).join("")
      || `<p class="px-2 py-1 text-xs text-muted">항목 없음</p>`}</div>`;
  };

  const list = cats.map((c) => `
    <div class="rounded-lg border border-border">
      ${rateCategoryRow(c)}
      <!-- 하위 항목은 왼쪽 선 + 들여쓰기로 어미와 구분한다(지메일 라벨식 계층 표시). -->
      <div class="space-y-1.5 border-t border-border py-2 pl-2 pr-1 sm:pl-6">
        ${itemRows(c.name)}
        ${rateItemAddRow(c)}
      </div>
    </div>`).join("")
    + orphanNames.map((n) => `
    <div class="rounded-lg border border-warning/40">
      <div class="flex items-center gap-2 px-3 py-2 text-sm">
        <span class="font-medium">${esc(n)}</span>
        <span class="badge badge-warning">등록되지 않은 분류</span>
        <span class="text-xs text-muted">아래 항목의 분류를 바꾸거나 같은 이름으로 분류를 추가하세요.</span>
      </div>
      <div class="space-y-1.5 border-t border-border p-2">${itemRows(n)}</div>
    </div>`).join("");

  const actionForms = rates.map((r) => rateItemActionForms(r)).join("") + cats.map(rateCategoryActionForms).join("");
  return { list: list || emptyState("등록된 분류가 없습니다. 아래에서 분류를 먼저 추가하세요."), actionForms };
}

/**
 * 분류 관리 행 — 기본 분류도 같은 편집 행을 쓴다(2026-07-29 잠금 해제. 근거였던 '코드가 이름에 의존'이
 * 사실이 아니었고, 남은 보호인 '사용 중이면 삭제 거부'는 데이터 계층이 지킨다).
 * ⚠️저장 버튼은 행에 없다 — 섹션 하나에 통합 저장 하나(단가 항목·룸·작업 종류와 같은 규칙). 행 액션
 * (↑↓·삭제)만 `form=`으로 형제 hidden 폼을 가리킨다(중첩 폼 금지).
 */
function rateCategoryRow(c) {
  const kindOpts = Object.entries(RATE_KIND_LABELS).map(([k, l]) => `<option value="${k}" ${k === c.kind ? "selected" : ""}>${esc(l)}</option>`).join("");
  return `<div class="flex flex-wrap items-center gap-2 rounded-t-lg bg-bg px-3 py-2" id="rate-cat-${c.id}">
    <input class="input w-48 py-1 text-sm font-semibold" name="cat_name_${c.id}" value="${esc(c.name)}" aria-label="분류명" autocomplete="off" required />
    <select class="input w-28 py-1 text-sm" name="kind_${c.id}" aria-label="세션 종류">${kindOpts}</select>
    <span class="ml-auto flex shrink-0 items-center gap-1">
      <button class="btn-ghost btn-xs whitespace-nowrap text-danger" type="submit" form="cat-del-${c.id}">분류 삭제</button>
      ${moveButtons(`cat-mv-u-${c.id}`, `cat-mv-d-${c.id}`)}
    </span>
  </div>`;
}

/**
 * 분류 안의 '+ 항목 추가' 줄 — 분류가 정해져 있으므로 분류 select 없이 hidden으로 넘긴다(옛 전역 추가 행은
 * 매번 분류를 골라야 했다). 편집 행과 같은 2줄 모양이라 추가할 때와 추가된 뒤가 같아 보인다.
 */
function rateItemAddRow(cat) {
  // ⚠️트리 전체가 통합 저장 폼 안이라 여기에 <form>을 두면 중첩 폼이 된다(브라우저가 내부 폼을 버려
  // '추가'가 통합 저장을 제출해 버린다) — 행 액션(↑↓·삭제)과 같은 form= 참조 방식으로 뺀다.
  const f = `form="rate-add-${cat.id}"`;
  return `
    <div class="space-y-1 rounded-lg border border-dashed border-border p-2">
      <div class="flex flex-wrap items-center gap-2">
        <input class="input min-w-0 flex-1 py-1.5 text-sm sm:max-w-[16rem]" ${f} name="rate_name" placeholder="+ 새 항목 이름" aria-label="단가 항목명" autocomplete="off" />
        <span class="text-xs text-muted">이 분류에 추가</span>
        <span class="ml-auto shrink-0"><button class="btn-ghost btn-xs whitespace-nowrap" type="submit" ${f}>추가</button></span>
      </div>
      ${chargeLine({ baseHours: "base_hours", basePrice: "base_price", extraHours: "extra_hours", extraPrice: "extra_price" },
                   { baseHours: "", basePrice: "", extraHours: 1, extraPrice: "" }, f)}
    </div>`;
}

/** 분류 행의 형제 hidden 액션 폼(↑↓·삭제) — 통합 저장 폼 밖에 렌더해 중첩 폼 회피. */
function rateCategoryActionForms(c) {
  return `
    <form id="cat-mv-u-${c.id}" method="post" action="/settings/rate-categories/${c.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="cat-mv-d-${c.id}" method="post" action="/settings/rate-categories/${c.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="cat-del-${c.id}" method="post" action="/settings/rate-categories/${c.id}/delete" hidden data-confirm="'${esc(c.name)}' 분류를 삭제할까요? 이 분류를 쓰는 단가 항목이 있으면 삭제할 수 없습니다."></form>
    <form id="rate-add-${c.id}" method="post" action="/settings/rate-items" hidden><input type="hidden" name="category" value="${esc(c.name)}" /></form>`;
}

/**
 * 요금표 화면 — 분류(어미) → 단가 항목(하위) 2단 트리 하나(2026-07-29). 옛 '분류 관리' 접이식 섹션은
 * 폐지했다(같은 대상을 두 곳에서 고치게 만들던 구조).
 */
function ratesPane() {
  const rates = listRateItems({ includeInactive: true });
  const t = ratesTree(rates);
  const kindOpts = Object.entries(RATE_KIND_LABELS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  return `
      <section class="card space-y-4" id="rates-section">
        <div>
          <h2 class="font-display text-lg font-semibold">요금표 · 녹음/촬영 종류${settingHint(`대관 세션의 시간제 단가입니다. <b>분류</b>가 어미고 그 아래에 단가 항목이 들어갑니다 — 분류의 <b>세션 종류</b>(녹음·촬영·공연)가 세션 예약 폼에서 어떤 항목을 보여줄지 정합니다. 기준 시간(1Pro) 안은 기준가, 초과는 단위 시간당 추가 과금 — <b>기준 시간을 비우면 정액(회당)</b>, 가격까지 비우면 <b>금액 미정</b>(청구 시 입력).<br>↑↓ 순서는 자유이고(분류끼리 종류가 달라도 섞어 배치 가능) 이 순서가 세션 예약 폼의 항목 순서가 됩니다.`, "요금표 설정 설명")}</h2>
        </div>
        ${scrollX(`        <form method="post" action="/settings/rates/bulk" id="rates-bulk-form" class="space-y-2" data-dirty-form>
          ${t.list}
          ${saveRow("통합 저장")}
        </form>`)}
        ${t.actionForms}
        <form method="post" action="/settings/rate-categories" class="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
          <input class="input w-48 py-1 text-sm" name="cat_name" placeholder="+ 새 분류 이름" aria-label="분류명" autocomplete="off" required />
          <select class="input w-28 py-1 text-sm" name="kind" aria-label="세션 종류">${kindOpts}</select>
          <button class="btn-ghost btn-xs shrink-0" type="submit">분류 추가</button>
        </form>
      </section>`;
}

/** 작업 종류 화면 — 곡·콘텐츠 후반작업 카탈로그. 옛 contentTab의 뒷부분(2026-07-28 분리). */
function taskTypesPane() {
  const taskTypes = listTaskTypes({ includeInactive: true });
  return `
      <section class="card space-y-4" id="task-types-section">
        <div>
          <h2 class="font-display text-lg font-semibold">작업 종류 <span class="text-sm font-normal text-muted">(곡·콘텐츠 후반작업)</span>${settingHint(`곡·콘텐츠의 작업 종류(보컬튠·믹싱·마스터링 등)와 기본 단가를 관리합니다. '빠른추가'를 켜면 곡·콘텐츠 화면의 빠른 추가 버튼에 노출됩니다. 시간이 아니라 작업량으로 산정하는 항목이라 요금표(대관 세션)와 카탈로그가 분리돼 있습니다. 기본 단가는 작업을 만들 때 자동으로 채워지는 값이고, 실제 금액은 청구 화면에서 확정합니다.`, "작업 종류 설정 설명")}</h2>
        </div>
        ${(() => {
          // 단가표와 같은 규칙 — 추가 폼은 목록의 첫 행이고 편집 행과 같은 2줄 모양이다(열 제목 줄 없음).
          const addRow = `
        <form method="post" action="/settings/task-types" class="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-2">
          <input class="input min-w-0 flex-1 py-1.5 text-sm sm:max-w-[14rem]" name="label" placeholder="+ 새 작업 종류 이름 (예: 보컬튠)" aria-label="작업 종류명" required />
          <select class="input w-36 py-1.5 text-sm" name="billing_type" aria-label="과금">
            ${BILLING_TYPES.map((b) => `<option value="${esc(b)}">${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
          </select>
          ${taskPriceInline({ unitPrice: "unit_price", isQuick: "is_quick" }, {})}
          <span class="ml-auto shrink-0"><button class="btn-ghost btn-xs whitespace-nowrap" type="submit">추가</button></span>
        </form>`;
          if (!taskTypes.length) return scrollX(addRow, "space-y-1.5") + emptyState("등록된 작업 종류가 없습니다.");
          return `
        ${scrollX(`${addRow}
        <form method="post" action="/settings/task-types/bulk" id="task-types-bulk-form" class="space-y-1.5 pt-1" data-dirty-form>
          ${taskTypes.map((t) => taskTypeRow(t)).join("")}
          <div class="flex items-center gap-2"><button class="btn-primary btn-sm transition" type="submit" data-dirty-save>통합 저장</button><span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span></div>
        </form>`, "space-y-1.5")}
        ${taskTypes.map((t) => taskTypeActionForms(t)).join("")}`;
        })()}
      </section>`;
}

/** 자료 저장(구글 Drive) 상태 + 로컬→Drive 이관. 최소 권한(drive.file)으로 앱 전용 폴더에만 저장. */
function driveStorageSection() {
  const linked = drive.isLinked();
  const localN = localFileCount();
  let status;
  if (linked) {
    status = `<p class="text-sm"><span class="badge badge-success">연결됨</span> 첨부 서류·자료 전달 파일이 <span class="font-medium">공유 드라이브 omg-studios-erp</span>에 저장됩니다. <span class="text-muted">소유자는 조직이라 담당자 계정이 바뀌어도 남습니다.</span></p>
      <p class="text-xs text-muted">전용 서비스 계정으로 접근합니다 — 사람이 로그인해 연결하는 방식이 아닙니다. 설정은 배포 환경변수(<code>GOOGLE_SA_KEY</code>·<code>DRIVE_ERP_DRIVE_ID</code>)로만 바꿉니다.</p>`;
  } else {
    status = `<p class="text-sm text-muted"><span class="badge badge-warning">미설정</span> 지금은 파일이 <span class="font-medium">서버 로컬 디스크</span>에 저장됩니다. 배포 환경변수 <code>GOOGLE_SA_KEY</code>·<code>DRIVE_ERP_DRIVE_ID</code>를 설정하면 공유 드라이브 저장이 켜집니다.</p>`;
  }
  const driveN = linked ? driveFileCount() : 0;
  const migrate = linked && localN > 0
    ? `<form method="post" action="/settings/migrate-drive" data-confirm="로컬에 저장된 파일 ${localN}개를 구글 Drive로 이관할까요? 업로드 성공 시 로컬 원본은 삭제됩니다."><button class="btn-primary btn-sm" type="submit">로컬 파일 ${localN}개 → Drive 이관</button></form>`
    : linked
      ? `<p class="text-xs text-muted">로컬에 남은 파일이 없습니다 · Drive 저장 ${driveN}개.</p>`
      : "";
  const check = linked
    ? `<div class="flex flex-wrap gap-2 border-t border-border pt-2"><a class="btn-ghost btn-sm" href="/settings/drive-check">Drive 연결 테스트 (폴더·업로드 확인) ↗</a></div>`
    : "";
  return `<div class="${SETTING_BLOCK}">
    <div>
      <h2 class="text-sm font-semibold">자료 저장 (구글 Drive)${settingHint(`첨부 서류·자료 전달 파일의 저장 위치. 조직 소유 <span class="text-fg">공유 드라이브</span>라 담당자 계정이 바뀌어도 서류가 남습니다(민감 서류가 있어 다른 앱과 분리).`, "자료 저장 (구글 Drive) 설명")}</h2>
    </div>
    ${status}${migrate}${check}
  </div>`;
}

/** 스튜디오 캘린더(구글) 선택 섹션 — 세션 겹침 검사 대상. */
async function studioCalendarSection(chief = false) {
  const title = `<div>
      <h2 class="text-sm font-semibold">스튜디오 캘린더 (구글)${settingHint(`<span class="text-fg font-medium">세션을 예약하면 이 캘린더에 일정이 자동 생성·수정·삭제됩니다.</span> <span class="text-warning font-medium">'사용 안 함'이면 자동 연동이 꺼집니다.</span> 개인 일정과 섞이지 않게 스튜디오 전용 캘린더를 권장합니다.`, "스튜디오 캘린더 (구글) 설명")}</h2>
    </div>`;
  let inner;
  if (!config.googleConfigured) {
    inner = `<p class="text-sm text-muted">Google OAuth가 설정되지 않았습니다.</p>`;
  } else if (!drive.isOAuthLinked()) {
    // 캘린더는 관리자 OAuth 토큰을 쓴다(Drive 서비스 계정과 별개).
    inner = `<p class="text-sm text-muted">구글 계정 연동이 필요합니다. <a class="text-primary hover:underline" href="/auth/google">구글 계정 연동(캘린더 권한 포함)</a> 후 다시 시도하세요.</p>`;
  } else {
    const calendars = await calendar.listCalendars();
    const current = calendar.getStudioCalendarId();
    if (calendars.length === 0) {
      inner = `<p class="text-sm text-muted">캘린더 목록을 불러오지 못했습니다. 캘린더 읽기 권한이 없을 수 있습니다 — <a class="text-primary hover:underline" href="/auth/google">구글 계정 재연동</a>으로 권한을 다시 허용하세요.</p>`;
    } else {
      const statusBadge = current
        ? `<p class="mb-2 text-sm text-success">✓ 자동 연동 켜짐 — 새 세션이 이 캘린더에 자동 등록됩니다.</p>`
        : `<p class="mb-2 text-sm text-warning">⚠ 자동 연동 꺼짐 — 아래에서 스튜디오 캘린더를 선택해야 구글 캘린더로 넘어갑니다.</p>`;
      inner = `${statusBadge}<form method="post" action="/settings/studio-calendar" class="flex gap-2">
          <select class="input" name="calendar_id">
            <option value="" ${current ? "" : "selected"}>사용 안 함 (캘린더 자동 연동 끔)</option>
            ${calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === current ? "selected" : ""}>${esc(c.summary)}${c.primary ? " · 기본" : ""}</option>`).join("")}
          </select>
          <button class="btn-primary shrink-0" type="submit">저장</button>
        </form>`;
      if (current && chief) {
        // 이미 만들어진 캘린더 일정의 제목·설명을 현재 로직(예: 아티스트 먼저 표기)으로 다시 맞춘다 — 1회성 관리 액션(치프 전용 라우트, resync는 requireChief).
        inner += `<form method="post" action="/settings/resync-calendar" class="mt-2 border-t border-border pt-3" data-confirm="예정된(취소 제외) 세션의 캘린더 일정을 지금 로직으로 전부 다시 씁니다. 계속할까요?">
            <button class="btn-ghost btn-sm" type="submit">기존 캘린더 일정 다시 동기화</button>
            <p class="mt-1 text-xs text-muted">제목·설명 표기 방식을 바꾼 뒤(예: 아티스트 표기 순서) 이미 등록된 일정에도 반영하고 싶을 때 누르세요.</p>
          </form>`;
      }
    }
  }
  // ⚠️ '기본 장소'(예약 시 일정 장소 자동 입력)는 2026-07-28까지 이 섹션에 있었으나, 실제로는
  //  세션 예약의 기본값(pro-minutes·default-booker와 같은 성격)이라 '예약 기본값' 화면으로 옮겼다
  //  (bookingDefaultsSection). 이 섹션은 구글 캘린더 연동(어느 캘린더에 동기화할지)에만 집중.
  return `<div class="${SETTING_BLOCK}">${title}${inner}</div>`;
}

/**
 * 룸(스튜디오 공간) 관리 — 추가·이름 수정·순서 이동·삭제. 룸별 시간 겹침 검사의 기준.
 * 계층(상위/하위)은 2026-07-28 폐지 — 목록은 sort_order 한 축의 평면 나열이다(src/data/rooms.js 참조).
 */
function roomsSection() {
  const rooms = listRooms({ includeInactive: true });
  const rows = rooms.length ? rooms.map((r) => roomRow(r)).join("") : emptyState("등록된 룸이 없습니다.");
  return `
    <div class="${SETTING_BLOCK}" id="rooms-section">
      <div>
        <h2 class="mb-3 text-sm font-semibold">장소 (스튜디오 룸 · 외부)${settingHint(`<span class="text-fg">같은 장소끼리만</span> 세션 시간 겹침을 검사합니다(다른 장소는 같은 시간에 나란히 예약 가능). <b>예약 대상</b>을 끄면 세션 폼 장소 목록에서 빠지고(예: Lounge), <b>외부</b>로 표시하면 주소 입력칸이 나옵니다. 이름은 고쳐도 그 장소로 잡힌 세션이 유지됩니다(지웠다 만들면 '장소 미지정'이 됩니다).`, "장소 설정 설명")}</h2>
      </div>
      <form method="post" action="/settings/rooms" class="flex flex-wrap items-center gap-2">
        <input class="input py-1.5 text-sm" name="room_name" placeholder="장소 이름 (예: Studio D · 외부일정)" autocomplete="off" required />
        <label class="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" name="bookable" value="1" checked class="h-4 w-4 rounded border-border text-primary" /> 예약 대상</label>
        <label class="flex cursor-pointer items-center gap-1.5 text-sm"><input type="checkbox" name="is_external" value="1" class="h-4 w-4 rounded border-border text-primary" /> 외부 장소(주소 입력)</label>
        <button class="btn-primary shrink-0 btn-sm" type="submit">장소 추가</button>
      </form>
      ${rooms.length ? `
      <form method="post" action="/settings/rooms/bulk" id="rooms-bulk-form" class="space-y-1.5" data-dirty-form>
        ${scrollX(rows, "space-y-1.5")}
        <div class="flex items-center gap-2"><button class="btn-primary btn-sm transition" type="submit" data-dirty-save>통합 저장</button><span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span></div>
      </form>
      ${rooms.map((r) => roomActionForms(r)).join("")}` : rows}
    </div>`;
}

/**
 * 룸 행 = 한 줄 인라인 편집(2026-07-27 통합 저장 / 2026-07-28 wide에서 한 줄 보정 · 계층 폐지로 들여쓰기 제거).
 * ⚠️읽기 폭(768)에서는 `flex-wrap`+이름칸 `flex-1`(상한 없음)이 남는 폭을 전부 먹어 한 룸이 3줄로 감겼다 —
 * wide 전환으로 여유 폭은 생겼지만, 데스크톱에서 확실히 한 줄이 되도록 `sm:flex-nowrap` + 이름칸 상한(`sm:max-w-xs`)을 더한다.
 * 모바일(<640px)은 현행 flex-wrap 그대로(감김 허용).
 */
function roomRow(r) {
  return `
    <div class="flex flex-wrap items-center gap-2 rounded-lg bg-bg p-2 sm:flex-nowrap" id="room-${r.id}">
      <input class="input min-w-36 flex-1 py-1.5 text-sm sm:max-w-xs" name="room_name_${r.id}" value="${esc(r.name)}" aria-label="장소 이름" autocomplete="off" required />
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm sm:shrink-0"><input type="checkbox" name="bookable_${r.id}" value="1" ${r.bookable ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary" /> 예약 대상</label>
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm sm:shrink-0"><input type="checkbox" name="is_external_${r.id}" value="1" ${r.is_external ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary" /> 외부</label>
      <span class="ml-auto flex shrink-0 items-center gap-1">
        <button class="btn-ghost btn-xs whitespace-nowrap text-danger" type="submit" form="room-del-${r.id}">삭제</button>
        ${moveButtons(`room-mv-u-${r.id}`, `room-mv-d-${r.id}`)}
      </span>
    </div>`;
}

/** 룸 행의 형제 hidden 액션 폼(↑↓·삭제) — bulk 폼 밖에 렌더해 중첩 폼 회피. */
function roomActionForms(r) {
  return `
    <form id="room-mv-u-${r.id}" method="post" action="/settings/rooms/${r.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="room-mv-d-${r.id}" method="post" action="/settings/rooms/${r.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="room-del-${r.id}" method="post" action="/settings/rooms/${r.id}/delete" hidden data-confirm="'${esc(r.name)}' 장소를 삭제할까요? 이 장소로 예약된 세션은 '장소 미지정'으로 바뀝니다. 이름만 고치려면 이름 칸을 고쳐 통합 저장하세요."></form>`;
}

/**
 * 예약 기본값 화면(2026-07-28 통합) — 기본 세션 시간·예약 담당자·기본 장소, 셋 다 새 세션을 예약할 때
 * 자동으로 채워지는 값이라 한 폼·한 저장 버튼으로 묶는다(POST /settings/booking-defaults).
 * '기본 장소'는 원래 구글 캘린더 섹션에 끼어 있었으나, 실제로는 세션의 캘린더 이벤트 장소 기본값(위치는
 * eventInputForSession의 session.location 폴백)이라 예약 기본값과 같은 성격 — 여기로 옮겼다(옛 '운영시간'
 * 폼은 2026-07-27 제거 — 그리드가 날짜·시간 콤보로 바뀐 뒤 저장값을 읽는 화면·검증이 하나도 없어졌었다).
 */
function bookingDefaultsSection() {
  const cur = getDefaultBooker() || "";
  const managers = listProjectManagers();
  return `
    <section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">예약 기본값${settingHint(`새 세션을 예약할 때 자동으로 채워지는 값입니다.`, "예약 기본값 설명")}</h2>
      </div>
      <form method="post" action="/settings/booking-defaults" class="space-y-3" data-dirty-form>
        <div>
          <label class="label-sm">기본 세션 시간 <span class="font-normal text-muted">(녹음 외 세션[믹싱·마스터링·기타]의 소요시간 슬라이더 기본값)</span></label>
          <div class="flex items-center gap-2">
            <input class="input w-28 py-1.5 text-sm" name="pro_hours" type="number" step="0.5" min="0.5" value="${esc(String(getProMinutes() / 60))}" placeholder="3.5" />
            <span class="text-sm text-muted">시간</span>
          </div>
        </div>
        <div>
          <label class="label mb-0.5 text-xs">예약 담당자 <span class="font-normal text-muted">(세션 예약 폼에서 기본 선택)</span></label>
          <select class="input py-1.5 text-sm" name="default_booker">
            <option value="">지정 안 함</option>
            ${managers.map((m) => `<option value="${esc(m.name)}" ${m.name === cur ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="label mb-0.5 text-xs">기본 장소 <span class="font-normal text-muted">(예약 시 일정 장소로 자동 입력)</span></label>
          <input class="input py-1.5 text-sm" name="studio_location" value="${esc(calendar.getStudioLocation())}" placeholder="예: OMG 스튜디오 (서울 ...)" />
        </div>
        ${saveRow()}
      </form>
    </section>`;
}

/** 공급자(스튜디오) 세금정보 — 거래명세서 PDF의 '공급자'란. */
function studioInfoSection() {
  const s = getStudioInfo();
  const logo = getStudioLogo();
  const field = (name, label, ph = "") =>
    `<div><label class="label mb-0.5 text-xs">${esc(label)}</label><input class="input py-1.5 text-sm" name="${esc(name)}" value="${esc(s[name] || "")}" placeholder="${esc(ph)}" /></div>`;
  return `
    <div class="${SETTING_BLOCK}">
      <div>
        <h2 class="text-sm font-semibold">공급자(스튜디오) 세금정보${settingHint(`발행된 청구의 <span class="text-fg">거래명세서 PDF</span> '공급자'란에 들어갑니다. (세금계산서가 아닌 참고용 문서)`, "공급자(스튜디오) 세금정보 설명")}</h2>
      </div>
      <form method="post" action="/settings/studio-info" class="space-y-2" data-dirty-form>
        <div class="grid gap-2 sm:grid-cols-2">
          ${field("studio_biz_name", "상호", "OMG 스튜디오")}
          ${field("studio_biz_no", "사업자등록번호", "000-00-00000")}
          ${field("studio_owner_name", "대표자")}
          ${field("studio_tel", "연락처")}
          ${field("studio_biz_type", "업태", "서비스")}
          ${field("studio_biz_item", "종목", "음반녹음")}
        </div>
        <div><label class="label mb-0.5 text-xs">사업장 주소</label><input class="input py-1.5 text-sm" name="studio_address" value="${esc(s.studio_address || "")}" /></div>
        ${saveRow("공급자 정보 저장")}
      </form>
      <div class="border-t border-border pt-4">
        <label class="label mb-1 text-xs">로고 <span class="font-normal text-muted">(거래명세서 PDF 우측 상단 · PNG/JPG, 최대 2MB)</span></label>
        ${logo
          ? `<div class="mb-2"><img src="${esc(logo)}" alt="로고" class="max-h-20 rounded border border-border bg-white p-2" /></div>`
          : `<p class="mb-2 text-xs text-muted">등록된 로고가 없습니다.</p>`}
        <div class="flex flex-wrap items-center gap-2">
          <!-- ⚠️파일 입력은 고유 폭이 커서(파일명·버튼 포함) 좁은 화면에서 폼을 밀어낸다 — 390px에서 16px 넘쳤다.
               min-w-0 + flex-1로 남는 폭에 맞추고, 좁으면 업로드 버튼이 아랫줄로 감기게 한다. -->
          <form method="post" action="/settings/studio-logo" enctype="multipart/form-data" class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <input class="min-w-0 flex-1 text-sm sm:flex-none" type="file" name="logo" accept="image/png,image/jpeg" required />
            <button class="btn-primary btn-sm" type="submit">로고 업로드</button>
          </form>
          ${logo ? `<form method="post" action="/settings/studio-logo/delete" data-confirm="로고를 삭제할까요?"><button class="btn-ghost btn-xs text-danger" type="submit">로고 삭제</button></form>` : ""}
        </div>
      </div>
    </div>`;
}

/**
 * 알림 화면(2026-07-28 통합) — 웹훅(Slack/Discord)과 청구 알림 이메일을 한 폼·한 저장 버튼으로.
 * 테스트 발송(웹훅·이메일 각각)은 값 편집이 아니라 액션이라 별도 버튼으로 유지(POST /settings/alert-webhook/test·/alert-email/test).
 * ⚠️둘 다 치프 전용이다 — 저장 라우트(POST /settings/alerts)는 requireChief. 스태프는 상태만 열람.
 */
function alertsSection(chief = true) {
  const url = alerts.getConfiguredWebhook();
  const envNote = alerts.envWebhookActive()
    ? `<p class="mt-1 text-xs text-warning">환경변수 ALERT_WEBHOOK가 설정되어 우선 적용됩니다(아래 입력값은 무시).</p>`
    : "";
  const canTestWebhook = url || alerts.envWebhookActive();

  const raw = mailer.getRecipientsRaw();
  const list = mailer.getRecipients();
  const linked = Boolean(mailer.gmailClient());
  const linkNote = !linked
    ? `<p class="mt-1 text-xs text-warning">구글 미연동 — 자료 저장(구글 Drive) 연결 후 발송됩니다.</p>`
    : `<p class="mt-1 text-xs text-muted">발신: <span class="text-fg">${esc(config.studioDriveEmail)}</span></p>`;
  const emailStatus = list.length
    ? `<p class="text-sm">현재 수신: <span class="font-semibold text-fg">${esc(list.join(", "))}</span> <span class="text-xs text-muted">(${list.length}명)</span></p>`
    : `<p class="text-sm text-muted">수신 주소 미설정 — 청구 알림 메일이 발송되지 않습니다.</p>`;

  if (!chief) {
    return `<section class="card space-y-4">
      <div>
        <h2 class="font-display text-lg font-semibold">알림${settingHint(`청구 발행·자료 공유 시 팀에 알리는 두 채널(웹훅·청구 알림 이메일)입니다. 변경은 <span class="text-fg">치프 엔지니어</span>만 할 수 있습니다.`, "알림 설명")}</h2>
      </div>
      <p class="text-sm text-muted">알림 웹훅 ${url || alerts.envWebhookActive() ? "설정됨" : "미설정"}</p>
      ${emailStatus}
    </section>`;
  }

  return `<section class="card space-y-4">
    <div>
      <h2 class="font-display text-lg font-semibold">알림${settingHint(`청구 발행·자료 공유 시 팀에 알립니다 — Slack/Discord 웹훅과 청구 알림 이메일(청구번호·청구처·금액 + 바로가기)을 함께 관리합니다.`, "알림 설명")}</h2>
    </div>
    <form method="post" action="/settings/alerts" class="space-y-3" data-dirty-form>
      <div>
        <label class="label mb-0.5 text-xs">알림 웹훅 <span class="font-normal text-muted">(Incoming Webhook URL · 비우면 끔 · 저장 시 암호화)</span></label>
        <input class="input py-1.5 text-sm" name="webhook_url" value="${esc(url)}" placeholder="https://hooks.slack.com/services/..." />
        ${envNote}
      </div>
      <div>
        <label class="label mb-0.5 text-xs">청구 알림 이메일 <span class="font-normal text-muted">(콤마로 여러 명 · 비우면 끔)</span></label>
        <input class="input py-1.5 text-sm" name="alert_email" value="${esc(raw)}" placeholder="owner@omgworks.kr, chief@omgworks.kr" />
        ${linkNote}
      </div>
      ${saveRow()}
    </form>
    ${emailStatus}
    <div class="flex flex-wrap gap-2 border-t border-border pt-3">
      ${canTestWebhook ? `<form method="post" action="/settings/alert-webhook/test"><button class="btn-ghost btn-sm" type="submit">웹훅 테스트 알림 보내기</button></form>` : ""}
      ${list.length ? `<form method="post" action="/settings/alert-email/test"><button class="btn-ghost btn-sm" type="submit">이메일 테스트 발송</button></form>` : ""}
    </div>
  </section>`;
}

/**
 * last_login(UTC) → '오늘/어제/N일 전/미로그인' 표시(계정 위생, 2026-07-09 관리 개선).
 * ⚠️**KST 달력 날짜 차이**로 센다(2026-07-20) — 경과 시간(밀리초 나눗셈)으로 세면 20시간 전 로그인이
 * 어제였는데도 '오늘'로 나온다. '오늘/어제'는 시계가 아니라 달력의 말이다.
 */
function lastLoginLabel(iso) {
  if (!iso) return "";
  const day = kstYmd(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const days = Math.round((Date.parse(`${todayYmd()}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  if (!isFinite(days)) return "";
  const label = days <= 0 ? "오늘" : days === 1 ? "어제" : `${days}일 전`;
  return `<span class="whitespace-nowrap">로그인 ${label}</span>`;
}

function userRow(u, currentUser, chief = true) {
  const isSelf = u.id === currentUser.id;
  const delLocked = isBootstrapChief(u) || isSelf; // 삭제·비활성: 기본 치프·본인 보호(락아웃 방지). 역할 변경은 본인만 잠금.
  const status = !u.active
    ? `<span class="badge bg-muted/10 text-muted">비활성</span>`
    : u.google_sub
      ? `<span class="badge bg-success/10 text-success">활성</span>`
      : `<span class="badge bg-warning/10 text-warning">초대됨(미로그인)</span>`;
  const roleControl = (!chief || isSelf)
    ? `<span class="badge bg-bg text-muted">${esc(ROLE_LABELS[u.role] || u.role)}</span>` // 스태프 또는 본인 — 역할 변경 불가(배지만)
    : `<form method="post" action="/settings/users/${u.id}/role">
         <select class="input py-1 text-xs" name="role" data-autosubmit>
           ${ROLES.map((r) => `<option value="${esc(r)}" ${r === u.role ? "selected" : ""}>${esc(ROLE_LABELS[r] || r)}</option>`).join("")}
         </select>
       </form>`;
  const del = (!chief || delLocked)
    ? ""
    : `<form method="post" action="/settings/users/${u.id}/delete" data-confirm="${esc(u.name || u.email)} 계정을 삭제할까요? 로그인 화이트리스트와 작업 담당자에서 제거됩니다.">
         <button class="btn-ghost btn-xs text-danger" type="submit">삭제</button>
       </form>`;
  return `
    <div class="rounded-lg border border-border bg-bg p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate font-medium">${esc(u.name || u.email)}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span class="truncate">${esc(u.email)}</span>${status}${lastLoginLabel(u.last_login)}${isSelf ? `<span class="text-muted">${esc(ROLE_LABELS[u.role] || u.role)} · 본인</span>` : isBootstrapChief(u) ? `<span class="text-muted">· 기본 계정(삭제 불가)</span>` : ""}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          ${roleControl}
          ${del}
        </div>
      </div>
      ${chief ? `<details class="mt-2">
        <summary class="cursor-pointer text-xs text-muted hover:text-fg">정보 수정 (이름 · 전화)</summary>
        <form method="post" action="/settings/users/${u.id}/edit" class="mt-2 grid gap-2 sm:grid-cols-2">
          <input class="input py-1.5 text-sm" name="user_name" value="${esc(u.name || "")}" placeholder="이름 (표시명)" autocomplete="off" />
          <input class="input py-1.5 text-sm" name="phone" autocomplete="off" value="${esc(u.mgr_phone || "")}" placeholder="전화" />
          <button class="btn-primary btn-sm sm:col-span-2" type="submit">저장</button>
        </form>
      </details>` : ""}
    </div>`;
}

/** 단가표 행 = 한 줄 인라인 편집 필드(2026-07-27 통합 저장). 액션 버튼은 form=으로 형제 hidden 폼 참조(중첩 폼 금지). */
function rateItemRow(r) {
  const baseHours = r.base_minutes ? r.base_minutes / 60 : "";
  const extraHours = r.extra_minutes ? r.extra_minutes / 60 : 1;
  // 분류가 비어 있을 때의 기본 선택값 — 첫 등록 분류(없으면 시드 상수). ⚠️config 상수를 그대로 쓰면
  // 기본 분류를 개명·삭제할 수 있게 된 뒤(2026-07-29) DB에 없는 이름을 고르게 된다.
  const cat = r.category || (listRateCategories()[0] || {}).name || RECORDING_CATEGORIES[0];
  return `
    <div class="space-y-1 rounded-lg bg-bg p-2 ${r.active ? "" : "opacity-60"}" id="rate-item-${r.id}">
      <div class="flex flex-wrap items-center gap-2">
        <input class="input min-w-0 flex-1 py-1.5 text-sm sm:max-w-[16rem]" name="rate_name_${r.id}" value="${esc(r.name)}" aria-label="단가 항목명" autocomplete="off" required />
        <select class="input w-40 py-1.5 text-sm" name="category_${r.id}" aria-label="분류 이동(다른 분류로 옮기기)">${rateCategoryOptions(cat)}</select>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          ${r.active ? "" : '<span class="text-xs text-muted">(비활성)</span>'}
          <button class="btn-ghost btn-xs whitespace-nowrap" type="submit" form="rate-act-${r.id}">${r.active ? "비활성" : "활성"}</button>
          <button class="btn-ghost btn-xs whitespace-nowrap text-danger" type="submit" form="rate-del-${r.id}">삭제</button>
          ${moveButtons(`rate-mv-u-${r.id}`, `rate-mv-d-${r.id}`)}
        </span>
      </div>
      ${chargeLine({ baseHours: `base_hours_${r.id}`, basePrice: `base_price_${r.id}`, extraHours: `extra_hours_${r.id}`, extraPrice: `extra_price_${r.id}` },
                   { baseHours, basePrice: r.base_price || "", extraHours, extraPrice: r.extra_price || "" })}
    </div>`;
}

/**
 * 요금 줄(둘째 줄) — `기준 [3.5]시간 [300,000]원 · 초과 [1]시간마다 [100,000]원`.
 * 2026-07-29 사용자 결정: 옛 7열 표는 ①열 제목이 맨 위에 한 번뿐이라 아래쪽 분류를 입력할 땐 위를
 * 올려다봐야 했고 ②기준(h)/기준가·초과(h)/초과가가 쌍인데 네 열로 흩어져 매번 관계를 되짚어야 했으며
 * ③헤더가 트리 밖이라 들여쓰기된 행과 17px 어긋나 있었다. 단위·접속사를 칸 사이에 넣어 **행 자체가
 * 설명하게** 하고 열 제목 줄은 없앴다. 입력 폭은 고정이라 행끼리 세로 정렬은 그대로 유지된다.
 * @param names 필드명 묶음(편집 행은 `_<id>` 접미, 추가 행은 접미 없음)
 * @param vals  현재 값(추가 행은 빈 값 + 초과 단위 기본 1)
 * @param formAttr 추가 행처럼 폼 밖 형제 폼을 가리켜야 할 때의 `form="..."`(중첩 폼 금지)
 */
function chargeLine(names, vals = {}, formAttr = "") {
  const num = (name, value, label, width, ph = "") =>
    `<input class="input ${width} py-1 text-right text-sm" ${formAttr} name="${name}" inputmode="${/price/.test(name) ? "numeric" : "decimal"}" value="${esc(String(value == null ? "" : value))}" aria-label="${esc(label)}" placeholder="${esc(ph)}" />`;
  return `
      <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span>기준</span>
        ${num(names.baseHours, vals.baseHours, "기준 시간(시간)", "w-14", "3.5")}
        <span>시간</span>
        ${num(names.basePrice, vals.basePrice, "기준 가격(원)", "w-28", "300000")}
        <span>원</span>
        <span class="px-2 text-muted">·</span>
        <span>초과</span>
        ${num(names.extraHours, vals.extraHours, "초과 단위(시간)", "w-14", "1")}
        <span>시간마다</span>
        ${num(names.extraPrice, vals.extraPrice, "초과 단가(원)", "w-28", "100000")}
        <span>원</span>
      </div>`;
}

/** 단가표 행의 형제 hidden 액션 폼(↑↓·활성 토글·삭제) — bulk 폼 밖에 렌더해 중첩 폼 회피. */
function rateItemActionForms(r) {
  return `
    <form id="rate-mv-u-${r.id}" method="post" action="/settings/rate-items/${r.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="rate-mv-d-${r.id}" method="post" action="/settings/rate-items/${r.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="rate-act-${r.id}" method="post" action="/settings/rate-items/${r.id}/active" hidden><input type="hidden" name="active" value="${r.active ? "0" : "1"}" /></form>
    <form id="rate-del-${r.id}" method="post" action="/settings/rate-items/${r.id}/delete" hidden data-confirm="'${esc(r.name)}' 단가 항목을 삭제할까요? 이미 발행된 청구서는 금액이 따로 저장돼 그대로 남지만, 이 항목으로 잡힌 세션은 단가 항목이 비워져 청구할 수 없게 됩니다. 잠시 안 쓰는 것뿐이면 '비활성으로'를 쓰세요."></form>`;
}

/** 작업 종류 행 = 한 줄 인라인 편집(2026-07-27 통합 저장). */
function taskTypeRow(t) {
  return `
    <div class="flex flex-wrap items-center gap-2 rounded-lg bg-bg p-2" id="task-type-${t.id}">
      <input class="input min-w-0 flex-1 py-1.5 text-sm sm:max-w-[14rem]" name="label_${t.id}" value="${esc(t.label)}" aria-label="작업 종류명" required />
      <select class="input w-36 py-1.5 text-sm" name="billing_type_${t.id}" aria-label="과금">
        ${BILLING_TYPES.map((b) => `<option value="${esc(b)}" ${b === t.billing_type ? "selected" : ""}>${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
      </select>
      ${taskPriceInline({ unitPrice: `unit_price_${t.id}`, isQuick: `is_quick_${t.id}` }, { unitPrice: t.unit_price || "", isQuick: t.is_quick })}
      <span class="ml-auto flex shrink-0 items-center gap-1">
        <button class="btn-ghost btn-xs whitespace-nowrap text-danger" type="submit" form="tt-del-${t.id}">삭제</button>
        ${moveButtons(`tt-mv-u-${t.id}`, `tt-mv-d-${t.id}`)}
      </span>
    </div>`;
}

/**
 * 작업 종류의 단가·빠른추가 묶음 — 요금표와 같은 인라인 단위 방식이되 **한 줄**이다(2026-07-29 사용자 결정).
 * 요금표는 기준/초과 네 칸이라 둘째 줄로 내렸지만 작업 종류는 단가 한 칸뿐이라 한 줄에 들어간다.
 */
function taskPriceInline(names, vals = {}, formAttr = "") {
  return `
      <span class="flex items-center gap-1.5 text-xs text-muted">기본 단가
        <input class="input w-28 py-1 text-right text-sm" ${formAttr} name="${names.unitPrice}" inputmode="numeric" value="${esc(String(vals.unitPrice == null ? "" : vals.unitPrice))}" aria-label="기본 단가(원)" placeholder="200000" />
        원
      </span>
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted">
        <input type="checkbox" ${formAttr} name="${names.isQuick}" value="1" ${vals.isQuick ? "checked" : ""} /> 빠른추가
      </label>`;
}

/** 작업 종류 행의 형제 hidden 액션 폼(↑↓·삭제) — bulk 폼 밖에 렌더해 중첩 폼 회피. */
function taskTypeActionForms(t) {
  return `
    <form id="tt-mv-u-${t.id}" method="post" action="/settings/task-types/${t.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="tt-mv-d-${t.id}" method="post" action="/settings/task-types/${t.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="tt-del-${t.id}" method="post" action="/settings/task-types/${t.id}/delete" hidden data-confirm="'${esc(t.label)}' 작업 종류를 삭제할까요? 이 종류로 만든 기존 작업은 유지되지만 종류명이 코드값으로 표시됩니다."></form>`;
}

/**
 * 구글 연락처 동기화 섹션(환경설정, 2026-07-09 사용자 요청) — 미연동 연락처 일괄 내보내기.
 * People 푸시가 죽어 있던 기간(party 리네임 회귀, 2026-07-09 수정) + 연동 이전 생성분은 구글 주소록에 없음.
 * 개별 수정 시 자동 생성되지만(contacts.routes 폴백), 한 번에 올리는 버튼을 제공. 버튼=치프 전용(연락처 권한 재로그인 필요할 수 있음).
 */
function googleContactsSection(chief) {
  const total = db().prepare("SELECT COUNT(*) c FROM parties WHERE kind='person'").get().c;
  const linked = db().prepare("SELECT COUNT(*) c FROM parties WHERE kind='person' AND google_resource_name IS NOT NULL").get().c;
  const unlinked = total - linked;
  const status = unlinked
    ? `<p class="text-sm">연락처 <b>${total}</b>명 중 <b class="text-warning">${unlinked}명</b>이 아직 구글 주소록에 없습니다. <span class="text-muted">(연동됨 ${linked}명 — 앱에서 연락처를 수정하면 개별 자동 생성)</span></p>`
    : `<p class="text-sm"><span class="badge badge-success">완료</span> 연락처 ${total}명 전원이 구글 주소록에 연동돼 있습니다.</p>`;
  const action = chief && unlinked
    ? `<form method="post" action="/settings/push-contacts" data-confirm="미연동 연락처 ${unlinked}명을 구글 주소록으로 내보낼까요? (구글에 새 연락처가 생성됩니다)">
         <button class="btn-ghost btn-sm" type="submit">구글로 일괄 내보내기 (${unlinked}명)</button>
       </form>`
    : "";
  return `
  <div class="${SETTING_BLOCK}">
    <div>
      <h2 class="text-sm font-semibold">구글 연락처${settingHint(`앱에서 연락처를 만들거나 고치면 구글 주소록에 자동 반영됩니다. 아래 버튼은 아직 구글에 없는 기존 연락처를 한 번에 내보내는 1회성 작업입니다.`, "구글 연락처 설명")}</h2>
    </div>
    ${status}
    ${action}
  </div>`;
}


// ── 시스템 탭(2026-07-09 관리 개선) — 연동·백업·데이터 상태를 한눈에 + 감사 로그 열람 ──

/** 최신 DB 백업 정보(backups/app-*.db 최대 mtime). 없으면 null. */
function lastBackupInfo() {
  try {
    const dir = backupDir();
    const files = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f));
    if (!files.length) return { count: 0, latest: null };
    let latest = null;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (!latest || st.mtimeMs > latest.mtimeMs) latest = { name: f, mtimeMs: st.mtimeMs, size: st.size };
    }
    return { count: files.length, latest };
  } catch (_e) { return { count: 0, latest: null }; }
}

/**
 * 시스템 경고 목록(탭 배지·상태 카드 공용). 조용히 죽는 것들의 가시화가 목적:
 * 백업이 26시간 넘게 없으면(cron 침묵 실패) / Drive 미연동 / 캘린더 자동 연동 꺼짐.
 */
function systemWarnings() {
  const warns = [];
  const b = lastBackupInfo();
  if (!b.latest) warns.push("DB 백업 파일이 없습니다 — 일일 백업(cron)이 아직 안 돌았거나 실패 중입니다.");
  else if (Date.now() - b.latest.mtimeMs > 26 * 3600 * 1000) warns.push(`마지막 DB 백업이 ${Math.floor((Date.now() - b.latest.mtimeMs) / 3600000)}시간 전입니다 — 일일 cron 실패 여부를 확인하세요.`);
  // 디스크 여유(2026-07-09 스케일 점검): 디스크가 차면 SQLite 쓰기 실패 = 전면 장애인데 감시가 없었음. 500MB 미만이면 경고.
  const free = diskFreeBytes();
  if (free != null && free < 500 * 1024 * 1024) warns.push(`디스크 여유 공간이 ${formatBytes(free)}뿐입니다 — 가득 차면 DB 저장이 실패합니다(백업 보존 축소·디스크 증설 검토).`);
  // 자료 저장(서비스 계정)과 OAuth(메일·캘린더·연락처)는 별개 자격증명이라 경고도 나눈다.
  if (!drive.isLinked()) warns.push("자료 저장 Drive 미설정 — 첨부·백업이 서버 로컬 디스크에만 저장됩니다(오프사이트 사본 없음).");
  if (config.googleConfigured && !drive.isOAuthLinked()) warns.push("구글 계정 미연동 — 메일 발송·캘린더·연락처 연동이 동작하지 않습니다.");
  if (!getState("studio_calendar_id")) warns.push("스튜디오 캘린더 미설정 — 세션의 구글 캘린더 자동 연동이 꺼져 있습니다.");
  // 청구 알림 메일(2026-07-14): 수신 주소가 없으면 청구가 발행돼도 아무에게도 안 간다(조용한 장애 클래스).
  if (!mailer.getRecipients().length) warns.push("청구 알림 이메일 수신 주소가 없습니다 — 청구가 발행돼도 알림이 발송되지 않습니다(환경설정 > 알림).");
  return warns;
}

/** DB가 있는 디스크의 여유 바이트(측정 불가 플랫폼은 null — 경고·표시 생략). */
function diskFreeBytes() {
  try {
    const st = fs.statfsSync(path.dirname(config.dbPath));
    return Number(st.bavail) * Number(st.bsize);
  } catch (_e) { return null; }
}

/** 시스템 탭 — 연동 상태 / 백업 / 데이터 / 앱 정보 / 감사 로그(최근 50). chief=수동 백업 버튼 노출. */
function systemTab(chief) {
  const warns = systemWarnings();
  const warnCard = warns.length
    ? `<section class="card border-warning/40"><h2 class="mb-2 text-sm font-semibold text-warning">⚠️ 확인 필요 ${warns.length}건</h2><ul class="list-disc space-y-1 pl-5 text-sm">${warns.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>`
    : `<section class="card"><p class="text-sm"><span class="badge badge-success mr-2">정상</span>연동·백업에 확인이 필요한 항목이 없습니다.</p></section>`;

  // 연동 상태 — 각 설정 섹션(환경설정 탭)에 흩어져 있던 것을 배지로 요약.
  // Drive(서비스 계정)와 OAuth(메일·캘린더·연락처)는 **서로 다른 자격증명**이다.
  // 2026-07-26 Drive 가 서비스 계정으로 갈라진 뒤로 한 배지로 묶으면 오해를 준다.
  const linked = drive.isLinked();
  const oauthOn = drive.isOAuthLinked();
  const oauthAcct = drive.getDriveAccountEmail();
  const calSet = !!getState("studio_calendar_id");
  let peopleOn = false;
  try { peopleOn = !!require("./people").peopleClient(); } catch (_e) { peopleOn = false; }
  const badge = (ok, onLabel, offLabel) => ok ? `<span class="badge badge-success">${esc(onLabel)}</span>` : `<span class="badge badge-warning">${esc(offLabel)}</span>`;
  const integrations = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">연동 상태</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        <span>자료 저장 Drive ${badge(linked, "공유 드라이브", "로컬 디스크")}</span>
        <span>구글 계정(메일·캘린더·연락처) ${badge(oauthOn, "연동됨", "미연동")}</span>
        <span>구글 캘린더 ${badge(calSet, "자동 연동", "꺼짐")}</span>
        <span>구글 연락처 ${badge(peopleOn, "푸시 가능", "미연동")}</span>
        <span>알림 웹훅 ${badge(alerts.isConfigured(), "설정됨", "미설정")}</span>
        <span>청구 알림 메일 ${badge(mailer.isConfigured(), `수신 ${mailer.getRecipients().length}명`, "미설정")}</span>
      </div>
      ${oauthAcct ? `<p class="mt-2 text-xs text-muted">연동 계정 <span class="text-fg">${esc(oauthAcct)}</span></p>` : ""}
      <p class="mt-1 text-xs text-muted">자료 저장은 전용 서비스 계정, 나머지는 위 구글 계정 OAuth 를 씁니다.</p>
    </section>`;

  // 백업 — 마지막 백업 시각·크기·보관 개수 + 수동 백업(치프).
  const b = lastBackupInfo();
  const backupLine = b.latest
    ? `마지막 백업 <b class="text-fg">${esc(new Date(b.latest.mtimeMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</b> · ${esc(b.latest.name)} (${formatBytes(b.latest.size)}) · 보관 ${b.count}개`
    : `<span class="text-warning">백업 파일 없음</span>`;
  const backupCard = `<section class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">DB 백업${settingHint(`매일 03:00 KST에 자동 백업(14일 보존)하고 Drive 연동 시 오프사이트 사본도 올립니다. 복구 절차는 DEPLOY.md §9.`, "DB 백업 설명")}</h2>
        ${chief ? `<form method="post" action="/settings/backup-now"><button class="btn-ghost btn-sm" type="submit">지금 백업</button></form>` : ""}
      </div>
      <p class="mt-1 text-sm text-muted">${backupLine}</p>
    </section>`;

  // 데이터 현황 — DB 크기·주요 테이블 카운트·로컬 잔존 파일.
  let dbSize = 0, walSize = 0;
  try { dbSize = fs.statSync(config.dbPath).size; } catch (_e) { /* 없음 */ }
  try { walSize = fs.statSync(config.dbPath + "-wal").size; } catch (_e) { /* 없음 */ }
  const cnt = (t) => { try { return db().prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (_e) { return 0; } };
  const dataCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">데이터 현황</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted">
        <span>DB <b class="text-fg">${formatBytes(dbSize)}</b>${walSize ? ` <span class="text-xs">(+WAL ${formatBytes(walSize)})</span>` : ""}</span>
        ${diskFreeBytes() != null ? `<span>디스크 여유 <b class="${diskFreeBytes() < 500 * 1024 * 1024 ? "text-warning" : "text-fg"}">${formatBytes(diskFreeBytes())}</b></span>` : ""}
        <span>프로젝트 <b class="text-fg">${cnt("projects")}</b></span>
        <span>청구 <b class="text-fg">${cnt("invoices")}</b></span>
        <span>업체·그룹·연락처 <b class="text-fg">${cnt("parties")}</b></span>
        <span>세션 <b class="text-fg">${cnt("sessions")}</b></span>
        <span>로컬 저장 첨부 <b class="${localFileCount() ? "text-warning" : "text-fg"}">${localFileCount()}</b>개</span>
      </div>
    </section>`;

  // 앱 정보
  let version = "";
  try { version = require("../package.json").version || ""; } catch (_e) { /* 무시 */ }
  const upMin = Math.floor(process.uptime() / 60);
  const appCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">앱 정보</h2>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted">
        <span>버전 <b class="text-fg">${esc(version)}</b></span>
        <span>Node <b class="text-fg">${esc(process.version)}</b></span>
        <span>가동 <b class="text-fg">${upMin >= 60 ? `${Math.floor(upMin / 60)}시간 ${upMin % 60}분` : `${upMin}분`}</b></span>
        <span>환경 <b class="text-fg">${config.isProd ? "프로덕션" : "개발"}</b></span>
      </div>
    </section>`;

  // 감사 로그 — **두 카드로 분리**(2026-07-20): 각 목록이 최근 50건 고정이라 한 목록에 섞으면
  // 접속 기록(사람×하루)이 삭제·청구 같은 파괴적 기록을 며칠 만에 창 밖으로 밀어낸다.
  // 보는 목적도 다르다 — 변경 이력은 '누가 뭘 바꿨나', 접속 기록은 '누가 언제 들어왔나'.
  const auditRow = (a) => `<div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-1.5 text-sm last:border-0">
        <span class="shrink-0 tabular text-xs text-muted">${esc(kstDateTime(a.at))}</span>
        <span class="shrink-0 badge ${a.action === "auth.deny" ? "badge-warning" : "badge-neutral"}">${esc(Object.hasOwn(AUDIT_LABELS, a.action) ? AUDIT_LABELS[a.action] : a.action)}</span>
        <span class="min-w-0 flex-1 truncate">${esc(a.target || "")}${a.ip ? ` <span class="text-xs text-muted">· ${esc(a.ip)}</span>` : ""}</span>
        <span class="shrink-0 text-xs text-muted">${esc(a.user_email || "")}</span>
      </div>`;

  const audits = listAudit(50); // 기본 = 변경 이력(auth.* 제외)
  const auditCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">변경 이력 <span class="text-xs font-normal text-muted">최근 ${audits.length}건 — 삭제·역할·지급·청구 상태</span></h2>
      ${audits.length ? audits.map(auditRow).join("")
    : `<p class="text-sm text-muted">기록이 없습니다 — 삭제·역할 변경·지급·청구 상태 변경 같은 액션이 여기 남습니다.</p>`}
    </section>`;

  // 접속·로그인(2026-07-20 사용자 요청). 거부 시도는 지금까지 아무 데도 안 남아 이 카드의 실질 가치가 크다.
  const access = listAudit(50, "auth");
  const accessCard = `<section class="card">
      <h2 class="mb-2 text-sm font-semibold">접속 · 로그인 <span class="text-xs font-normal text-muted">최근 ${access.length}건 — 접속은 사람당 하루 1건</span></h2>
      ${access.length ? access.map(auditRow).join("")
    : `<p class="text-sm text-muted">기록이 없습니다 — 로그인·접속과 막힌 로그인 시도가 여기 남습니다.</p>`}
    </section>`;

  // ⚠️ **접속·로그인 카드는 치프 전용**(2026-07-20 메인터넌스): /settings는 requireStaff라 스태프도 이 탭에 들어온다.
  // IP를 넣기 전(변경 이력만 있던 시절)엔 무해했지만, 이제 이 카드는 **대표·치프의 접속 IP·기기와
  // 로그인 거부 이메일**을 180일치 보여준다 — 알림 웹훅·계정 관리와 같은 등급(치프)으로 올린다.
  return warnCard + integrations + backupCard + dataCard + appCard + auditCard + (chief ? accessCard : "");
}

/**
 * 환경설정 메뉴(2026-07-28 재설계) — 손 가는 순서로 그룹화. 그룹 헤더는 라벨일 뿐 클릭 대상이 아니다.
 * 각 항목의 부제는 '이름만 보고 뭐가 들었는지 모르는' 문제의 직접 해법이라 비워 두지 말 것.
 */
const SETTINGS_NAV = [
  { group: "자주 쓰는 것", items: [
    { key: "rooms", label: "장소", desc: "룸·외부 장소" },
    { key: "rates", label: "요금표", desc: "녹음·촬영 단가 + 분류" },
    { key: "tasks", label: "작업 종류", desc: "믹싱·보컬튠 등" },
    { key: "booking", label: "예약 기본값", desc: "기본 세션 시간·예약 담당자·기본 장소" },
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

module.exports = {
  peopleTab,
  ratesPane,
  taskTypesPane,
  driveStorageSection,
  studioCalendarSection,
  roomsSection,
  bookingDefaultsSection,
  studioInfoSection,
  alertsSection,
  googleContactsSection,
  systemTab,
  systemWarnings,
  isBootstrapChief,
  SETTINGS_NAV,
  SETTINGS_KEYS,
  settingsMenu,
}; // 내부 전용: rateCategoryOptions·listUsers·ratesTree·rateCategoryRow·rateCategoryActionForms·rateItemAddRow·roomRow·roomActionForms·userRow·rateItemRow·rateItemActionForms·taskTypeRow·taskTypeActionForms(위 export 함수들이 클로저로 사용)
