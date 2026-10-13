"use strict";

// ── 개편 5단계: '완료' 개념 삭제 가드(docs/redesign/05-no-completion.md) ──
// 세션 상태는 '취소냐 아니냐'뿐이고 진행/끝남은 날짜가 정한다. 옛 '완료' 값은 DB에 남아 있어도 읽지 않는다.
// 판정에 `status = '완료'`·`'Completed'` 비교가 다시 들어오면, 아무도 누르지 않는 버튼에 기대는 판정이 되살아난다
// (완료를 안 눌러 '진행 중'에 남던 프로젝트 — 이 단계가 없앤 바로 그 문제).
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  out.push(path.join(ROOT, "public/js/app.js"));
  // db.js = 지난 이행(기록), config.js = 작업 상태 기본값 상수(TASK_STATUSES) — 둘은 판정이 아니다.
  return out.filter((p) => !p.endsWith(path.join("src", "db.js")) && !p.endsWith(path.join("src", "config.js")));
}

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
  .replace(/(^|\s)--\s.*$/gm, "$1");

test("세션 '완료'·'예정' 상태 비교와 작업 'Completed' 비교가 코드에 없다", () => {
  const PATTERNS = [
    /status\s*(=|==|===|<>|!=|!==)\s*['"]완료['"]/,
    /status\s*(=|==|===)\s*['"]예정['"]/, // '예정'이냐로 고르면 옛 '완료' 값이 빠진다 — `<> '취소'`로
    /['"]Completed['"]/,
  ];
  const hits = [];
  for (const f of sources()) {
    const src = strip(fs.readFileSync(f, "utf8"));
    for (const re of PATTERNS) if (re.test(src)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(hits, [], `완료 상태로 판정하는 코드가 있다:\n${hits.join("\n")}`);
});
