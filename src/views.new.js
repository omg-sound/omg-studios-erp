"use strict";

/**
 * `/new` 빠른 생성 화면(개편 1단계, 2026-10-13 — 설계 docs/redesign/01-quick-create.md).
 * 프로젝트 이름 + 일정만으로 세션·작업을 만든다. 나머지는 '▸ 상세 정보'(접힘).
 *
 * - 기존 프로젝트를 고르면 페이지를 다시 불러온다(`?project_id=`, 입력한 본문 칸은 쿼리로 유지) — 서버가 그
 *   프로젝트 값으로 상세 칸을 채워 그리므로 아티스트·담당자 콤보를 JS로 다시 초기화할 필요가 없다.
 * - 같은 이름의 프로젝트가 있으면 저장 전에 **항상 확인받는다**(사용자 결정). JS가 제출 직전 물어 폼 안에 패널을
 *   띄우고, JS가 없으면 서버가 같은 패널을 그려 되돌린다(`dupRows`).
 */

const { esc, pageHeader, tabBar, dateCombo, detailsChevron, personComboOptionsScript, personComboCompanyScript } = require("./views");
const { sessionBookingFields } = require("./views.sessions");
const { projectInfoFields, projectInfoSummary, engineerSelect, taskTypeOptions, defaultTaskType } = require("./views.projects");
const { contactOptions, partyOptions } = require("./data");
const { formatYmdShort, todayYmd } = require("./lib/date");

/** 본문 칸 — 프로젝트를 고르거나 탭을 바꿔 다시 불러올 때 쿼리로 넘겨 유지하는 값. */
const CARRY_FIELDS = ["session_date", "start_time", "end_time", "end_date", "all_day", "session_type", "room_id", "task_type", "song_title", "work_date"];

/** `/new` 주소(본문 칸·return 유지). project_id를 빼면 '변경'(다시 고르기). */
function newHref({ type, projectId = null, values = {}, ret = "" }) {
  const qs = new URLSearchParams();
  qs.set("type", type);
  if (projectId) qs.set("project_id", String(projectId));
  for (const k of CARRY_FIELDS) if (values[k] != null && values[k] !== "") qs.set(k, String(values[k]));
  if (ret) qs.set("return", ret);
  return `/new?${qs.toString()}`;
}

/** 같은 이름 프로젝트 후보 패널(서버 렌더 — JS 없는 제출의 안전망. JS 경로는 app.js가 같은 마크업을 만든다). */
function dupPanel(rows) {
  if (!rows || !rows.length) return `<div data-dup-panel hidden></div>`;
  const items = rows
    .map((r) => {
      const sub = [r.artist, r.session_cnt ? `세션 ${r.session_cnt}건` : "", r.last_date ? `최근 ${formatYmdShort(r.last_date)}` : ""].filter(Boolean).join(" · ");
      return `<li class="flex items-center justify-between gap-2 py-1.5">
          <span class="min-w-0"><span class="block truncate text-sm font-medium">${esc(r.title)}</span>${sub ? `<span class="block truncate text-xs text-muted">${esc(sub)}</span>` : ""}</span>
          <button type="submit" name="project_id" value="${r.id}" class="btn-ghost btn-xs shrink-0">이 프로젝트에 추가</button>
        </li>`;
    })
    .join("");
  return `
    <div class="rounded-lg border border-warning/40 bg-warning/5 p-3" data-dup-panel>
      <p class="text-sm font-medium text-warning">같은 이름의 프로젝트가 있습니다</p>
      <p class="mt-0.5 text-xs text-muted">기존 프로젝트에 추가하거나, 다른 프로젝트라면 새로 만드세요.</p>
      <ul class="mt-2 divide-y divide-border">${items}</ul>
      <button type="submit" name="project_new_confirmed" value="1" class="btn-ghost btn-xs mt-2">새 프로젝트로 만들기</button>
    </div>`;
}

/** 프로젝트 칸 — 기존 프로젝트가 정해졌으면 이름 표기 + [변경], 아니면 이름 콤보(제안 = 기존 프로젝트). */
function projectBlock({ type, project, title, values, ret, dupRows }) {
  if (project) {
    const sub = [project.artist, project.production_company || project.artist_company].filter(Boolean).join(" · ");
    return `
      <div>
        <div class="label mb-1">프로젝트</div>
        <input type="hidden" name="project_id" value="${project.id}" />
        <div class="flex items-center gap-3 rounded-lg border border-border bg-bg/40 px-3 py-2">
          <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(project.title)}</span>${sub ? `<span class="block truncate text-xs text-muted">${esc(sub)}</span>` : ""}</span>
          <a href="${esc(newHref({ type, values, ret }))}" class="btn-ghost btn-xs shrink-0" data-project-change>변경</a>
        </div>
      </div>`;
  }
  return `
    <div>
      <label class="label mb-1" for="new-project-title">프로젝트 <span class="font-normal text-muted">(기존 프로젝트를 고르거나 새 이름 입력)</span></label>
      <div class="relative" data-project-pick data-suggest-url="/new/project-suggest" data-match-url="/new/project-match" data-pick-base="${esc(newHref({ type, values: {}, ret }))}">
        <input id="new-project-title" class="input w-full" name="project_title" value="${esc(title || "")}" placeholder="예: 아이유 정규 6집" autocomplete="off" required role="combobox" aria-expanded="false" aria-autocomplete="list" data-project-input />
        <div class="absolute left-0 right-0 top-full z-30 mt-1 hidden max-h-80 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg" data-suggest-pop role="listbox"></div>
      </div>
      <p class="mt-1 hidden text-xs text-warning" data-project-dup-hint>같은 이름의 프로젝트가 있습니다 — 목록에서 고르거나, 저장할 때 확인합니다.</p>
      <input type="hidden" name="project_new_confirmed" value="" data-project-new-confirmed />
      <div class="mt-2">${dupPanel(dupRows)}</div>
    </div>`;
}

