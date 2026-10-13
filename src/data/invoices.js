"use strict";

/**
 * 청구(invoices) 도메인 — 금액/상태 파생, 채번, 청구 초안·생성·삭제, 목록·통계, 청구 후보/스냅샷.
 * 돈=정수(원), VAT=공급가 10%(부가세 미포함 시 0). 발행=확정(수정 없음, 변경=삭제 후 재발행).
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 *
 * cross-domain: getProjectForUser(projects)·getClient(clients)·taskTypeLabel(task-types)는
 * 직접 require(무순환). sessionRateAmount(sessions)는 sessions↔invoices 상호의존이라
 * 함수 내부 지연 require("../data")로 해소(로드 시 순환 회피). computeInvoiceDraft는 내부 전용.
 */

const { songOrderSql } = require("../lib/task-order");
const { db } = require("../db");
const { todayYmd, formatYmdShort, kstYmd } = require("../lib/date");
const { parseMoney } = require("../lib/forms");
const { RENTAL_SESSION_TYPES, POSTPROD_SESSION_TYPES } = require("../config");
const RENTAL_IN = RENTAL_SESSION_TYPES.map((t) => `'${t}'`).join(", "); // SQL IN절(정적 config 값 — 인젝션 무관)
const POSTPROD_IN = POSTPROD_SESSION_TYPES.map((t) => `'${t}'`).join(", ");
const { canBill, canInvoice } = require("../auth");
const { getProjectForUser } = require("./projects"); // 무순환
const { getParty, listOrgContacts } = require("./parties"); // 무순환 — 청구처(payer)=parties.id

// 청구처 화면 표시명 = **본명 (활동명)** — 아티스트(개인)가 현금영수증 명의(본명)와 직결돼 활동명만 보면 오해(2026-07-05 사용자 요청).
// c = payer party alias. 회사·그룹은 활동명 없어 name 그대로. (거래명세서 PDF 상호는 별도로 본명(snapshot.name) 유지.)
const PAYER_DISPLAY_SQL =
  "CASE WHEN c.activity_name IS NOT NULL AND TRIM(c.activity_name) <> '' AND c.activity_name <> c.name THEN c.name || ' (' || c.activity_name || ')' ELSE c.name END";
// JS 버전(party 객체용) — 위 SQL과 동일 규칙.
function payerDisplayName(p) {
  if (!p) return "";
  const n = String(p.name || "");
  const a = String(p.activity_name || "").trim();
  return a && a !== n ? `${n} (${a})` : n;
}

// 청구 항목 표시 순서(2026-08-22 사용자 리포트 '녹음·믹싱이 산발적으로 섞여 있다'): 작업(task) 라인의
// item_date는 실제 작업일이 아니라 ERP에 그 작업을 등록한 날짜라, 날짜 하나로만 정렬하면 등록 시점에 따라
// 세션과 작업이 무작위로 뒤섞인다. → 날짜가 실제로 의미 있는 라인(세션·task_id 없는 수동 라인)은 날짜순으로
// 먼저, 작업 라인은 뒤에 원래 등록 순서(id, 트랙 등록 순서와 일치)를 그대로 유지한다.
// 유형 순서 = 세션(날짜순) → 작업(등록 순서) → 자유 줄(날짜순). 개편 3단계(2026-10-13)에서 자유 줄(계약금 등)이 생겨
// 맨 뒤 그룹을 따로 뒀다 — 작성 화면·발행 초안(buildInvoiceDraft)과 같은 순서라야 화면과 PDF가 어긋나지 않는다.
// 라인이 전부 자유 줄인 옛 수동 청구서는 종전처럼 순수 날짜순.
const ITEM_ORDER_SQL =
  "CASE WHEN session_id IS NOT NULL THEN 0 WHEN task_id IS NOT NULL THEN 1 ELSE 2 END, CASE WHEN task_id IS NULL THEN (item_date IS NULL) END, CASE WHEN task_id IS NULL THEN item_date END, id";

/**
 * 발행 시점 청구처(payer) 정보 스냅샷(JSON 문자열). 이후 클라이언트 정보가 바뀌어도 과거 청구서 표시/PDF가
 * 발행 당시 정보로 고정된다(회계·법적 기록 정확성). 표시·PDF는 스냅샷 우선, 없으면(레거시) 실시간 폴백.
 */
function snapshotPayer(payerId) {
  if (!payerId) return null;
  const p = getParty(payerId);
  if (!p) return null;
  const contacts = (listOrgContacts(payerId) || []).slice(0, 1); // 담당자로 지정된 사람(재직 직원 전원이 아님)
  const c0 = contacts[0];
  return JSON.stringify({
    id: p.id,
    name: p.name || "", // 상호/공급받는자 = 본명(현금영수증 명의) — PDF는 이 값 그대로 사용
    activity_name: p.activity_name || null, // 화면 표시 '본명 (활동명)' 병기용(PDF는 미사용)
    kind: p.kind || null,
    owner_name: p.owner_name || null,
    biz_no: p.biz_no || null,
    biz_type: p.biz_type || null,
    biz_item: p.biz_item || null,
    address: p.address || null,
    email: p.email || null,
    cash_receipt_no: p.cash_receipt_no || null,
    contacts: c0 ? [{ name: c0.name, phone: c0.phone || null, email: c0.email || null }] : [],
  });
}

/**
 * 발행 스냅샷 이후 청구처 정보가 바뀌었는지 — 청구 상세 '새로고침' 안내 노출 판정(2026-07-08 사용자 요청).
 * 의미 필드만 골라 비교(JSON 문자열 비교 금지 — 옛 스냅샷은 이후 추가된 키가 없어 내용이 같아도 오탐).
 * 스냅샷 없는 레거시(실시간 표시)·청구처 삭제·미지정은 false(새로고침 개념 없음).
 */
/**
 * 청구 내역 CSV — **세무사·홈택스 제출용**(2026-08-03 사용자 요청). 매출 CSV(공급가·발생 기준 분석)와
 * 달리 이쪽은 **계산서 발행·입금 현황**이 축이다: 누구에게(사업자번호까지) 얼마를 청구했고, 계산서가
 * 나갔는지, 얼마가 들어왔고 얼마가 남았는지.
 *
 * 🔒 거래처 정보는 **발행 시점 스냅샷**을 먼저 본다 — 그 뒤 거래처 상호·사업자번호가 바뀌어도 발행 당시
 * 값이 신고 근거다(스냅샷 없는 레거시 건만 현재 값으로 폴백).
 * ⚠️ 사업자번호와 현금영수증번호는 **칸을 나눈다**. 한 칸에 섞으면 세무사가 계산서 건과 현금영수증 건을
 * 구분하려고 다시 되짚어야 한다(발행 경로가 아예 다르다).
 */
