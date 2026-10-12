"use strict";

/**
 * `/new` 빠른 생성(개편 1단계, 2026-10-13 — 설계 docs/redesign/01-quick-create.md).
 * 프로젝트 이름 + 일정으로 세션·작업을 만들고, 새 이름이면 프로젝트를 함께 만든다(한 트랜잭션).
 */

const express = require("express");
const { requireEditor } = require("../auth");
const {
  listProjects,
  getProjectForUser,
  listProjectManagers,
  listRateItems,
  listRooms,
  createSession,
  createTask,
  resolveTrackForQuickTask,
  createProjectRecord,
  updateProjectRecord,
  findProjectsByTitle,
  cleanProjectTitle,
} = require("../data");
const { layout, errorPage } = require("../views");
const { newPage, CARRY_FIELDS } = require("../views.new");
const { safePath } = require("../lib/nav");
const { withTx } = require("../lib/tx");
const { asyncHandler } = require("../lib/async");
const { syncSessionEvent, calFlash, sessionInputError } = require("./sessions.routes");

const router = express.Router();

/** 프로젝트 정보로 해석할 칸만 골라낸다 — 세션 `memo`가 프로젝트 메모로, 빈 제목이 기존 제목으로 새지 않게. */
const PROJECT_INFO_KEYS = [
  "manager_id", "artist", "artist_contact_id", "artist_is_group", "artist_real_name",
  "production_company", "production_party_id", "contact_id", "contact_name", "internal_support",
];
function projectInfoInput(b) {
  const out = {};
  for (const k of PROJECT_INFO_KEYS) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** 같은 이름 칸이 hidden + 버튼으로 두 번 올 수 있다(배열) — 하나라도 그 값이면 참. */
const has = (v, want) => (Array.isArray(v) ? v.includes(want) : v === want);
const lastNum = (v) => Number(Array.isArray(v) ? v.filter(Boolean).pop() : v) || null;

/**
 * 저장 후 돌아갈 곳. 명시 return이 없으면 이 화면을 연 페이지(Referer — 같은 사이트 경로만)를 쓴다 —
 * 사이드바·단축키처럼 링크에 return을 못 싣는 진입점도 '열었던 화면으로 복귀'(사용자 결정)가 되게.
 */
function returnPath(req, explicit) {
  const ok = (p) => (p && !/^\/new(\/|\?|$)/.test(p) ? p : "");
  const fromQuery = safePath(explicit);
  if (fromQuery) return ok(fromQuery);
  const ref = req.get("referer");
  if (!ref) return "";
  try {
    const u = new URL(ref);
    if (u.host !== req.get("host")) return "";
    return ok(safePath(u.pathname + u.search) || "");
  } catch (_e) {
    return "";
  }
}

function renderForm(req, res, { type, project = null, title = "", values = {}, ret = "", dupRows = [], error = "", status = 200 }) {
  const body = newPage({
    type,
    project,
    title,
    values,
    ret,
    dupRows,
    error,
    managers: listProjectManagers(),
    rateItems: listRateItems(),
    rooms: listRooms({ bookableOnly: true }),
    defaultBooker: (req.user && req.user.name) || "",
  });
  res.status(status).send(layout({ title: "새로 만들기", user: req.user, current: "/new", body }));
}

// ── 화면 ──
router.get("/", requireEditor, (req, res) => {
  const type = req.query.type === "task" ? "task" : "session";
  const projectId = Number(req.query.project_id) || null;
  const project = projectId ? getProjectForUser(req.user, projectId) : null;
  const values = {};
  for (const k of CARRY_FIELDS) if (typeof req.query[k] === "string") values[k] = req.query[k];
  if (typeof req.query.date === "string" && !values.session_date) values.session_date = req.query.date; // 캘린더 날짜 칸 '+'
  if (type === "task" && typeof req.query.date === "string" && !values.work_date) values.work_date = req.query.date;
  renderForm(req, res, { type, project, values, ret: returnPath(req, req.query.return) });
});

// ── 프로젝트 이름 제안(콤보) — 기존 프로젝트 ──
router.get("/project-suggest", requireEditor, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  res.json(
    listProjects(req.user, { q }).slice(0, 8).map((p) => ({
      id: p.id,
      label: p.title,
      sub: [p.artist, p.production_company || p.artist_company].filter(Boolean).join(" · "),
    }))
  );
});