/** 작업 칸 — 본문(종류·곡명·작업일) + 상세(프로젝트 정보·담당 엔지니어·외주 지급단가·금액). */
function taskFields({ values, managers, projectInfoHtml, projectSummary }) {
  const summary = projectSummary.length ? projectSummary.join(" · ") : "아티스트 · 담당 엔지니어 · 금액 등";
  return `
    <div class="grid gap-3 sm:grid-cols-3">
      <div><label class="label mb-0">작업 종류<select class="input mt-1 block" name="task_type">${taskTypeOptions(values.task_type || defaultTaskType())}</select></label></div>
      <div><label class="label mb-0">곡명 <span class="font-normal text-muted">(선택 · 여러 곡은 줄바꿈)</span><textarea class="input mt-1 block" name="song_title" rows="1" placeholder="비우면 프로젝트 이름" autocomplete="off">${esc(values.song_title || "")}</textarea></label></div>
      <div><span class="label mb-0">작업일 <span class="font-normal text-muted">(선택)</span></span><div class="mt-1">${dateCombo("work_date", values.work_date || "", { label: "작업일", inputCls: "input w-full" })}</div></div>
    </div>
    <details class="group rounded-lg border border-border bg-bg/40" data-detail-section>
      <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        ${detailsChevron()}<span class="font-medium">상세 정보</span>
        <span class="min-w-0 truncate text-xs text-muted">${esc(summary)}</span>
      </summary>
      <div class="space-y-3 border-t border-border p-3">
        ${projectInfoHtml}
        <div class="text-xs font-semibold text-muted">이 작업 정보</div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div><label class="label mb-0">담당 엔지니어<select class="input mt-1 block" name="engineer_id">${engineerSelect(managers, {})}</select></label>
            <p class="mt-1 text-xs text-muted">비우면 나로 지정됩니다.</p></div>
          <div data-worker-rate><label class="label mb-0">외주 지급단가 <span class="font-normal text-muted">(원)</span><input class="input mt-1 block" name="worker_rate" inputmode="numeric" placeholder="0" /></label></div>
          <div><label class="label mb-0">금액 <span class="font-normal text-muted">(선택 · 청구 때 입력해도 됨)</span><input class="input mt-1 block" name="unit_price" inputmode="numeric" placeholder="종류 기본 단가" /></label></div>
        </div>
        <div><label class="label mb-0">곡 아티스트 <span class="font-normal text-muted">(프로젝트 아티스트와 다를 때만 — 컴필레이션 등)</span><input class="input mt-1 block" name="song_artist" value="${esc(values.song_artist || "")}" autocomplete="off" /></label></div>
      </div>
    </details>`;
}

/**
 * @param {object} o
 * @param {"session"|"task"} o.type
 * @param {object|null} o.project 기존 프로젝트(정해졌으면)
 * @param {string} o.title 입력한 프로젝트 이름(새 프로젝트)
 * @param {object} o.values 본문·상세 칸 값(쿼리 또는 되돌린 제출)
 * @param {string} o.ret 저장 후 돌아갈 경로(safePath 통과값)
 * @param {Array} [o.dupRows] 같은 이름 후보(서버 안전망 경로)
 * @param {string} [o.error]
 */
function newPage({ type, project, title = "", values = {}, ret = "", dupRows = [], error = "", managers = [], rateItems = [], rooms, defaultBooker = "" }) {
  const optionsRef = "pc-shared-contacts";
  const sharedOpts = personComboOptionsScript(optionsRef, contactOptions()) + personComboCompanyScript("pc-company-shared", partyOptions({ role: "company" }));
  const projectInfoHtml = projectInfoFields(project || values, { existing: !!project, optionsRef });
  const projectSummary = project ? projectInfoSummary(project) : [];
  const tabs = tabBar({
    tabs: [{ key: "session", label: "세션" }, { key: "task", label: "작업" }],
    activeKey: type,
    hrefFn: (k) => newHref({ type: k, projectId: project ? project.id : null, values, ret }),
  });
  const body = type === "task"
    ? taskFields({ values, managers, projectInfoHtml, projectSummary })
    : sessionBookingFields(
        { session_date: values.session_date || todayYmd(), start_time: values.start_time, end_time: values.end_time, end_date: values.end_date, all_day: values.all_day === "1" ? 1 : 0, session_type: values.session_type, room_id: values.room_id ? Number(values.room_id) : undefined, booker_name: values.booker_name, memo: values.memo },
        managers, rateItems, rooms, defaultBooker, "", optionsRef,
        { projectInfoHtml, projectSummary },
      );
  return `
    ${pageHeader({ title: "새로 만들기", desc: "프로젝트 이름과 일정만 있으면 됩니다. 나머지는 ‘상세 정보’에서." })}
    ${tabs}
    ${sharedOpts}
    <form method="post" action="/new" class="card space-y-4" data-new-form ${type === "session" ? "data-session-form" : ""}>
      <input type="hidden" name="kind" value="${type}" />
      <input type="hidden" name="return" value="${esc(ret)}" />
      ${error ? `<p class="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">${esc(error)}</p>` : ""}
      ${projectBlock({ type, project, title, values, ret, dupRows })}
      ${body}
      <div class="flex items-center justify-between gap-3 pt-1">
        <a href="${esc(ret || "/sessions")}" class="btn-ghost btn-sm">취소</a>
        <button class="btn-primary" type="submit">저장</button>
      </div>
    </form>`;
}

module.exports = { newPage, newHref, CARRY_FIELDS };
