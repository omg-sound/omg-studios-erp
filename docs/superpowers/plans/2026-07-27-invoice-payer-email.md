# 청구 생성 폼 — 발행 이메일 필드(청구서 건별 override) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 청구 탭의 청구 생성 폼에서 청구처를 선택하면 세금계산서 발행 이메일이 프리필된 입력칸을 보여주고, 제출 시 보이는 값을 이번 청구서의 발행 스냅샷(`payer_snapshot.email`)에만 기록한다(청구처 party 정보 불변).

**Architecture:** 스냅샷 우선 표시 구조(`payerView`)를 그대로 활용 — `createInvoiceFromTasks`가 스냅샷 저장 직전에 `email`을 덮어쓰고 `email_overridden` 플래그를 남긴다. 다운스트림(청구처 카드·알림 메일·PDF)은 무변경. `payerSnapshotChanged`는 플래그가 있으면 이메일 비교를 제외하고, [새로고침]은 임의 이메일을 보존한다. 폼 쪽은 기존 `data-payer-fix` show/hide 패턴과 콤보 옵션 JSON 프리필을 따른다.

**Tech Stack:** Express + better-sqlite3(기존), 서버 렌더 뷰(`views.js`/`views.projects.js`), `public/js/app.js`(CSP-safe, 인라인 0), `node:test` + jsdom.

**스펙:** `docs/superpowers/specs/2026-07-27-invoice-payer-email-design.md`

## Global Constraints

- 돈=정수(원), 날짜=`"YYYY-MM-DD"` — 이 기능은 무관하지만 파일 규약 준수.
- CSP: 인라인 script/style 금지 — 모든 상호작용은 `public/js/app.js`의 data-* 마커로(가드 ⑩·⑮).
- 보이는 입력에 bare `name="name|company|address"` 금지(가드 ①) — `payer_email`은 해당 없음(확인됨).
- app.js가 찾는 data-* 마커는 서버 템플릿에 존재해야 함(가드 ⑧) — 서버·app.js 양쪽에 같은 마커 사용.
- 에러코드는 throw와 사용자 메시지 맵 양쪽에 있어야 함(가드 ④) — `PAYER_EMAIL_INVALID` 추가 시 둘 다.
- 이메일 형식 정규식은 mailer와 동일 패턴: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- WYSIWYG 규칙: `payer_email_set=1`일 때만 필드 값이 스냅샷 이메일(빈값=null). 마커 없으면(JS-off) 기존 동작.
- 커밋 후 push(사용자 지침). **배포는 하지 않는다**(수동 배포 — 사용자가 시점 결정).

---

### Task 1: 데이터 계층 — 스냅샷 override·변경감지 제외·새로고침 보존

**Files:**
- Modify: `src/data/invoices.js` (createInvoiceFromTasks ~L399, payerSnapshotChanged ~L63, module.exports ~L640)
- Test: `test/party.test.js` (기존 payerSnapshotChanged 테스트 뒤, ~L417 이후에 추가)

**Interfaces:**
- Consumes: `snapshotPayer(payerId)`(기존), `getParty`(기존).
- Produces: `createInvoiceFromTasks(user, opts)`의 새 opts — `payerEmail: string|null`, `payerEmailSet: boolean`. 새 export `refreshedPayerSnapshot(inv) → string|null`(Task 2의 refresh-payer 라우트가 사용). 스냅샷 JSON에 새 키 `email_overridden: true`(있을 때만).

- [ ] **Step 1: 실패하는 테스트 작성** — `test/party.test.js`의 `payerSnapshotChanged` 테스트(~L417) 바로 뒤에 추가:

```js
// ── 발행 이메일 건별 override(2026-07-27): 폼 값 = 이번 청구서의 발행 이메일(WYSIWYG). party 불변·스냅샷에만. ──
test("발행 이메일 override: 스냅샷에만 기록·party 불변·빈값=없음·마커 없으면 기존 동작·형식 검사·변경감지 제외·새로고침 보존", () => {
  const co = D.createCompany({ name: "이메일오버사", roles: "제작사", biz_no: "111-22-33344" });
  db().prepare("UPDATE parties SET email='base@co.kr' WHERE id=?").run(co);
  const mk = (opts) => {
    const pid = Number(db().prepare("INSERT INTO projects (title, project_type, rate) VALUES ('이멜','task',0)").run().lastInsertRowid);
    const tr = Number(db().prepare("INSERT INTO project_tracks (project_id, title, content_type) VALUES (?, '곡', 'Music')").run(pid).lastInsertRowid);
    const tk = Number(db().prepare("INSERT INTO track_tasks (track_id, task_type, billing_type, quantity, unit_price, total_price, status, is_invoiced) VALUES (?, 'Mixing', 'Fixed_Per_Track', 1, 100000, 100000, 'Completed', 0)").run(tr).lastInsertRowid);
    return D.createInvoiceFromTasks(CHIEF, { projectId: pid, taskIds: [tk], clientId: co, issueDate: "2026-07-27", ...opts });
  };
  const snapOf = (id) => JSON.parse(db().prepare("SELECT payer_snapshot FROM invoices WHERE id=?").get(id).payer_snapshot);

  // ① 프리필 그대로(party 이메일과 동일) = 기존 동작·플래그 없음
  const i1 = mk({ payerEmail: "base@co.kr", payerEmailSet: true });
  assert.equal(snapOf(i1.id).email, "base@co.kr", "동일 값 = 스냅샷 그대로");
  assert.ok(!snapOf(i1.id).email_overridden, "동일 값 = override 플래그 없음");

  // ② 다른 주소 = 스냅샷만 교체 + 플래그, party 불변
  const i2 = mk({ payerEmail: "other@x.com", payerEmailSet: true });
  assert.equal(snapOf(i2.id).email, "other@x.com", "임의 주소가 스냅샷에");
  assert.equal(snapOf(i2.id).email_overridden, true, "override 플래그");
  assert.equal(db().prepare("SELECT email FROM parties WHERE id=?").get(co).email, "base@co.kr", "party 이메일 불변");

  // ③ 빈칸으로 지움 = 이메일 없음(null) + 플래그 (폴백 아님 — 명시적 의사)
  const i3 = mk({ payerEmail: "", payerEmailSet: true });
  assert.equal(snapOf(i3.id).email, null, "빈값 = 이메일 없음");
  assert.equal(snapOf(i3.id).email_overridden, true, "빈값도 override");

  // ④ 마커 없으면(JS-off 제출) 기존 동작 — 빈 필드가 이메일을 지우지 않는다
  const i4 = mk({ payerEmail: "", payerEmailSet: false });
  assert.equal(snapOf(i4.id).email, "base@co.kr", "마커 없으면 party 이메일 스냅샷(기존 동작)");
  assert.ok(!snapOf(i4.id).email_overridden, "마커 없으면 플래그 없음");

  // ⑤ 형식 불량은 생성 차단(값이 있을 때만 검사 — 빈값은 '없음'이라 통과)
  assert.throws(() => mk({ payerEmail: "not-an-email", payerEmailSet: true }), /PAYER_EMAIL_INVALID/, "형식 불량 차단");

  // ⑥ 변경 감지: override면 이메일 비교 제외(거짓 '정보 업데이트' 경고 방지), 다른 필드 변경은 여전히 감지
  const inv2 = () => db().prepare("SELECT * FROM invoices WHERE id=?").get(i2.id);
  assert.equal(D.payerSnapshotChanged(inv2()), false, "override ≠ party 이메일이어도 변경 아님");
  db().prepare("UPDATE parties SET address='서울 어딘가' WHERE id=?").run(co);
  assert.equal(D.payerSnapshotChanged(inv2()), true, "주소 변경은 여전히 감지");

  // ⑦ [새로고침] = party 정보 갱신하되 임의 이메일 보존
  db().prepare("UPDATE invoices SET payer_snapshot=? WHERE id=?").run(D.refreshedPayerSnapshot(inv2()), i2.id);
  assert.equal(snapOf(i2.id).email, "other@x.com", "새로고침 후 임의 이메일 보존");
  assert.equal(snapOf(i2.id).email_overridden, true, "플래그도 보존");
  assert.equal(snapOf(i2.id).address, "서울 어딘가", "다른 필드는 현재 party 값으로 갱신");
  assert.equal(D.payerSnapshotChanged(inv2()), false, "새로고침 후 변경 없음");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/party.test.js 2>&1 | tail -20`