const INVOICE_CSV_HEADERS = [
  "발행일", "청구번호", "거래처", "구분", "사업자번호", "현금영수증번호", "대표자",
  "프로젝트", "아티스트", "공급가", "VAT", "할인", "합계", "계산서상태", "입금액", "미수금", "발행이메일",
];

function invoiceCsv(rows) {
  const { toCsv } = require("../lib/csv");
  // 스냅샷이 없는 건(2026-07 이전 발행분·레거시)은 **현재 거래처 값**으로 폴백한다 — 안 그러면 사업자번호 칸이
  // 통째로 비어 세무사가 상호로 되짚어야 하고, 상호가 비슷한 곳이 있으면 틀린다. 행마다 조회하지 않고 한 번에.
  const ids = [...new Set((rows || []).map((i) => i.payer_id).filter(Boolean))];
  const partyById = new Map();
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    for (const p of db().prepare(`SELECT id, name, kind, biz_no, owner_name, cash_receipt_no, email FROM parties WHERE id IN (${ph})`).all(...ids)) {
      partyById.set(p.id, p);
    }
  }
  const body = (rows || []).map((i) => {
    let snap = {};
    try { snap = JSON.parse(i.payer_snapshot || "{}") || {}; } catch (_e) { snap = {}; }
    const cur = partyById.get(i.payer_id) || {};
    const pick = (k, fallback = "") => String(snap[k] || cur[k] || fallback || "").trim();
    const bizNo = pick("biz_no");
    const cash = pick("cash_receipt_no");
    // 구분 = 발행 경로. 사업자번호가 있으면 개인이라도 계산서를 끊으므로 '사업자'로 본다(payerDocMissing과 같은 규칙).
    const kind = bizNo ? "사업자" : cash ? "개인" : i.payer_kind === "person" ? "개인" : "사업자";
    return [
      i.issued_date || "",
      i.invoice_number || "",
      pick("name", i.client_name),
      kind,
      bizNo,
      cash,
      pick("owner_name"),
      i.project_title || "",
      i.project_artist || "",
      (i.amount || 0) - (i.tax_amount || 0), // 공급가(VAT 제외)
      i.tax_amount || 0,
      i.discount_amount || 0,
      i.amount || 0, // 합계(VAT 포함 발행액)
      i.tax_status || "",
      i.paid_amount || 0,
      balanceOf(i),
      pick("email"),
    ];
  });
  return toCsv(INVOICE_CSV_HEADERS, body);
}

function payerSnapshotChanged(inv) {
  if (!inv || !inv.payer_id || !inv.payer_snapshot) return false;
  const cur = snapshotPayer(inv.payer_id);
  if (!cur) return false; // 청구처 party 삭제됨
  let a, b;
  try { a = JSON.parse(inv.payer_snapshot); b = JSON.parse(cur); } catch (_e) { return false; }
  const norm = (v) => (v == null ? "" : String(v).trim());
  const fields = ["name", "activity_name", "owner_name", "biz_no", "biz_type", "biz_item", "address", "email", "cash_receipt_no"]
    .filter((f) => !(f === "email" && a.email_overridden)); // 건별 임의 이메일(2026-07-27) — party와 다른 게 정상이라 비교 제외
  if (fields.some((f) => norm(a[f]) !== norm(b[f]))) return true;
  const ca = (a.contacts && a.contacts[0]) || {};
  const cb = (b.contacts && b.contacts[0]) || {};
  return ["name", "phone", "email"].some((f) => norm(ca[f]) !== norm(cb[f]));
}

/**
 * [새로고침](refresh-payer)용 재스냅샷 — party 현재 정보로 갱신하되, 건별 임의 발행 이메일(email_overridden)은
 * 보존한다(2026-07-27 스펙). 새로고침은 party 정보 보정이지 override 취소가 아니다.
 */
function refreshedPayerSnapshot(inv) {
  if (!inv || !inv.payer_id) return null;
  let snap = snapshotPayer(inv.payer_id);
  if (!snap) return null; // 청구처 party 삭제됨 — 기존 라우트와 동일하게 null 저장
  try {
    const prev = JSON.parse(inv.payer_snapshot || "null");
    if (prev && prev.email_overridden) {
      const cur = JSON.parse(snap);
      cur.email = prev.email == null ? null : prev.email;
      cur.email_overridden = true;
      snap = JSON.stringify(cur);
    }
  } catch (_e) {}
  return snap;
}

/**
 * 청구처(payer) 후보별 발행 정보 — 회사=세금계산서 정보(사업자등록번호 biz_no) 보유, 개인=현금영수증 정보(cash_receipt_no) 보유 party id 집합.
 * 청구 생성 폼이 청구처 유형(회사=계산서 / 개인=현금영수증)·정보 누락 경고·차단에 쓴다.
 * (사업자등록증 파일은 첨부 서류일 뿐 세금계산서 발행 필수 아님 → biz_no 기준.)
 * @returns {{ taxInfoIds: number[], cashReceiptIds: number[] }}
 */
function payerDocMeta() {
  const taxInfoIds = db().prepare("SELECT id FROM parties WHERE biz_no IS NOT NULL AND TRIM(biz_no) <> ''").all().map((r) => r.id);
  const cashReceiptIds = db().prepare("SELECT id FROM parties WHERE cash_receipt_no IS NOT NULL AND TRIM(cash_receipt_no) <> ''").all().map((r) => r.id);
  return { taxInfoIds, cashReceiptIds };
}

/**
 * 청구처 발행 정보 누락 검사 — 회사에 세금계산서 정보(biz_no)가 없거나, 개인에 현금영수증 정보(cash_receipt_no)가 없으면
 * 해당 에러 코드를 반환(청구 생성 차단용). 정보가 충분하면 null.
 * @returns {"PAYER_TAX_INFO_REQUIRED"|"PAYER_CASH_RECEIPT_REQUIRED"|null}
 */
function payerDocMissing(payer) {
  if (!payer) return null;
  const has = (v) => !!(v && String(v).trim());
  if (payer.kind === "company") return has(payer.biz_no) ? null : "PAYER_TAX_INFO_REQUIRED";
  // 개인·그룹 등: 사업자번호(biz_no)가 있거나 현금영수증(cash_receipt_no)이 있으면 통과
  return (has(payer.cash_receipt_no) || has(payer.biz_no)) ? null : "PAYER_CASH_RECEIPT_REQUIRED";
}
const { taskTypeLabel } = require("./task-types"); // 무순환

const parseWon = parseMoney; // 내부 호출명 parseWon 유지

// ── 인보이스 금액/상태 파생(플레이북2 §4 payStatus/balanceOf) ──

/**
 * 청구 목록 3탭 분류(계산서·입금 축) — todo(발행 필요)/done(발행 완료·입금 전)/paid(입금완료).
 * 상호 배타(라우트 필터와 탭 카운트가 같은 함수를 쓰게 순수함수로 추출, 2026-07-09 감사 후속 테스트 보강).
 */