// ── 같은 이름(정확 일치) 프로젝트 — 제출 직전 확인용 ──
router.get("/project-match", requireEditor, (req, res) => {
  res.json(findProjectsByTitle(req.query.title).map((r) => ({ id: r.id, title: r.title, artist: r.artist, session_cnt: r.session_cnt, last_date: r.last_date })));
});

// ── 저장 ──
router.post("/", requireEditor, asyncHandler(async (req, res) => {
  const b = req.body;
  const type = b.kind === "task" ? "task" : "session";
  const ret = safePath(b.return) && !/^\/new(\/|\?|$)/.test(b.return) ? b.return : "";
  let projectId = lastNum(b.project_id);
  let existing = null;
  if (projectId) {
    existing = getProjectForUser(req.user, projectId);
    if (!existing) return res.status(404).send(errorPage({ code: 404, title: "프로젝트를 찾을 수 없습니다", message: "삭제되었거나 주소가 잘못되었습니다.", user: req.user }));
  }
  const title = cleanProjectTitle(b.project_title);
  const back = (extra) => renderForm(req, res, { type, project: existing, title, values: b, ret, ...extra });
  if (!existing) {
    if (!title) return back({ error: "프로젝트 이름을 입력하세요.", status: 400 });
    // 같은 이름이 있으면 **항상 확인받는다**(2026-10-13 사용자 결정 — 자동 연결 안 함). 확인 표시가 있을 때만 새로 만든다.
    const dupRows = findProjectsByTitle(title);
    if (dupRows.length && !has(b.project_new_confirmed, "1")) return back({ dupRows });
  }

  let created;
  try {
    // 프로젝트 생성·정보 갱신 + 세션/작업 생성 = 한 트랜잭션. 세션이 겹침 등으로 거부되면 새 프로젝트도 남지 않는다.
    created = withTx(() => {
      if (!projectId) projectId = createProjectRecord({ ...projectInfoInput(b), title });
      else if (has(b.project_info_touched, "1")) updateProjectRecord(projectId, projectInfoInput(b)); // 실제로 고쳤을 때만
      if (type === "task") {
        const track = resolveTrackForQuickTask(req.user, projectId, b.song_title);
        return createTask(req.user, track.id, b);
      }
      return createSession(req.user, projectId, b);
    });
  } catch (e) {
    return sessionInputError(e, res, req.user); // 겹침·날짜 누락 등 세션 오류 화면(그 밖은 다시 던짐)
  }

  const withParam = (path, kv) => path + (path.includes("?") ? "&" : "?") + kv;
  if (type === "task") {
    return res.redirect(withParam(ret || `/projects/${projectId}?tab=tracks`, "flash=added"));
  }
  const cal = await syncSessionEvent(req.user, created); // 구글 캘린더 일정 생성(fail-safe) — 커밋 뒤
  const flash = `flash=${calFlash(cal, "added")}`;
  // 돌아갈 곳이 없거나 캘린더였으면 → 세션 날짜의 달 캘린더 + 방금 만든 세션 팝오버(?open=).
  // (캘린더에서 열었더라도 다른 달 일정을 만들었을 수 있다 — 그 달로 가야 방금 만든 게 보인다.)
  const toCalendar = !ret || (/^\/sessions(\?|$)/.test(ret) && !/view=list/.test(ret));
  if (toCalendar) {
    return res.redirect(`/sessions?view=calendar&month=${String(created.session_date).slice(0, 7)}&open=${created.id}&${flash}`);
  }
  res.redirect(withParam(ret, flash));
}));

module.exports = router;