Expected: FAIL — `refreshedPayerSnapshot is not a function` 또는 ② 단언 실패(override 미구현).

- [ ] **Step 3: 구현** — `src/data/invoices.js` 세 곳:

(a) `createInvoiceFromTasks`(~L399): `const d = db();` 줄 **앞**에 스냅샷 계산 블록 추가, INSERT의 `payer_snapshot` 값을 변수로 교체:

```js
  // 발행 이메일(청구서 건별, 2026-07-27 스펙): 폼이 프리필/직접 입력을 거쳤을 때만(payerEmailSet) 적용 —
  // 보이는 값 = 이번 청구서의 발행 이메일(빈값=이메일 없음). party 정보는 불변, 스냅샷에만 기록.
  // 마커 없으면(JS-off 제출) 기존 동작 — 빈 필드가 이메일을 조용히 지우는 사고 방지.
  let payerSnapshot = snapshotPayer(draft.resolvedPayerId);
  if (opts.payerEmailSet && payerSnapshot) {
    const v = String(opts.payerEmail == null ? "" : opts.payerEmail).trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error("PAYER_EMAIL_INVALID"); // mailer.invalidRecipients와 동일 패턴
    const snap = JSON.parse(payerSnapshot);
    if (v !== String(snap.email == null ? "" : snap.email).trim()) {
      snap.email = v || null;
      snap.email_overridden = true; // payerSnapshotChanged 이메일 비교 제외·[새로고침] 보존 판정 플래그
      payerSnapshot = JSON.stringify(snap);
    }
  }
```

INSERT `.run({...})`의 기존 줄 `payer_snapshot: snapshotPayer(draft.resolvedPayerId), // 발행 시점 청구처 정보 고정`을 다음으로 교체:

```js
        payer_snapshot: payerSnapshot, // 발행 시점 청구처 정보 고정(건별 발행 이메일 반영)
```

(b) `payerSnapshotChanged`(~L70): `fields` 줄을 다음으로 교체:

```js
  const fields = ["name", "activity_name", "owner_name", "biz_no", "address", "email", "cash_receipt_no"]
    .filter((f) => !(f === "email" && a.email_overridden)); // 건별 임의 이메일(2026-07-27) — party와 다른 게 정상이라 비교 제외
```

(c) `payerSnapshotChanged` 함수 아래에 새 함수 추가 + `module.exports`(~L640, `payerSnapshotChanged` 옆)에 `refreshedPayerSnapshot` 추가:

```js
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
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/party.test.js 2>&1 | tail -20`
Expected: PASS (기존 테스트 포함 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/data/invoices.js test/party.test.js
git commit -m "feat: 청구서 건별 발행 이메일 override — 스냅샷에만 기록·변경감지 제외·새로고침 보존"
```

---

### Task 2: 라우트 배선 — from-tasks 파라미터·오류 맵·refresh-payer 헬퍼

**Files:**
- Modify: `src/routes/projects.routes.js:656-687` (from-tasks 라우트)
- Modify: `src/routes/invoices.routes.js:19-20, 296-301` (import·refresh-payer 라우트)

**Interfaces:**
- Consumes: Task 1의 `createInvoiceFromTasks` opts(`payerEmail`/`payerEmailSet`), `refreshedPayerSnapshot(inv)`.
- Produces: 폼 필드 계약 — `payer_email`(텍스트)·`payer_email_set`("1"일 때만 규칙 적용). Task 3·4가 이 name으로 렌더·제출.

- [ ] **Step 1: from-tasks 라우트 수정** — `createInvoiceFromTasks` 호출 opts에 추가(`confirmZero` 줄 뒤):

```js
      payerEmail: req.body.payer_email, // 발행 이메일(청구서 건별, 2026-07-27) — 보이는 값 = 이번 청구서의 발행 이메일
      payerEmailSet: req.body.payer_email_set === "1", // JS가 프리필/직접입력 시 1. 없으면(JS-off) 기존 동작(청구처 이메일)
```

같은 라우트의 `known` 오류 맵에 추가(가드 ④ — throw와 메시지 맵 양쪽 필수):

```js
PAYER_EMAIL_INVALID: "세금계산서 발행 이메일 형식이 올바르지 않습니다. (예: name@example.com)",
```

- [ ] **Step 2: refresh-payer 라우트 수정** — `src/routes/invoices.routes.js` 상단 import(snapshotPayer 옆)에 `refreshedPayerSnapshot` 추가하고, L299를 교체:

```js
  // 건별 임의 발행 이메일(email_overridden)은 보존 — 새로고침은 party 정보 보정이지 override 취소가 아니다(2026-07-27).
  if (inv.payer_id) db().prepare("UPDATE invoices SET payer_snapshot = ? WHERE id = ?").run(refreshedPayerSnapshot(inv), inv.id);
```

- [ ] **Step 3: 가드·전체 테스트 통과 확인** — 가드 ④가 PAYER_EMAIL_INVALID의 throw↔메시지 맵 정합을 기계 검사한다.

Run: `node --test test/guardrails.test.js test/party.test.js 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/routes/projects.routes.js src/routes/invoices.routes.js
git commit -m "feat: 청구 폼 발행 이메일 제출 배선(payer_email/payer_email_set) + 새로고침 override 보존"
```

---

### Task 3: 뷰 — 콤보 옵션에 email 탑재 + 이메일 입력 행 마크업

**Files:**
- Modify: `src/data/parties.js:828-838` (clientOptions SELECT에 email)
- Modify: `src/views.js:780-823` (payerCombo items에 email)
- Modify: `src/views.projects.js:925-937` (청구처 블록에 이메일 행)

**Interfaces:**
- Consumes: Task 2의 폼 필드 계약(`payer_email`/`payer_email_set`).
- Produces: 콤보 옵션 JSON(`data-pk-options`) 각 항목에 `email: string|null` 키. 서버 렌더 마커 `data-payer-email-row`(컨테이너, 기본 hidden)·`data-payer-email`(보이는 입력)·`data-payer-email-set`(hidden 마커, 기본 "0") — Task 4의 app.js가 소비(가드 ⑧ 충족).

- [ ] **Step 1: clientOptions에 email 추가** — `src/data/parties.js` L831 SELECT의 `p.kind,` 뒤에 `p.email,` 추가:

```js
      `SELECT p.id, COALESCE(NULLIF(p.activity_name,''), p.name) AS name, p.name AS real_name, p.activity_name, p.kind, p.email,
```

(contactOptions는 이미 email 포함 — 무변경.)

- [ ] **Step 2: payerCombo items에 email 추가** — `src/views.js` payerCombo의 두 map 반환 객체에 각각 `email` 키 추가:

클라이언트 쪽(L799):
```js
      return { label, sub, cid: c.id, pid: 0, co, warn, email: c.email || null };
```
담당자 쪽(L803, 반환 객체 끝에 `email: o.email || null` 추가):
```js
      return { label: personLabel(o.name, o.activity_name), sub: "담당자" + (aff ? " · " + aff : o.phone ? " · " + o.phone : ""), cid: 0, pid: o.id, co: 0, warn: cashSet.has(Number(o.id)) ? "" : PS_WARN, email: o.email || null }; // 담당자도 아티스트면 본명 (활동명)
```

- [ ] **Step 3: 이메일 행 마크업** — `src/views.projects.js` 청구처 블록의 `data-payer-fix` div 닫는 `</div>`(L936) 바로 뒤, 바깥 `</div>` 앞에 추가:

```html
        <div data-payer-email-row class="mt-1.5 hidden">
          <label class="label mb-1 text-xs">세금계산서 발행 이메일</label>
          <input class="input py-1.5 text-sm" type="text" name="payer_email" inputmode="email" autocomplete="off" data-payer-email />
          <input type="hidden" name="payer_email_set" value="0" data-payer-email-set />
          ${explain("이번 청구서에만 적용됩니다 — 청구처 정보는 바뀌지 않습니다. 비우면 이 청구서는 발행 이메일 없이 기록됩니다.")}
        </div>
```

- [ ] **Step 4: 뷰·가드 테스트 통과 확인** (서버 전용 마커는 가드 ⑧ 위반 아님 — app.js 소비는 Task 4에서 연결)

Run: `npm test 2>&1 | tail -5`
Expected: PASS (전체).

- [ ] **Step 5: 커밋**

```bash
git add src/data/parties.js src/views.js src/views.projects.js
git commit -m "feat: 청구 폼 발행 이메일 행 렌더 + 청구처 콤보 옵션에 email 탑재"
```

---

### Task 4: app.js — 프리필·마커·초안 + jsdom 테스트

**Files:**
- Modify: `public/js/app.js` (payerCombo IIFE ~L2632-2763, 초안 IIFE ~L2767-2831)
- Test: `test/ui-interactions.test.js` (초안 키 계약 테스트 ~L1332 갱신 + 신규 테스트)

**Interfaces:**
- Consumes: Task 3의 마커(`data-payer-email-row`/`data-payer-email`/`data-payer-email-set`)와 옵션 `email` 키.
- Produces: 마커 규칙 구현 — 프리필(옵션에 있는 청구처 선택) 또는 사용자 직접 입력 시 `payer_email_set="1"`. 초안 키 `pe`(값)·`pes`(마커) 추가.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/ui-interactions.test.js`에 추가. (기존 초안 키 계약도 함께 갱신 — Step 2에서 기존 테스트 실패 확인.)

신규 테스트(청구 초안 테스트들 뒤에 추가). 콤보 마크업은 기존 수동 HTML 패턴(L1272)을 따르되 payerCombo·이메일 행 구조를 그대로 미러:

```js
// ── 발행 이메일(청구서 건별, 2026-07-27): 청구처 선택 → 프리필+마커, 옵션 밖 당사자 → 빈칸+마커0(직접 입력 시 1), 선택 해제 → 숨김 ──
test("발행 이메일 필드: 선택 시 프리필·payer_email_set=1, 옵션 밖 당사자는 빈칸·마커0(입력하면 1), 미선택은 숨김", () => {
  const opts = [
    { label: "이멜상사", sub: "업체", cid: 11, pid: 0, co: 1, warn: "", email: "tax@emel.kr" },
    { label: "무메일상사", sub: "업체", cid: 12, pid: 0, co: 1, warn: "", email: null },
  ];
  const html = `<form data-discount-form data-supply="0" action="/projects/9/invoices/from-tasks">
    <div data-picker-combo>
      <input type="hidden" name="client_id" value="" data-pk-cid />
      <input type="hidden" name="payer_contact_id" value="" data-pk-pid />
      <input type="text" data-pk-input /><div data-pk-pop hidden></div>
      <script type="application/json" data-pk-options>${JSON.stringify(opts)}</script>
    </div>
    <div data-payer-email-row class="hidden">
      <input type="text" name="payer_email" data-payer-email />
      <input type="hidden" name="payer_email_set" value="0" data-payer-email-set />
    </div></form>`;
  const { win, doc } = mountDom(html);
  const row = doc.querySelector("[data-payer-email-row]");
  const email = doc.querySelector("[data-payer-email]");
  const marker = doc.querySelector("[data-payer-email-set]");
  const combo = doc.querySelector("[data-picker-combo]");

  assert.equal(row.classList.contains("hidden"), true, "미선택 = 숨김");
  assert.equal(marker.value, "0", "미선택 = 마커 0");

  combo.__pkSet({ cid: "11", label: "이멜상사" }); // 옵션에 있는 청구처 → pick 경로
  assert.equal(row.classList.contains("hidden"), false, "선택 = 표시");
  assert.equal(email.value, "tax@emel.kr", "청구처 이메일 프리필");
  assert.equal(marker.value, "1", "프리필 = 마커 1(WYSIWYG 규칙 적용)");

  combo.__pkSet({ cid: "12", label: "무메일상사" }); // 이메일 없는 청구처 → 빈 프리필
  assert.equal(email.value, "", "이메일 없는 청구처 = 빈칸");
  assert.equal(marker.value, "1", "옵션에 있는 청구처는 이메일 없어도 마커 1(빈값=없음 그대로)");

  combo.__pkSet({ cid: "999", label: "옵션밖관계자" }); // 옵션 밖 당사자(추천 칩 관계자 등) — 이메일 미상
  assert.equal(row.classList.contains("hidden"), false, "선택은 됐으니 표시");
  assert.equal(email.value, "", "이메일 미상 = 빈칸");
  assert.equal(marker.value, "0", "미상은 마커 0 — 모르는 이메일을 지운 것으로 오인 방지");
  email.value = "typed@x.com"; fire(win, email, "input"); // 직접 입력
  assert.equal(marker.value, "1", "직접 입력 = 마커 1");

  const pk = doc.querySelector("[data-pk-input]");
  pk.value = ""; fire(win, pk, "input"); // 검색칸 비움 → 선택 해제(cid/pid 클리어)
  assert.equal(row.classList.contains("hidden"), true, "선택 해제 = 숨김");
  assert.equal(marker.value, "0", "해제 = 마커 0");
});

// 초안(임시저장)에 발행 이메일 포함 — __pkSet 프리필 뒤에 복원돼 입력값이 덮이지 않는다.
test("청구 초안: 발행 이메일(pe·pes) 저장·복원 — 복원이 프리필을 이긴다", () => {
  const project = { id: 7, title: "테스트 프로젝트" };
  const tasks = [{ id: 1, task_type: "vocal_tune", track_title: "곡A", status: "Completed", total_price: 100000, waived: 0 }];
  const formHtml = unbilledInvoiceForm(project, tasks, []);
  const seed = { p: { cid: "42", pid: "", label: "복원청구처" }, da: "", dp: "", vat: true, t: "", pe: "draft@x.com", pes: "1" };
  const r = mountDom(formHtml, { storage: { "invdraft:7": JSON.stringify(seed) } });
  assert.equal(r.doc.querySelector("[data-payer-email]").value, "draft@x.com", "복원: 초안 이메일이 프리필을 덮음");
  assert.equal(r.doc.querySelector("[data-payer-email-set]").value, "1", "복원: 마커도 초안대로");
});
```

기존 초안 키 계약(L1332) 갱신:

```js
  assert.equal(Object.keys(draft).sort().join(","), "da,dp,p,pe,pes,t,vat", "초안 키 = 금액·발행일 없는 폼 필드만(p·da·dp·vat·t·pe·pes)");
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/ui-interactions.test.js 2>&1 | tail -20`
Expected: FAIL — 신규 테스트(row 숨김 유지·프리필 없음)와 갱신한 키 계약(pe·pes 없음) 실패.

- [ ] **Step 3: app.js 구현** — 두 IIFE 수정:

(a) payerCombo IIFE(~L2646 `fixBtn` 선언부 근처)에 요소 참조 추가:

```js
    // 발행 이메일(청구서 건별, 2026-07-27): 선택 시 표시+프리필. 마커(payer_email_set)=프리필했거나 직접 입력했으면 1 —
    // 서버는 마커 있을 때만 '보이는 값 = 발행 이메일' 규칙 적용(JS-off 제출이 이메일을 지우는 사고 방지).
    var emailRow = form ? form.querySelector("[data-payer-email-row]") : null;
    var emailInput = form ? form.querySelector("[data-payer-email]") : null;
    var emailSet = form ? form.querySelector("[data-payer-email-set]") : null;
    function applyEmail(it) {
      if (!emailRow || !emailInput || !emailSet) return;
      if (!cid.value && !pid.value) { emailRow.classList.add("hidden"); emailInput.value = ""; emailSet.value = "0"; return; }
      emailRow.classList.remove("hidden");
      if (it) { emailInput.value = it.email || ""; emailSet.value = "1"; } // 옵션에 있는 청구처 = 이메일을 안다(없음 포함)
      else { emailInput.value = ""; emailSet.value = "0"; } // 옵션 밖 당사자(추천 칩 관계자 등) — 미상은 규칙 미적용
    }
    if (emailInput) emailInput.addEventListener("input", function () { if (emailSet) emailSet.value = "1"; }); // 직접 입력 = 사용자 결정
```

`applyDoc` 함수 본문 끝(fixBox 처리 뒤)에 한 줄 추가:

```js
      applyEmail(it);
```

(b) 초안 IIFE: 요소 참조(L2778 `title` 선언 뒤) 추가:

```js
  var pemail = form.querySelector("[data-payer-email]");
  var pemailSet = form.querySelector("[data-payer-email-set]");
```

`read()` 반환 객체에 추가(`t:` 줄 뒤):

```js
      pe: pemail ? pemail.value : "",
      pes: pemailSet ? pemailSet.value : "0"
```

복원 블록(`if (s) {` 안, `payer.__pkSet(s.p)` 호출 **뒤**·미리보기 갱신 앞)에 추가:

```js
    // 발행 이메일은 __pkSet(프리필) 뒤에 복원 — 저장해 둔 입력값이 프리필에 덮이지 않게(구 초안엔 pe 없음 → 프리필 유지).
    if (s.pe != null && pemail) { pemail.value = s.pe; if (pemailSet) pemailSet.value = s.pes === "1" ? "1" : "0"; }
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/ui-interactions.test.js test/guardrails-ui.test.js 2>&1 | tail -10`
Expected: PASS (가드 ⑧ — app.js가 찾는 새 마커 3종이 views.projects.js에 렌더됨).

- [ ] **Step 5: 커밋**

```bash
git add public/js/app.js test/ui-interactions.test.js
git commit -m "feat: 청구 폼 발행 이메일 프리필·마커·초안(pe/pes) — WYSIWYG 규칙 클라이언트 구현"
```

---

### Task 5: 전체 검증 + 문서 현행화

**Files:**
- Modify: `CLAUDE.md` (청구 섹션·데이터 모델 invoices 항목)

- [ ] **Step 1: 전체 테스트**

Run: `npm test 2>&1 | tail -5`
Expected: 전부 PASS(스모크 포함).

- [ ] **Step 2: 실서버 육안 확인(로컬)** — `pkill -f "src/server.js"`(함정 #5) 후 `DEV_LOGIN=1 node src/server.js`로 기동, 프로젝트 청구 탭에서: 청구처 선택 → 이메일 행 표시·프리필 확인, 다른 주소 입력 후 청구 생성 → 청구 상세 청구처 카드에 그 주소·거짓 '정보 업데이트' 경고 없음 확인. 확인 후 서버 종료.

- [ ] **Step 3: CLAUDE.md 현행화** — 두 곳:
  - 청구 섹션(청구 생성 폼 항목)에 추가: **발행 이메일(청구서 건별, 2026-07-27)** — 청구처 선택 시 세금계산서 발행 이메일 프리필 표시, 제출 시 보이는 값이 이번 청구서 스냅샷 `email`(빈값=없음, WYSIWYG). party 불변·`email_overridden` 플래그로 `payerSnapshotChanged` 이메일 비교 제외·[새로고침] 보존(`refreshedPayerSnapshot`). 마커 `payer_email_set` 없으면(JS-off) 기존 동작. 초안 키 pe/pes.
  - 데이터 모델 `invoices`의 `payer_snapshot` 설명에 `email_overridden`(건별 발행 이메일 override 플래그) 한 줄.

- [ ] **Step 4: 커밋 + push**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-07-27-invoice-payer-email.md
git commit -m "docs: 발행 이메일 건별 override 현행화(청구 폼·payer_snapshot 플래그)"
git push
```

(배포는 하지 않는다 — 수동 배포, 사용자가 시점 결정.)