function invoiceTaxTab(inv) {
  if (!inv) return "todo";
  if (inv.tax_status === "입금완료") return "paid";
  if (inv.tax_status === "계산서 발행") return "done";
  return "todo";
}

/** 잔금(미수금) = 총액 - 입금액(음수 없음). */
function balanceOf(inv) {
  return Math.max((inv.amount || 0) - (inv.paid_amount || 0), 0);
}

/** 납입 상태: 미납 | 부분납 | 완납. */
function payStatusOf(inv) {
  const paid = inv.paid_amount || 0;
  if (paid <= 0) return "미납";
  if (paid >= (inv.amount || 0)) return "완납";
  return "부분납";
}

// ── 입금 이력(payments) ── invoices.paid_amount는 SUM(payments.amount) 파생 캐시. 모든 add/delete가 recomputePaid로 동기화한다.

/** 청구 1건의 입금 이력(입금일 오름차순). */
function listPayments(invoiceId) {
  return db()
    .prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY COALESCE(paid_on, '') ASC, id ASC")
    .all(Number(invoiceId));
}

/** invoices.paid_amount = SUM(payments). 반환=새 누적 입금액. */
function recomputePaid(invoiceId) {
  const sum = db().prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ?").get(Number(invoiceId)).s;
  db().prepare("UPDATE invoices SET paid_amount = ? WHERE id = ?").run(sum, Number(invoiceId));
  return sum;
}

/** 입금 1건 추가(원자적으로 이력 INSERT + paid_amount 재계산). amount<=0이면 무시. 반환=새 누적 입금액. */
function addPayment(invoiceId, { amount, paid_on, memo } = {}) {
  const amt = Math.max(0, parseMoney(amount));
  if (amt <= 0) return db().prepare("SELECT paid_amount FROM invoices WHERE id = ?").get(Number(invoiceId)).paid_amount || 0;
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("INSERT INTO payments (invoice_id, amount, paid_on, memo) VALUES (?, ?, ?, ?)")
      .run(Number(invoiceId), amt, paid_on || todayYmd(), memo || null);
    const sum = recomputePaid(invoiceId);
    d.exec("COMMIT");
    return sum;
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
}

/** 입금 이력 1건 삭제 + paid_amount 재계산. 반환={invoiceId, paid} 또는 null(없음). */
function deletePayment(paymentId) {
  const p = db().prepare("SELECT * FROM payments WHERE id = ?").get(Number(paymentId));
  if (!p) return null;
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("DELETE FROM payments WHERE id = ?").run(p.id);
    const paid = recomputePaid(p.invoice_id);
    d.exec("COMMIT");
    return { invoiceId: p.invoice_id, paid };
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch (_) { /* ignore */ }
    throw e;
  }
}

// ── 청구 후보(프로젝트 단위) + 채번 + 스냅샷 조회 ──

function listUnbilledTasksForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT t.*, COALESCE(t.song_title, ?) AS track_title
       FROM track_tasks t
       WHERE t.project_id = ?
         AND t.is_invoiced = 0
       ORDER BY ${songOrderSql("t")}`
    )
    .all(project.title, project.id); // 곡명이 없는 작업은 프로젝트 이름으로 표시(개편 2단계)
  return { project, rows };
}

/**
 * 대관 세션(녹음·촬영·공연) 중 아직 청구/전환 안 된 것 — 세션 직접 청구 후보.
 *
 * ⚠️ **단가 항목이 없는 세션도 함께 반환한다**(2026-07-23 기능성 평가). 예전엔 `rate_item_id IS NOT NULL`로
 * 걸러냈는데, 그러면 완료된 대관 세션이 **청구 후보와 미청구 집계 양쪽에서 동시에 사라져** 프로젝트가
 * 조용히 '완료' 탭으로 넘어갔다(매출이 소리 없이 빠짐). 개편 1단계(2026-10-13)부터는 단가 없는 세션도
 * **수동 금액**(`billing.manual`)으로 바로 청구할 수 있다 — 금액은 청구 폼에서 직접 입력.
 * 미청구 집계(`listProjects.unbilled_cnt`)도 **이 함수와 같은 조건**을 써야 한다.
 */
function listBillableSessionsForProject(user, projectId) {
  const { sessionRateAmount } = require("../data"); // sessions와 상호의존 → 지연 require
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.project_id = ?
         AND s.status <> '취소'
         AND s.session_type IN (${RENTAL_IN})
         AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)
       ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC`
    )
    .all(project.id)
    .map((row) => ({ ...row, billing: sessionRateAmount(row) })); // 단가 미선택=수동 금액(manual), 소요 0 이하만 null
  return { project, rows };
}

/** 세션이 인보이스에 직접 청구되었는지(invoice_items 역참조). 세션 수정·삭제 잠금 판별. */
function isSessionInvoiced(sessionId) {
  return !!db().prepare("SELECT 1 FROM invoice_items WHERE session_id = ? LIMIT 1").get(sessionId);
}

function listInvoiceItemsForInvoice(user, invoiceId) {
  const inv = getInvoiceForUser(user, invoiceId);
  if (!inv) return null;
  const rows = db()
    .prepare(`SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY ${ITEM_ORDER_SQL}`)
    .all(inv.id);
  return { invoice: inv, rows };
}

