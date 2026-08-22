"use strict";
process.env.NODE_ENV = "test";
const { tempDbPath } = require("./helpers");
process.env.DB_PATH = tempDbPath();
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// ── 2026-08-22 감사: 세무 식별정보 변경(payer-info)·작성일 변경(created-at)에 감사 로그가 없었다 ──
// 둘 다 실서버 e2e 없이도 소스 계약으로 회귀를 잠근다(같은 파일의 기존 project.delete·task.delete 로깅과
// 같은 방식). requireBilling/requireChief 게이트는 이미 다른 테스트가 커버하므로 여기선 로깅만 확인.
test("projects.routes.js: 청구처 세무 식별정보 변경(payer-info)이 감사 로그를 남긴다(값은 남기지 않는다)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "projects.routes.js"), "utf8");
  const block = src.slice(src.indexOf('router.post("/payer-info"'), src.indexOf('router.post("/:id", requireEditor'));
  assert.match(block, /logAudit\(req\.user, "party\.tax-info", `#\$\{id\} \$\{p\.name\} biz_no`\)/, "회사 biz_no 변경 기록");
  assert.match(block, /logAudit\(req\.user, "party\.tax-info", `#\$\{id\} \$\{p\.name\} cash_receipt_no`\)/, "개인 cash_receipt_no 변경 기록");
  assert.ok(!/logAudit\([^)]*value/.test(block), "실제 입력값은 감사 로그에 넣지 않는다(민감정보 금지)");
});

test("projects.routes.js: 프로젝트 작성일 변경(created-at)이 감사 로그를 남긴다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "projects.routes.js"), "utf8");
  const block = src.slice(src.indexOf('router.post("/:id/created-at"'), src.indexOf('router.post("/:id/created-at"') + 800);
  assert.match(block, /logAudit\(req\.user, "project\.created-at", `#\$\{id\} → \$\{date\}`\)/, "작성일 변경 기록");
});