function nextInvoiceNumber(issueDate) {
  const ym = String(issueDate || todayYmd()).slice(0, 7).replace("-", "");
  // 채번 = OMG-YYYYMM-###. 기존 INV-·신규 OMG- 접두 모두 고려해 최대 일련번호+1(접두 전환에도 번호 연속·중복 없음).
  const rows = db().prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? OR invoice_number LIKE ?").all(`INV-${ym}-%`, `OMG-${ym}-%`);
  let max = 0;
  for (const r of rows) { const m = String(r.invoice_number || "").match(/-(\d+)$/); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `OMG-${ym}-${String(max + 1).padStart(3, "0")}`;
}

/** 발행/입금완료로 전이 시 채번 보장(수동 발행분도 INV-YYYYMM-### 부여). 거래명세서에 번호 필수. */
function ensureInvoiceNumber(inv) {
  if (!inv || inv.invoice_number) return inv;
  // 청구서 발행 또는 계산서 발행/입금완료 — 어느 축이든 '발행됨'이면 채번(거래명세서/계산서 번호 필수).
  if (inv.status !== "발행" && inv.tax_status !== "계산서 발행" && inv.tax_status !== "입금완료") return inv;
  const number = nextInvoiceNumber(inv.issued_date || todayYmd());
  db().prepare("UPDATE invoices SET invoice_number=? WHERE id=?").run(number, inv.id);
  return { ...inv, invoice_number: number };
}

/**
 * 공급가·할인 기반 청구 금액 계산 헬퍼.
 * discount: 0 ~ supply 로 clamp(음수→0, 공급가 초과→공급가).
 * 반환: { discount(clamp됨), taxable, tax, total }
 * 돈=정수(원). VAT = round(taxable * 0.1).
 */
function invoiceAmountsFromSupply(supply, discount, vatIncluded = true) {
  const raw = Math.round(Number(discount) || 0);
  const d = Math.min(Math.max(0, raw), supply);
  const taxable = supply - d;
  const tax = vatIncluded ? Math.round(taxable * 0.1) : 0; // 부가세 미포함(현금 거래) 시 VAT 0
  const total = taxable + tax;
  return { discount: d, taxable, tax, total };
}

/**
 * 청구 초안 계산(읽기 전용, 쓰기 없음) — 청구서 생성과 미리보기 PDF가 공유.
 * 선택 작업/세션 + 폼 입력 금액 → 라인아이템·공급가·할인·VAT·총액·청구처 계산. 반환: null(권한 없음) 또는 draft 객체.
 */
/** 세션 라인 기본 설명 — "10월 2일 · 아티스트 · 녹음"(다일 종일은 "9월 1일~9월 4일"). 청구서에서 고칠 수 있다. */
function sessionLineLabel(s, artist, { withTime = false } = {}) {
  // 같은 날짜에 세션이 둘 이상이면 시작 시간을 붙여 구분한다(2026-08-22 사용자 리포트 — 설명이 같아 중복처럼 보였다).
  const dateLabel = s.all_day && s.end_date && s.end_date !== s.session_date
    ? `${formatYmdShort(s.session_date)}~${formatYmdShort(s.end_date)}`
    : formatYmdShort(s.session_date) + (withTime && s.start_time ? ` ${s.start_time}` : "");
  return [dateLabel, artist, s.session_type].filter(Boolean).join(" · ");
}
/** 작업 라인 기본 설명 — "곡명(없으면 프로젝트 이름) - 종류". */
function taskLineLabel(t, projectTitle) {
  return `${t.song_title || projectTitle || ""} - ${taskTypeLabel(t.task_type)}`;
}

// 청구 가능한 세션 조건(개편 3단계 — 대기함·청구 생성·미청구 집계가 같은 조건이어야 한다. listProjects.unbilled_cnt 참조).
// 대관 종류(믹싱·마스터링 '세션'은 제외 — 같은 일을 작업으로 청구, 2026-10-13 사용자 결정), 취소 제외, 시간 있음(또는 종일),
// 아직 청구 라인·작업 전환 없음.
const BILLABLE_SESSION_SQL = `s.status <> '취소' AND s.session_type IN (${RENTAL_IN})
  AND (s.all_day = 1 OR (s.start_time IS NOT NULL AND s.end_time IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM track_tasks tt WHERE tt.session_id = s.id)`;

/**
 * 청구 대기함(개편 3단계) — **모든 프로젝트**의 미청구 세션·작업을 프로젝트별로 묶어 반환.
 * 내부 지원 프로젝트는 뺀다. 금액은 사람이 적어 둔 값만(세션 확정액·작업 금액) — 산정치 없음.
 * @param {object} f q=프로젝트·아티스트·제작/운영·소속 검색, from/to=날짜(YYYY-MM-DD), doneOnly=완료만,
 *   showWaived='청구 안 함'도 보기, projectId=한 프로젝트만
 * @returns {{groups: Array<{project:object, items:Array}>, count:number, postprod: Array}}
 */
function listBillableItems(_user, f = {}) {
  const d = db();
  const where = ["p.internal_support = 0"];
  const params = {};
  if (f.projectId) { where.push("p.id = @pid"); params.pid = Number(f.projectId); }
  const q = String(f.q || "").trim();
  if (q) {
    where.push(`(p.title LIKE @q OR p.artist LIKE @q OR p.production_company LIKE @q OR p.artist_company LIKE @q)`);
    params.q = `%${q}%`;
  }
  const projWhere = where.join(" AND ");
  const dateCond = (col) => {
    const c = [];
    if (f.from) { c.push(`${col} >= @from`); params.from = f.from; }
    if (f.to) { c.push(`${col} <= @to`); params.to = f.to; }
    return c.length ? " AND " + c.join(" AND ") : "";
  };
  const waived = f.showWaived ? "" : " AND s.waived = 0";
  const sessions = d.prepare(
    `SELECT s.*, p.id AS pid FROM sessions s JOIN projects p ON p.id = s.project_id
     WHERE ${projWhere} AND ${BILLABLE_SESSION_SQL}${waived}${f.doneOnly ? " AND s.status = '완료'" : ""}${dateCond("s.session_date")}
     ORDER BY s.session_date ASC, s.start_time ASC, s.id ASC`
  ).all(params);
  const tWaived = f.showWaived ? "" : " AND t.waived = 0";
  const tasks = d.prepare(
    `SELECT t.*, p.id AS pid FROM track_tasks t JOIN projects p ON p.id = t.project_id
     WHERE ${projWhere} AND t.is_invoiced = 0${tWaived}${f.doneOnly ? " AND t.status = 'Completed'" : ""}${dateCond("COALESCE(t.work_date, substr(t.created_at, 1, 10))")}
     ORDER BY ${songOrderSql("t")}`
  ).all(params);
  const ids = [...new Set([...sessions, ...tasks].map((r) => r.pid))];
  const projects = ids.length
    ? d.prepare(`SELECT p.*, (SELECT MAX(s.session_date) FROM sessions s WHERE s.project_id = p.id) AS last_date FROM projects p WHERE p.id IN (${ids.map(() => "?").join(",")})`).all(...ids)
    : [];
  const byId = new Map(projects.map((p) => [p.id, { project: p, items: [] }]));
  for (const s of sessions) {
    const g = byId.get(s.pid);
    g.items.push({
      kind: "session", id: s.id, key: `s${s.id}`, date: s.session_date, status: s.status, done: s.status === "완료", waived: !!s.waived,
      label: sessionLineLabel(s, g.project.artist), time: [s.start_time, s.end_time].filter(Boolean).join("–"),
      amount: s.billing_amount != null ? Math.round(s.billing_amount) : null,
    });
  }
  for (const t of tasks) {
    const g = byId.get(t.pid);
    g.items.push({
      kind: "task", id: t.id, key: `t${t.id}`, date: t.work_date || null, status: t.status, done: t.status === "Completed", waived: !!t.waived,
      label: taskLineLabel(t, g.project.title), time: "", engineer: t.engineer_name || "",
      amount: t.total_price > 0 ? t.total_price : null,
    });
  }
  // 프로젝트 순서 = 가장 오래된 미청구 항목 날짜(먼저 끝난 일부터 청구).
  const groups = [...byId.values()];
  const firstDate = (g) => g.items.map((i) => i.date).filter(Boolean).sort()[0] || "9999";
  groups.sort((a, b) => firstDate(a).localeCompare(firstDate(b)) || a.project.id - b.project.id);
  // 작업이 없는 후반작업 세션(믹싱·마스터링) — 대기함엔 안 올리고(작업으로 청구) 알림만. '완료'뿐 아니라 **날짜가 지난
  // 예정**도 포함한다(2026-10-13 사용자 요청 — 완료를 안 누른 믹싱 세션은 '청구 필요' 신호에도 안 잡혀 청구 누락이 숨었다:
  // 운영 실측 흑백가수·올블루레코즈). 프로젝트 탭 분류(hasPostprodSessionNeedingBilling)는 그대로 — 여기는 알림만 넓힌다.
  const postprod = d.prepare(
    `SELECT DISTINCT p.id, p.title FROM projects p JOIN sessions s ON s.project_id = p.id
      WHERE ${projWhere} AND s.session_type IN (${POSTPROD_IN}) AND s.waived = 0
        AND (s.status = '완료' OR (s.status = '예정' AND s.session_date < @today))
        AND NOT EXISTS (SELECT 1 FROM track_tasks t WHERE t.project_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii JOIN sessions s4 ON s4.id = ii.session_id WHERE s4.project_id = p.id)
      ORDER BY p.title`
  ).all({ ...params, today: todayYmd() });
  return { groups, count: sessions.length + tasks.length, postprod };
}

/**
 * 대기함에서 고른 키("s12"·"t34")를 청구서 작성 화면의 라인으로(청구 가능한 것만 — 이미 청구됐거나 취소된 건 빠지고 skipped로).
 * @returns {{lines:Array, projects:Array, skipped:number}}
 */
function composeLinesForKeys(keys) {
  const d = db();
  const list = [...new Set((Array.isArray(keys) ? keys : keys ? [keys] : []).map(String))];
  const lines = [];
  const pids = new Set();
  let skipped = 0;
  for (const k of list) {
    const m = /^([st])(\d+)$/.exec(k);
    if (!m) { skipped++; continue; }
    const id = Number(m[2]);
    if (m[1] === "s") {
      const s = d.prepare(`SELECT s.*, p.artist AS p_artist FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND ${BILLABLE_SESSION_SQL}`).get(id);
      if (!s) { skipped++; continue; }
      pids.add(s.project_id);
      lines.push({ kind: "session", id, key: k, project_id: s.project_id, date: s.session_date, done: s.status === "완료", label: sessionLineLabel(s, s.p_artist), amount: s.billing_amount != null ? Math.round(s.billing_amount) : null, _s: s });
    } else {
      const t = d.prepare("SELECT t.*, p.title AS p_title FROM track_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.is_invoiced = 0").get(id);
      if (!t) { skipped++; continue; }
      pids.add(t.project_id);
      lines.push({ kind: "task", id, key: k, project_id: t.project_id, date: t.work_date || null, done: t.status === "Completed", label: taskLineLabel(t, t.p_title), amount: t.total_price > 0 ? t.total_price : null });
    }
  }
  // 같은 날짜 세션이 둘 이상이면 그 세션들 설명에 시작 시간을 붙인다(발행될 청구서에서 구분되게).
  const perDate = {};
  for (const l of lines) if (l.kind === "session" && l._s.session_date) perDate[l._s.session_date] = (perDate[l._s.session_date] || 0) + 1;
  for (const l of lines) {
    if (l.kind === "session" && perDate[l._s.session_date] > 1) l.label = sessionLineLabel(l._s, l._s.p_artist, { withTime: true });
    delete l._s;
  }
  const ids = [...pids];
  const projects = ids.length ? d.prepare(`SELECT * FROM projects WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
  // 세션(날짜순) → 작업(고른 순서) — 발행될 청구서와 같은 순서로 보여 준다.
  const rank = (l) => (l.kind === "session" ? 0 : 1);
  lines.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? String(a.date).localeCompare(String(b.date)) : 0));
  return { lines, projects, skipped };
}

/**
 * 청구서 초안 — 라인 배열로부터(개편 3단계: 대기함에서 고른 세션·작업 + 자유 줄, 내용·금액 직접 기입).
 * @param {object} o payerId(필수)·title·issueDate·discount·discountPct·vatIncluded·lines
 *   lines = [{ kind:'session'|'task'|'free', id?, description?, amount?, date? }] — amount는 '300,000' 같은 입력 문자열도 받는다.
 *   빈 줄(자유 줄인데 내용·금액 둘 다 없음)은 무시. 같은 세션·작업이 두 번 오면 거부.
 */
function buildInvoiceDraft(user, o = {}) {
  if (!canBill(user)) return null;
  const d = db();
  const raw = Array.isArray(o.lines) ? o.lines : [];
  const seen = new Set();
  const items = [];
  const projectIds = new Set();
  for (const ln of raw) {
    const kind = ln.kind === "session" || ln.kind === "task" ? ln.kind : "free";
    const descIn = String(ln.description == null ? "" : ln.description).replace(/\s+/g, " ").trim();
    const amtRaw = ln.amount == null ? "" : String(ln.amount).trim();
    if (kind === "free" && !descIn && !amtRaw) continue; // 비워 둔 자유 줄
    const amount = amtRaw === "" ? 0 : parseMoney(amtRaw);
    if (kind === "session") {
      const id = Number(ln.id);
      if (!id || seen.has(`s${id}`)) throw new Error("TASK_NOT_BILLABLE");
      seen.add(`s${id}`);
      const s = d.prepare(`SELECT s.*, p.artist AS p_artist FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND ${BILLABLE_SESSION_SQL}`).get(id);
      if (!s) throw new Error("TASK_NOT_BILLABLE");
      projectIds.add(s.project_id);
      items.push({ task_id: null, session_id: s.id, track_title: null, task_type: null, description: descIn || sessionLineLabel(s, s.p_artist), quantity: 1, unit_price: amount, amount, item_date: s.session_date || null, _session: s, _autoDesc: !descIn });
    } else if (kind === "task") {
      const id = Number(ln.id);
      if (!id || seen.has(`t${id}`)) throw new Error("TASK_NOT_BILLABLE");
      seen.add(`t${id}`);
      const t = d.prepare("SELECT t.*, p.title AS p_title FROM track_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.is_invoiced = 0").get(id);
      if (!t) throw new Error("TASK_NOT_BILLABLE");
      projectIds.add(t.project_id);
      items.push({ task_id: t.id, session_id: null, track_title: t.song_title || t.p_title, task_type: t.task_type, description: descIn || taskLineLabel(t, t.p_title), quantity: 1, unit_price: amount, amount, item_date: t.work_date || kstYmd(t.created_at) || null, _task: t });
    } else {
      if (!descIn) throw new Error("LINE_DESC_REQUIRED");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ln.date || "")) ? ln.date : null;
      items.push({ task_id: null, session_id: null, track_title: null, task_type: null, description: descIn, quantity: 1, unit_price: amount, amount, item_date: date });
    }
  }
  if (!items.length) throw new Error("TASK_IDS_REQUIRED");
  // 설명을 비워 둔(자동) 세션 줄 — 같은 날짜가 둘 이상이면 시작 시간을 붙여 구분.
  const perDate = {};
  for (const it of items) if (it._session && it._autoDesc) perDate[it.item_date] = (perDate[it.item_date] || 0) + 1;
  for (const it of items) {
    if (it._session && it._autoDesc && perDate[it.item_date] > 1) it.description = sessionLineLabel(it._session, it._session.p_artist, { withTime: true });
  }
  const subtotal = items.reduce((sum, it) => sum + it.amount, 0);
  // 할인: 정액 우선, 없으면 정률(%)을 공급가 기준으로 서버가 산정(JS 미동작 폴백 — 감사 L2).
  let effDiscount = o.discount || 0;
  if (!effDiscount) {
    const pct = Number(o.discountPct);
    if (pct > 0) effDiscount = Math.round((subtotal * Math.min(100, pct)) / 100);
  }
  const vatIncluded = o.vatIncluded !== false;
  const { discount: discountAmt, tax, total } = invoiceAmountsFromSupply(subtotal, effDiscount, vatIncluded);
  const issued = o.issueDate || todayYmd();
  // 청구처 = **항상 명시**(2026-07-15 사용자 결정 — 자동 파생 폐기). 안 고르면 발행 차단.
  const payerId = o.payerId ? Number(o.payerId) : null;
  if (!payerId) throw new Error("PAYER_REQUIRED");
  const payer = getParty(payerId);
  if (!payer) throw new Error("CLIENT_NOT_FOUND");
  const pids = [...projectIds];
  const onlyProject = pids.length === 1 ? d.prepare("SELECT * FROM projects WHERE id = ?").get(pids[0]) : null;
  // 제목 기본값: 한 프로젝트면 '{프로젝트} 청구', 여러(또는 자유 줄만)면 '{청구처} {M}월 청구'.
  const title = String(o.title || "").trim()
    || (onlyProject ? `${onlyProject.title} 청구` : `${payerDisplayName(payer)} ${Number(issued.slice(5, 7))}월 청구`);
  // 정렬 = 세션(날짜순) → 작업(곡 묶음 순서 = 입력 순서) → 자유 줄(입력 순서). 읽기 경로 ITEM_ORDER_SQL과 같은 유형 우선순위.
  const rank = (it) => (it.session_id ? 0 : it.task_id ? 1 : 2);
  const ordered = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      if (rank(a.it) !== rank(b.it)) return rank(a.it) - rank(b.it);
      if (rank(a.it) !== 1) { // 세션·자유 줄 = 날짜순(날짜 없는 줄은 뒤) — ITEM_ORDER_SQL과 같은 규칙
        const ad = a.it.item_date || "", bd = b.it.item_date || "";
        if (ad !== bd) return !ad ? 1 : !bd ? -1 : ad.localeCompare(bd);
      }
      return a.i - b.i;
    })
    .map((x) => x.it);
  return { items: ordered, subtotal, discountAmt, tax, total, issued, title, payerId, payer, projectId: onlyProject ? onlyProject.id : null, projectIds: pids };
}

/**
 * 청구서 발행(개편 3단계 — 대기함 경로). 즉시 '발행' 상태. 세션 → '완료', 작업 → Completed·청구됨(금액 확정).
 * 0원 라인은 confirmZero가 있을 때만(폼이 확인창 후 세팅 — 서버가 최종 보루).
 */
function createInvoice(user, opts = {}) {
  const draft = buildInvoiceDraft(user, opts);
  if (!draft) return null;
  if (draft.items.some((it) => !(it.amount > 0)) && !opts.confirmZero) throw new Error("TASK_AMOUNT_REQUIRED");
  const miss = payerDocMissing(draft.payer); // 회사=사업자번호, 개인=현금영수증/사업자번호 — 폼도 막지만 서버가 최종 보루
  if (miss) throw new Error(miss);
  // 발행 이메일(건별, 2026-07-27): 폼이 프리필/직접 입력을 거쳤을 때만(payerEmailSet) 스냅샷에 반영. party는 불변.
  let payerSnapshot = snapshotPayer(draft.payerId);
  if (opts.payerEmailSet && payerSnapshot) {
    const v = String(opts.payerEmail == null ? "" : opts.payerEmail).trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error("PAYER_EMAIL_INVALID");
    const snap = JSON.parse(payerSnapshot);
    if (v !== String(snap.email == null ? "" : snap.email).trim()) {
      snap.email = v || null;
      snap.email_overridden = true;
      payerSnapshot = JSON.stringify(snap);
    }
  }
  const d = db();
  const invoiceNumber = nextInvoiceNumber(draft.issued);
  d.exec("BEGIN IMMEDIATE;");
  try {
    const invoiceId = d.prepare(
      `INSERT INTO invoices (project_id, payer_id, payer_snapshot, title, invoice_number, amount, tax_amount, discount_amount, paid_amount, status, issued_date, due_date, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '발행', ?, NULL, NULL)`
    ).run(draft.projectId, draft.payerId, payerSnapshot, draft.title, invoiceNumber, draft.total, draft.tax, draft.discountAmt, draft.issued).lastInsertRowid;
    const insertItem = d.prepare(
      `INSERT INTO invoice_items (invoice_id, task_id, session_id, track_title, task_type, description, quantity, unit_price, amount, item_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const markTask = d.prepare("UPDATE track_tasks SET is_invoiced = 1, invoice_id = ?, unit_price = ?, total_price = ?, status = 'Completed' WHERE id = ? AND is_invoiced = 0");
    // 세션: 청구=완료(예정 세션도), 확정액도 청구 금액으로 맞춘다(세션 화면에 '확정 청구액'으로 보이게).
    const markSession = d.prepare("UPDATE sessions SET status = CASE WHEN status = '취소' THEN status ELSE '완료' END, billing_amount = ? WHERE id = ?");
    for (const it of draft.items) {
      insertItem.run(invoiceId, it.task_id, it.session_id, it.track_title, it.task_type, it.description, it.quantity, it.unit_price, it.amount, it.item_date);
      if (it.task_id && !markTask.run(invoiceId, it.amount, it.amount, it.task_id).changes) throw new Error("TASK_NOT_BILLABLE"); // 동시 청구 경합
      if (it.session_id) markSession.run(it.amount, it.session_id);
    }
    // 작업을 청구하면 그 프로젝트의 **날짜가 지난 예정 믹싱·마스터링 세션**도 완료(2026-10-13 사용자 결정).
    // 후반작업은 세션이 아니라 작업으로 청구하므로 세션은 청구서에 안 들어가 '청구=완료'를 못 받았다 →
    // 아무도 완료를 안 누르면 청구가 끝난 프로젝트가 '진행 중'에 남았다(운영 실측 7개 프로젝트·세션 8건).
    // 앞으로 잡힌(오늘 이후) 세션은 아직 안 한 일이라 그대로 둔다.
    const taskProjects = [...new Set(draft.items.filter((it) => it._task).map((it) => it._task.project_id))];
    if (taskProjects.length) {
      d.prepare(
        `UPDATE sessions SET status = '완료'
          WHERE project_id IN (${taskProjects.map(() => "?").join(",")})
            AND session_type IN (${POSTPROD_IN}) AND status = '예정' AND session_date < ?`
      ).run(...taskProjects, todayYmd());
    }
    d.exec("COMMIT;");
    return getInvoiceForUser(user, invoiceId);
  } catch (e) {
    d.exec("ROLLBACK;");
    if (/UNIQUE constraint failed: invoice_items/.test(String(e && e.message))) throw new Error("TASK_NOT_BILLABLE");
    throw e;
  }
}

/** 미리보기 PDF용 초안(쓰기 없음) — 다음 번호를 peek해 문서에 표기. */
function invoicePreviewDraft(user, opts = {}) {
  const draft = buildInvoiceDraft(user, opts);
  if (!draft) return null;
  const invoice = {
    title: draft.title,
    invoice_number: nextInvoiceNumber(draft.issued), // peek — 소비 안 함
    amount: draft.total,
    tax_amount: draft.tax,
    discount_amount: draft.discountAmt,
    paid_amount: 0,
    status: "미발행",
    issued_date: draft.issued,
    due_date: null,
    client_id: draft.payerId,
    client_name: payerDisplayName(draft.payer),
  };
  return { client: draft.payer, invoice, items: draft.items };
}

/**
 * (호환) 한 프로젝트의 세션·작업 id로 청구 — 기존 테스트·호출부용 어댑터. 새 경로는 createInvoice(라인 배열).
 * 금액: taskAmounts/sessionAmounts 입력 > 작업 금액·세션 확정액 > 0. 설명은 기본 라벨(+ 조정 사유).
 */
function legacyLines(user, { projectId, taskIds, sessionIds, taskAmounts = {}, sessionAmounts = {}, taskMemos = {}, sessionMemos = {} } = {}) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const pick = (map, id) => (map[id] != null ? map[id] : map[String(id)]);
  const lines = [];
  for (const sid of (Array.isArray(sessionIds) ? sessionIds : []).map(Number).filter(Boolean)) {
    const s = db().prepare("SELECT * FROM sessions WHERE id = ? AND project_id = ?").get(sid, project.id);
    if (!s) throw new Error("TASK_NOT_BILLABLE");
    const a = pick(sessionAmounts, sid);
    const memo = String(pick(sessionMemos, sid) || "").trim();
    lines.push({ kind: "session", id: sid, amount: a != null && String(a).trim() !== "" ? a : s.billing_amount, description: memo ? `${sessionLineLabel(s, project.artist)} · ${memo}` : "" });
  }
  for (const tid of (Array.isArray(taskIds) ? taskIds : []).map(Number).filter(Boolean)) {
    const t = db().prepare("SELECT * FROM track_tasks WHERE id = ? AND project_id = ?").get(tid, project.id);
    if (!t) throw new Error("TASK_NOT_BILLABLE");
    const a = pick(taskAmounts, tid);
    const memo = String(pick(taskMemos, tid) || "").trim();
    lines.push({ kind: "task", id: tid, amount: a != null && String(a).trim() !== "" ? a : t.total_price, description: memo ? `${taskLineLabel(t, project.title)} · ${memo}` : "" });
  }
  if (!lines.length) throw new Error("TASK_IDS_REQUIRED");
  return lines;
}
function createInvoiceFromTasks(user, opts = {}) {
  const lines = legacyLines(user, opts);
  if (!lines) return null;
  return createInvoice(user, { ...opts, payerId: opts.clientId, lines });
}

function invoiceIsSettled(inv) {
  if (!inv) return false;
  return Number(inv.paid_amount) > 0 || (Boolean(inv.tax_status) && inv.tax_status !== "계산서 미발행");
}

/**
 * 청구 삭제. 연결된 작업의 잠금(is_invoiced)을 먼저 해제한 뒤 삭제해야 좀비 작업이 안 생긴다.
 * (FK는 invoice_id만 SET NULL로 지울 뿐 is_invoiced=1은 남으므로 명시적 UPDATE 필요.)
 *
 * '정정 = 삭제 후 재발행'은 유지하되, **확정 진행된 건은 치프·대표만**(스태프 차단).
 * @returns 삭제된 청구서 요약(감사 로그에 금액·입금까지 남기려면 삭제 전 값이 필요하다).
 */
function deleteInvoice(user, id) {
  if (!canBill(user)) return null;
  const inv = db().prepare("SELECT id, title, invoice_number, amount, paid_amount, tax_status FROM invoices WHERE id = ?").get(id);
  if (!inv) return null;
  if (invoiceIsSettled(inv) && !canInvoice(user)) throw new Error("INVOICE_SETTLED_FORBIDDEN");
  const d = db();
  d.exec("BEGIN IMMEDIATE;");
  try {
    d.prepare("UPDATE track_tasks SET is_invoiced = 0, invoice_id = NULL WHERE invoice_id = ?").run(id);
    d.prepare("DELETE FROM invoices WHERE id = ?").run(id); // invoice_items는 FK CASCADE
    d.exec("COMMIT;");
    return { ...inv };
  } catch (e) {
    d.exec("ROLLBACK;");
    throw e;
  }
}

// ── 청구(invoices) 목록·통계 — 클라이언트 범위 강제 ──

/**
 * 여러 청구서의 항목을 **한 쿼리**로(청구 목록 페이지 — 표시 행마다 listInvoiceItemsForInvoice를 부르면
 * 행당 2쿼리[내부 getInvoiceForUser 결과는 버려짐], 100행=200쿼리. 2026-07-15 점검). { [invoice_id]: rows[] }.
 * 정렬은 listInvoiceItemsForInvoice와 동일(ITEM_ORDER_SQL).
 */
function invoiceItemsByInvoiceIds(ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return {};
  const ph = list.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM invoice_items WHERE invoice_id IN (${ph}) ORDER BY invoice_id, ${ITEM_ORDER_SQL}`)
    .all(...list);
  const by = {};
  for (const r of rows) (by[r.invoice_id] = by[r.invoice_id] || []).push(r);
  return by;
}

/** 인보이스 목록(치프 전용 라우트에서 사용). 필터(status/clientId)는 옵션. */
function listInvoices(_user, { status, clientId } = {}) {
  const where = [];
  const params = {};
  if (status) {
    where.push(status === "입금완료" ? "i.tax_status = @status" : "i.status = @status"); // 입금완료는 계산서·입금 축(tax_status)
    params.status = status;
  }
  if (clientId) {
    where.push("i.payer_id = @clientId");
    params.clientId = Number(clientId);
  }
  // (목록 이메일 파생 payer_email·contact_email은 2026-07-08 목록 이메일 줄 폐지와 함께 제거 — 발행 이메일은 상세 청구처 카드에서.)
  const sql = `
    SELECT i.*, COALESCE(p.title, CASE WHEN (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) > 1 THEN '여러 프로젝트 (' || (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) || ')' END) AS project_title, p.production_company AS project_production, p.artist AS project_artist,
           ${PAYER_DISPLAY_SQL} AS client_name, c.kind AS payer_kind, c.is_artist AS payer_is_artist
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN parties c ON c.id = i.payer_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(i.issued_date, '') DESC, i.created_at DESC`; // 기본 = 발행일 최신순(2026-07-05 사용자 결정), 동일 발행일은 생성순
  return db().prepare(sql).all(params);
}

/** 전역 검색용 — 청구번호·청구처명·제목·아티스트 매칭(발행일 최신순).
 * SQL LIKE + LIMIT로 직접 거른다(2026-08-22 감사 — 예전엔 listInvoices(전량)를 불러 JS로 훑었는데,
 * 검색창은 키 입력마다 호출돼 청구가 늘수록 매 타이핑이 그만큼 느려졌다). SQLite LIKE는 ASCII만
 * 대소문자 무시라 JS의 toLowerCase() 비교와 실질적으로 동일하게 동작(한글은 대소문자 개념이 없음). */
function searchInvoices(_user, q, limit = 5) {
  const ql = String(q || "").trim();
  if (!ql) return [];
  const like = `%${ql}%`;
  const sql = `
    SELECT i.*, COALESCE(p.title, CASE WHEN (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) > 1 THEN '여러 프로젝트 (' || (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) || ')' END) AS project_title, p.production_company AS project_production, p.artist AS project_artist,
           ${PAYER_DISPLAY_SQL} AS client_name, c.kind AS payer_kind, c.is_artist AS payer_is_artist
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN parties c ON c.id = i.payer_id
    WHERE i.invoice_number LIKE @like OR i.title LIKE @like OR p.artist LIKE @like
       OR c.name LIKE @like OR c.activity_name LIKE @like
    ORDER BY COALESCE(i.issued_date, '') DESC, i.created_at DESC
    LIMIT @limit`;
  return db().prepare(sql).all({ like, limit });
}

/** 단건 인보이스(치프 전용 라우트에서 사용). */
function getInvoiceForUser(_user, id) {
  const row = db()
    .prepare(
      `SELECT i.*, COALESCE(p.title, CASE WHEN (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) > 1 THEN '여러 프로젝트 (' || (SELECT COUNT(DISTINCT COALESCE(s2.project_id, t2.project_id)) FROM invoice_items ii2 LEFT JOIN sessions s2 ON s2.id = ii2.session_id LEFT JOIN track_tasks t2 ON t2.id = ii2.task_id WHERE ii2.invoice_id = i.id) || ')' END) AS project_title, p.artist AS project_artist, ${PAYER_DISPLAY_SQL} AS client_name, c.kind AS payer_kind
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN parties c ON c.id = i.payer_id WHERE i.id = ?`
    )
    .get(id);
  return row || null;
}

/** 인보이스 요약 통계(미수금·이번 달 발행). */
function invoiceStats(_user) {
  // 권한은 호출부(dashboard showInvoices)가 게이트 — listInvoices와 동일하게 user 미사용.
  // 합계는 SQL 집계로(2026-07-09 감사 — 이전엔 전건 로드 후 JS reduce, 청구 누적 시 대시보드 렌더마다 전 행 순회).
  const month = todayYmd().slice(0, 7); // 'YYYY-MM'
  const agg = db()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = '발행' THEN MAX(amount - paid_amount, 0) END), 0) AS receivable,
         COALESCE(SUM(CASE WHEN status <> '미발행' AND substr(COALESCE(issued_date, ''), 1, 7) = ? THEN amount END), 0) AS thisMonthIssued
       FROM invoices`
    )
    .get(month);
  return { receivable: agg.receivable, thisMonthIssued: agg.thisMonthIssued, total: agg.total };
}

/** 프로젝트의 인보이스 목록(권한 검사). 권한 없으면 null. */
/** 청구서에 라인이 걸린 프로젝트들(여러 프로젝트 청구서 상세 표시용). */
function projectsForInvoice(invoiceId) {
  return db().prepare(
    `SELECT DISTINCT p.id, p.title FROM invoice_items ii
       LEFT JOIN sessions s ON s.id = ii.session_id
       LEFT JOIN track_tasks t ON t.id = ii.task_id
       JOIN projects p ON p.id = COALESCE(s.project_id, t.project_id)
      WHERE ii.invoice_id = ? ORDER BY p.title`
  ).all(Number(invoiceId));
}

function listInvoicesForProject(user, projectId) {
  const project = getProjectForUser(user, projectId);
  if (!project) return null;
  const rows = db()
    .prepare(
      `SELECT i.*, ${PAYER_DISPLAY_SQL} AS client_name, c.kind AS payer_kind FROM invoices i
       LEFT JOIN parties c ON c.id = i.payer_id
       WHERE i.project_id = @pid
          OR i.id IN (SELECT ii.invoice_id FROM invoice_items ii
                        LEFT JOIN sessions s ON s.id = ii.session_id
                        LEFT JOIN track_tasks t ON t.id = ii.task_id
                       WHERE COALESCE(s.project_id, t.project_id) = @pid)
       ORDER BY i.created_at DESC, i.id DESC`
    )
    .all({ pid: Number(projectId) }); // 여러 프로젝트를 섞은 청구서(project_id NULL)도 라인으로 찾는다(개편 3단계)
  return { project, rows };
}

module.exports = {
  invoiceCsv,
  INVOICE_CSV_HEADERS,
  invoiceItemsByInvoiceIds,
  balanceOf,
  invoiceTaxTab,
  payStatusOf,
  listUnbilledTasksForProject,
  listBillableSessionsForProject,
  isSessionInvoiced,
  listInvoiceItemsForInvoice,
  ensureInvoiceNumber,
  peekInvoiceNumber: nextInvoiceNumber, // 청구 생성 전 미리보기 PDF 파일명(다음 번호 peek — 소비 안 함)
  invoiceAmountsFromSupply,
  createInvoiceFromTasks,
  createInvoice,
  buildInvoiceDraft,
  invoicePreviewDraft,
  listBillableItems,
  composeLinesForKeys,
  sessionLineLabel,
  taskLineLabel,
  snapshotPayer,
  payerSnapshotChanged,
  refreshedPayerSnapshot,
  payerDocMeta,
  payerDocMissing,
  invoiceIsSettled,
  deleteInvoice,
  listInvoices,
  getInvoiceForUser,
  searchInvoices,
  invoiceStats,
  listInvoicesForProject,
  projectsForInvoice,
  listPayments,
  addPayment,
  deletePayment,
  recomputePaid,
};
