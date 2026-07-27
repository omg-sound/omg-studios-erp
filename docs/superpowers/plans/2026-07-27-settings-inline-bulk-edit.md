# 환경설정 인라인 편집 + 통합 저장 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 환경설정의 단가표·룸·작업 종류 3섹션을 접이식 '수정' 폼 대신 **한 줄 인라인 편집 필드 + 섹션당 통합 저장 1개**로 바꾼다.

**Architecture:** 데이터 계층에 섹션별 bulk 함수 3개(`bulkUpdate*` — body의 `<필드>_<id>` 묶음을 행별로 모아 기존 행 단위 update 함수를 한 트랜잭션으로 호출), 라우트는 얇은 배선. 뷰는 행 = 편집 필드 그리드로 재작성하고, 행별 즉시 액션(↑↓·삭제·비활성)은 **중첩 폼 금지** 때문에 `form=` 속성 + 형제 hidden 폼 패턴(장비 대장 검증 패턴)으로 유지. app.js는 MONEY 정규식만 확장.

**Tech Stack:** Express + better-sqlite3(기존), 서버 렌더 뷰(`views.settings.js`), Tailwind(임의값 그리드는 **리터럴 클래스**), node:test.

**스펙:** `docs/superpowers/specs/2026-07-27-settings-inline-bulk-edit-design.md`

## Global Constraints

- CSP: 서버 인라인 style/script 금지(함정 #27) — 치수·그리드는 Tailwind 리터럴 클래스로.
- 중첩 `<form>` 금지 — 브라우저가 내부 폼을 버린다. 행 안 버튼은 `form="<id>"`로 형제 hidden 폼에 연결.
- 가드 ⑫: 금액성 input name은 app.js MONEY 정규식에 매칭돼야 한다 — `base_price_\d+`·`extra_price_\d+`·`unit_price_\d+` 추가 필수(뷰 변경과 같은 커밋에).
- 행 단위 검증 의미론 유지: 이름 비움 = 그 행만 조용히 건너뜀(`RATE_NAME_REQUIRED`/`ROOM_NAME_REQUIRED`/`TASK_TYPE_LABEL_REQUIRED`, 단가표는 `RATE_PRICE_REQUIRED`도). 그 외 오류 = 롤백 후 재던짐.
- ⚠️ `updateTaskType`은 `sort_order` 미전송 시 **100으로 리셋**(taskTypeFields 기본값) — bulk는 반드시 현재 `sort_order`를 명시 전달해 순서 보존.
- 삭제 확인 문구(`data-confirm`)는 기존 문구 그대로 유지.
- 섹션 앵커 id: `rates-section` · `task-types-section` · `rooms-section`. bulk 저장·행 액션 리다이렉트에 부착.
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. 커밋 후 push는 마지막 태스크에서만. **배포는 하지 않는다.**

---

### Task 1: 데이터 계층 — bulk 함수 3개

**Files:**
- Modify: `src/data/rate-items.js` (updateRateItem ~L84 아래 + module.exports)
- Modify: `src/data/rooms.js` (updateRoom ~L84 아래 + module.exports)
- Modify: `src/data/task-types.js` (updateTaskType ~L97 아래 + module.exports)
- Test: `test/settings-bulk.test.js` (신규)

**Interfaces:**
- Consumes: 기존 `updateRateItem(id, input)`·`updateRoom(id, input)`·`updateTaskType(id, input)`. ⚠️ 각 함수가 읽는 input 키를 rateFields/roomFields/taskTypeFields에서 **실제로 확인**하고 bulk의 키 매핑을 맞출 것(단가표=`rate_name`·`category`·`base_hours`·`base_price`·`extra_hours`·`extra_price`·`price_type`, 룸=roomFields가 읽는 이름 필드[`room_name` 계열]·`parent_id`·`bookable`·`is_external`, 작업 종류=`label`·`billing_type`·`unit_price`·`price_type`·`is_quick`·`sort_order`).
- Produces: `bulkUpdateRateItems(body)` / `bulkUpdateRooms(body)` / `bulkUpdateTaskTypes(body)` — 각각 `{updated, skipped}` 반환, module.exports에 추가(src/data.js가 spread하므로 자동 노출). Task 2의 라우트가 사용.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/settings-bulk.test.js` 신규(격리 임시 DB 패턴은 `test/rooms.test.js` 상단과 동일하게):

```js
"use strict";

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const D = require("../src/data");

init();

test.after(() => cleanupDb(process.env.DB_PATH, db()));

test("bulkUpdateRateItems: 여러 행 동시 갱신·미참여 행 불변·임의 id 무시·이름 비운 행만 건너뜀", () => {
  const a = D.createRateItem({ rate_name: "벌크A", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000", extra_price: "100000" });
  const b = D.createRateItem({ rate_name: "벌크B", category: "스튜디오 녹음", base_hours: "4", base_price: "400000", extra_price: "100000" });
  const c = D.createRateItem({ rate_name: "벌크C", category: "스튜디오 녹음", base_hours: "2", base_price: "200000", extra_price: "100000" });
  const r = D.bulkUpdateRateItems({
    [`rate_name_${a.id}`]: "벌크A2", [`category_${a.id}`]: "스튜디오 녹음", [`base_hours_${a.id}`]: "5", [`base_price_${a.id}`]: "500,000", [`extra_hours_${a.id}`]: "1", [`extra_price_${a.id}`]: "100000", [`price_type_${a.id}`]: "base",
    [`rate_name_${b.id}`]: "", [`category_${b.id}`]: "스튜디오 녹음", [`base_hours_${b.id}`]: "4", [`base_price_${b.id}`]: "400000", [`extra_hours_${b.id}`]: "1", [`extra_price_${b.id}`]: "100000", [`price_type_${b.id}`]: "fixed",
    "rate_name_99999": "유령", "base_price_99999": "1",
  });
  assert.equal(r.updated, 1, "참여+유효 행만 갱신");
  assert.equal(r.skipped, 1, "이름 비운 행은 건너뜀");
  const a2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(a.id);
  assert.equal(a2.name, "벌크A2");
  assert.equal(a2.base_minutes, 300, "5시간 → 300분");
  assert.equal(a2.base_price, 500000, "콤마 금액 파싱");
  assert.equal(a2.price_type, "base");
  const b2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(b.id);
  assert.equal(b2.name, "벌크B", "건너뛴 행은 원값 유지");
  const c2 = db().prepare("SELECT * FROM rate_items WHERE id=?").get(c.id);
  assert.equal(c2.name, "벌크C", "미참여(필드 없는) 행 불변");
  assert.equal(db().prepare("SELECT COUNT(*) c FROM rate_items WHERE name='유령'").get().c, 0, "임의 id 주입 무시(행 생성 없음)");
});

test("bulkUpdateRooms: 이름·상위·체크박스 갱신, 미전송 체크박스=해제(0)", () => {
  const top = D.createRoom({ room_name: "벌크상위", bookable: "1" });
  const r1 = D.createRoom({ room_name: "벌크룸1", bookable: "1", is_external: "1" });
  D.bulkUpdateRooms({
    [`room_name_${r1.id}`]: "벌크룸1-개명", [`parent_id_${r1.id}`]: String(top.id),
    // bookable·is_external 미전송 = 체크 해제
  });
  const after = db().prepare("SELECT * FROM rooms WHERE id=?").get(r1.id);
  assert.equal(after.name, "벌크룸1-개명");
  assert.equal(after.parent_id, top.id);
  assert.equal(after.bookable, 0, "미전송 체크박스 = 0 (상위 지정 시 강제 0 규칙과도 일치)");
  assert.equal(after.is_external, 0, "미전송 체크박스 = 0");
  assert.equal(db().prepare("SELECT name FROM rooms WHERE id=?").get(top.id).name, "벌크상위", "미참여 행 불변");
});

test("bulkUpdateTaskTypes: 갱신 + sort_order 보존(updateTaskType의 100 리셋 잠복 버그 방어)", () => {
  D.createTaskType({ label: "벌크작업1", billing_type: "Fixed_Per_Track", unit_price: "100000" });
  D.createTaskType({ label: "벌크작업2", billing_type: "Fixed_Per_Track", unit_price: "200000" });
  const t1 = db().prepare("SELECT * FROM task_types WHERE label='벌크작업1'").get();
  db().prepare("UPDATE task_types SET sort_order=770 WHERE id=?").run(t1.id); // 사용자가 ↑↓로 잡아둔 순서 가정
  D.bulkUpdateTaskTypes({
    [`label_${t1.id}`]: "벌크작업1-개명", [`billing_type_${t1.id}`]: "Fixed_Per_Track", [`unit_price_${t1.id}`]: "150,000", [`price_type_${t1.id}`]: "minimum",
    // is_quick 미전송 = 해제
  });
  const after = db().prepare("SELECT * FROM task_types WHERE id=?").get(t1.id);
  assert.equal(after.label, "벌크작업1-개명");
  assert.equal(after.unit_price, 150000);
  assert.equal(after.price_type, "minimum");
  assert.equal(after.is_quick, 0, "미전송 체크박스 = 0");
  assert.equal(after.sort_order, 770, "sort_order 보존 — 미전송 시 100 리셋되면 안 됨");
});
```

⚠️ `createRoom`·`createTaskType`·`createRateItem`의 실제 입력 키가 위와 다르면(구현 확인 후) 테스트의 **생성부만** 실제 계약에 맞춰 조정하라(단언 대상은 유지).

- [ ] **Step 2: 실패 확인**

Run: `node --test test/settings-bulk.test.js 2>&1 | tail -15`
Expected: FAIL — `bulkUpdateRateItems is not a function`.

- [ ] **Step 3: 구현** — 세 파일에 각각 추가(update 함수 바로 아래) + module.exports 등록:

`src/data/rate-items.js`:
```js
/**
 * 통합 저장(2026-07-27 인라인 편집): body의 `<필드>_<id>` 묶음을 행별로 모아 한 트랜잭션으로 갱신.
 * 행 판별은 DB 기준(rate_name_<id> 존재 시 참여) — 임의 id 주입은 자연 무시. 이름·가격 누락 행은
 * 그 행만 건너뛴다(단건 저장과 같은 의미론). 그 외 오류는 롤백 후 재던짐.
 */
function bulkUpdateRateItems(body = {}) {
  const d = db();
  const ids = d.prepare("SELECT id FROM rate_items").all().map((r) => r.id);
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of ids) {
      if (body[`rate_name_${id}`] == null) continue;
      const input = {
        rate_name: body[`rate_name_${id}`],
        category: body[`category_${id}`],
        base_hours: body[`base_hours_${id}`],
        base_price: body[`base_price_${id}`],
        extra_hours: body[`extra_hours_${id}`],
        extra_price: body[`extra_price_${id}`],
        price_type: body[`price_type_${id}`],
      };
      try { updateRateItem(id, input); updated++; }
      catch (e) { if (!["RATE_NAME_REQUIRED", "RATE_PRICE_REQUIRED"].includes(e.message)) throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
}
```

`src/data/rooms.js` (roomFields가 읽는 이름 키를 확인해 맞출 것):
```js
/** 통합 저장(2026-07-27 인라인 편집) — rate-items의 bulkUpdateRateItems와 같은 규약. */
function bulkUpdateRooms(body = {}) {
  const d = db();
  const ids = d.prepare("SELECT id FROM rooms").all().map((r) => r.id);
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const id of ids) {
      if (body[`room_name_${id}`] == null) continue;
      const input = {
        room_name: body[`room_name_${id}`],
        parent_id: body[`parent_id_${id}`],
        bookable: body[`bookable_${id}`],
        is_external: body[`is_external_${id}`],
      };
      try { if (updateRoom(id, input)) updated++; else skipped++; }
      catch (e) { if (e.message !== "ROOM_NAME_REQUIRED") throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
}
```

`src/data/task-types.js`:
```js
/** 통합 저장(2026-07-27 인라인 편집) — sort_order는 현재 값 명시 보존(updateTaskType이 미전송 시 100으로 리셋). */
function bulkUpdateTaskTypes(body = {}) {
  const d = db();
  const rows = d.prepare("SELECT id, sort_order FROM task_types").all();
  let updated = 0, skipped = 0;
  d.exec("BEGIN IMMEDIATE;");
  try {
    for (const r of rows) {
      if (body[`label_${r.id}`] == null) continue;
      const input = {
        label: body[`label_${r.id}`],
        billing_type: body[`billing_type_${r.id}`],
        unit_price: body[`unit_price_${r.id}`],
        price_type: body[`price_type_${r.id}`],
        is_quick: body[`is_quick_${r.id}`],
        sort_order: r.sort_order, // ⚠️ 미전송이면 taskTypeFields가 100으로 리셋 — 사용자 ↑↓ 순서 보존
      };
      try { updateTaskType(r.id, input); updated++; }
      catch (e) { if (e.message !== "TASK_TYPE_LABEL_REQUIRED") throw e; skipped++; }
    }
    d.exec("COMMIT;");
  } catch (e) { d.exec("ROLLBACK;"); throw e; }
  return { updated, skipped };
}
```

⚠️ 세 update 함수가 내부에서 자체 트랜잭션을 열지 않는 것을 확인했다(BEGIN 중첩 없음). `invalidateTaskTypeCache`는 트랜잭션 안 호출 무해(메모리 캐시).

참고(스펙 대비 수용 갭): 롤백 경로(예상 밖 오류)는 정상 입력으로 강제 트리거할 수 없어 테스트로 잠그지 않는다 — try/catch/ROLLBACK 코드가 리뷰 확인 대상.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/settings-bulk.test.js test/rooms.test.js test/rate-items.test.js 2>&1 | tail -8`
Expected: PASS (기존 rooms·rate-items 회귀 포함).

- [ ] **Step 5: 커밋**

```bash
git add src/data/rate-items.js src/data/rooms.js src/data/task-types.js test/settings-bulk.test.js
git commit -m "feat: 환경설정 통합 저장 데이터 계층 — bulkUpdate 3종(트랜잭션·행별 silent-skip·sort_order 보존)"
```

---

### Task 2: 라우트 — bulk 3개 + 행 액션 앵커 복귀

**Files:**
- Modify: `src/routes/settings.routes.js` (단가표 라우트 묶음 ~L360-394, 룸 ~L435-465, 작업 종류 ~L467-495)

**Interfaces:**
- Consumes: Task 1의 `bulkUpdateRateItems`/`bulkUpdateRooms`/`bulkUpdateTaskTypes`(라우트 상단 기존 data require에 추가).
- Produces: `POST /settings/rate-items/bulk`·`/settings/rooms/bulk`·`/settings/task-types/bulk`(모두 `requireStaff`). Task 3 뷰의 폼 action이 이 경로를 쓴다. 섹션 앵커 규약: 단가표=`#rates-section`(tab=content) · 작업 종류=`#task-types-section`(tab=content) · 룸=`#rooms-section`(tab=settings).

- [ ] **Step 1: bulk 라우트 3개 추가** — 각 섹션 라우트 묶음의 맨 앞(`/:id` param 라우트보다 위, literal 우선 매칭):

```js
// 통합 저장(2026-07-27 인라인 편집) — 섹션 전 행을 한 번에. 행별 검증·건너뜀은 데이터 계층(bulkUpdate*) 규약.
router.post("/rate-items/bulk", requireStaff, (req, res) => {
  bulkUpdateRateItems(req.body);
  res.redirect("/settings?tab=content&flash=saved#rates-section");
});
```

```js
router.post("/rooms/bulk", requireStaff, (req, res) => {
  bulkUpdateRooms(req.body);
  res.redirect("/settings?tab=settings&flash=saved#rooms-section");
});
```

```js
router.post("/task-types/bulk", requireStaff, (req, res) => {
  bulkUpdateTaskTypes(req.body);
  res.redirect("/settings?tab=content&flash=saved#task-types-section");
});
```

- [ ] **Step 2: 행 액션 리다이렉트에 앵커 부착** — 계속 쓰이는 액션 라우트만(단건 저장 `POST /rate-items/:id`·`/rooms/:id`·`/task-types/:id`는 뷰에서 안 쓰게 되지만 **라우트는 그대로 둔다**):
  - `/rate-items/:id/move`·`/active`·`/delete` → 기존 redirect 문자열 끝에 `#rates-section`
  - `/rooms/:id/move`·`/delete` → `#rooms-section`
  - `/task-types/:id/move`·`/delete` → `#task-types-section`

- [ ] **Step 3: 검증**

Run: `node --test test/settings-bulk.test.js test/smoke.test.js 2>&1 | tail -8`
Expected: PASS (스모크가 /settings 렌더·서버 기동 회귀 확인).

- [ ] **Step 4: 커밋**

```bash
git add src/routes/settings.routes.js
git commit -m "feat: 환경설정 통합 저장 라우트 3개 + 행 액션 섹션 앵커 복귀"
```

---

### Task 3: 뷰 재작성 + app.js MONEY + 뷰 계약 테스트

**Files:**
- Modify: `src/views.settings.js` — `rateItemRow`(~L615)·`ratesGroupedByCategory`(~L102)·`contentTab`(~L173)·`taskTypeRow`(~L667)·`roomRow`(~L361)·`roomsSection`(~L318)·module.exports(~L893)
- Modify: `public/js/app.js` — MONEY 정규식(~L1021)
- Test: `test/settings-views.test.js` (신규)

**Interfaces:**
- Consumes: Task 2의 bulk action 경로·앵커 id 규약, 기존 헬퍼(`rateCategoryOptions`·`priceTypeOptions`·`roomParentOptions`·`listRateCategories`·`emptyState`·`explain`·`esc`).
- Produces: 폼 필드명 `<기존 필드>_<id>` 규칙(Task 1 파싱과 일치), 섹션 앵커 id 3종, hidden 액션 폼 id 규칙 `rate-mv-u-<id>`/`rate-mv-d-<id>`/`rate-act-<id>`/`rate-del-<id>`/`room-mv-u-<id>`/`room-mv-d-<id>`/`room-del-<id>`/`tt-mv-u-<id>`/`tt-mv-d-<id>`/`tt-del-<id>`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/settings-views.test.js` 신규(임시 DB + 렌더 문자열 계약):

```js
"use strict";

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");

const { db, init } = require("../src/db");
const D = require("../src/data");

init();

const V = require("../src/views.settings");

test.after(() => cleanupDb(process.env.DB_PATH, db()));

// 폼 구간 추출: marker(id=...)부터 첫 </form>까지 — 그 사이에 <form이 또 있으면 중첩 폼(브라우저가 버림).
function formSegment(html, formId) {
  const i = html.indexOf(formId);
  assert.ok(i >= 0, `${formId} 렌더됨`);
  const j = html.indexOf("</form>", i);
  return html.slice(i, j);
}

test("단가표·작업 종류: 인라인 필드 + bulk 폼, 접이식 '수정' 제거, 액션은 form= 형제 폼(중첩 없음)", () => {
  const a = D.createRateItem({ rate_name: "뷰검사녹음", category: "스튜디오 녹음", base_hours: "3.5", base_price: "300000", extra_price: "100000" });
  D.createTaskType({ label: "뷰검사작업", billing_type: "Fixed_Per_Track", unit_price: "100000" });
  const t = db().prepare("SELECT * FROM task_types WHERE label='뷰검사작업'").get();
  const html = V.contentTab();

  assert.ok(html.includes('id="rates-section"'), "단가표 섹션 앵커");
  assert.ok(html.includes('id="task-types-section"'), "작업 종류 섹션 앵커");
  assert.ok(html.includes('action="/settings/rate-items/bulk"'), "단가표 bulk 폼");
  assert.ok(html.includes('action="/settings/task-types/bulk"'), "작업 종류 bulk 폼");
  assert.ok(html.includes(`name="rate_name_${a.id}"`) && html.includes(`name="base_price_${a.id}"`) && html.includes(`name="price_type_${a.id}"`), "단가표 행 = <필드>_<id> 인라인 입력");
  assert.ok(html.includes(`name="label_${t.id}"`) && html.includes(`name="unit_price_${t.id}"`), "작업 종류 행 인라인 입력");
  assert.ok(!html.includes(">수정 "), "접이식 '수정' 토글 제거");

  // 중첩 폼 금지: bulk 폼 구간 안에 다른 <form 없음
  assert.ok(!formSegment(html, 'id="rates-bulk-form"').slice(1).includes("<form"), "단가표 bulk 폼 안에 중첩 폼 없음");
  assert.ok(!formSegment(html, 'id="task-types-bulk-form"').slice(1).includes("<form"), "작업 종류 bulk 폼 안에 중첩 폼 없음");

  // 행 액션: 버튼 form= ↔ hidden 형제 폼 id 짝
  for (const fid of [`rate-mv-u-${a.id}`, `rate-mv-d-${a.id}`, `rate-act-${a.id}`, `rate-del-${a.id}`, `tt-mv-u-${t.id}`, `tt-del-${t.id}`]) {
    assert.ok(html.includes(`form="${fid}"`), `버튼이 ${fid} 참조`);
    assert.ok(html.includes(`id="${fid}"`), `hidden 폼 ${fid} 존재`);
  }
  assert.ok(formSegment(html, `id="rate-del-${a.id}"`).includes("data-confirm"), "삭제 확인 문구 유지");
  // 통합 저장 dirty 패턴
  assert.ok(formSegment(html, 'id="rates-bulk-form"').includes("data-dirty-save"), "통합 저장 버튼 dirty 패턴");
});

test("룸: 인라인 필드 + bulk 폼 + 계층 들여쓰기 유지, 중첩 폼 없음", () => {
  const top = D.createRoom({ room_name: "뷰검사스튜디오", bookable: "1" });
  const kid = D.createRoom({ room_name: "뷰검사부스", parent_id: String(top.id) });
  const html = V.roomsSection();

  assert.ok(html.includes('id="rooms-section"'), "룸 섹션 앵커");
  assert.ok(html.includes('action="/settings/rooms/bulk"'), "룸 bulk 폼");
  assert.ok(html.includes(`name="room_name_${top.id}"`) && html.includes(`name="parent_id_${kid.id}"`) && html.includes(`name="bookable_${top.id}"`), "룸 행 인라인 입력");
  assert.ok(!html.includes(">수정 "), "접이식 '수정' 토글 제거");
  assert.ok(!formSegment(html, 'id="rooms-bulk-form"').slice(1).includes("<form"), "룸 bulk 폼 안에 중첩 폼 없음");
  for (const fid of [`room-mv-u-${top.id}`, `room-del-${kid.id}`]) {
    assert.ok(html.includes(`form="${fid}"`) && html.includes(`id="${fid}"`), `액션 폼 짝 ${fid}`);
  }
});
```

⚠️ `contentTab`·`roomsSection`이 module.exports에 없으면 추가(내부 전용 목록 주석도 갱신). `createRoom`·`createRateItem`·`createTaskType` 입력 키는 Task 1에서 확인한 실제 계약으로.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/settings-views.test.js 2>&1 | tail -15`
Expected: FAIL (bulk 폼·인라인 필드 미구현).

- [ ] **Step 3: 뷰 구현** — 아래 구조로 재작성(기존 함수 대체). 원칙: 요약 줄·배지·`<details>` 제거, 삭제 confirm 문구는 기존 그대로, 비활성 행 `opacity-60` 유지, Tailwind 그리드는 **리터럴 클래스**.

(a) `rateItemRow(r)` 대체 — 행 그리드 + 액션 버튼(form= 참조), 그리고 **형제 hidden 액션 폼은 별도 함수** `rateItemActionForms(r)`:

```js
/** 단가표 행 = 한 줄 인라인 편집 필드(2026-07-27 통합 저장). 액션 버튼은 form=으로 형제 hidden 폼 참조(중첩 폼 금지). */
function rateItemRow(r) {
  const baseHours = r.base_minutes ? r.base_minutes / 60 : "";
  const extraHours = r.extra_minutes ? r.extra_minutes / 60 : 1;
  const cat = r.category || RECORDING_CATEGORIES[0];
  return `
    <div class="grid grid-cols-2 items-center gap-1.5 rounded-lg bg-bg p-2 sm:grid-cols-[minmax(0,1.3fr)_7.5rem_4rem_6rem_4rem_6rem_5.5rem_auto] ${r.active ? "" : "opacity-60"}" id="rate-item-${r.id}">
      <input class="input py-1.5 text-sm col-span-2 sm:col-span-1" name="rate_name_${r.id}" value="${esc(r.name)}" aria-label="단가 항목명" autocomplete="off" required />
      <select class="input py-1.5 text-sm" name="category_${r.id}" aria-label="분류">${rateCategoryOptions(cat)}</select>
      <input class="input py-1.5 text-sm" name="base_hours_${r.id}" inputmode="decimal" value="${esc(String(baseHours))}" aria-label="기준 시간(시간)" placeholder="기준(h)" />
      <input class="input py-1.5 text-sm" name="base_price_${r.id}" inputmode="numeric" value="${esc(String(r.base_price || ""))}" aria-label="기준 가격(원)" placeholder="기준가(원)" />
      <input class="input py-1.5 text-sm" name="extra_hours_${r.id}" inputmode="decimal" value="${esc(String(extraHours))}" aria-label="초과 단위(시간)" placeholder="초과(h)" />
      <input class="input py-1.5 text-sm" name="extra_price_${r.id}" inputmode="numeric" value="${esc(String(r.extra_price || ""))}" aria-label="초과 단가(원)" placeholder="초과가(원)" />
      <select class="input py-1.5 text-sm" name="price_type_${r.id}" aria-label="가격 유형">${priceTypeOptions(r.price_type)}</select>
      <span class="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
        ${r.active ? "" : '<span class="text-xs text-muted">(비활성)</span>'}
        <button class="btn-ghost btn-xs px-2" type="submit" form="rate-mv-u-${r.id}" aria-label="위로 이동">↑</button>
        <button class="btn-ghost btn-xs px-2" type="submit" form="rate-mv-d-${r.id}" aria-label="아래로 이동">↓</button>
        <button class="btn-ghost btn-xs whitespace-nowrap" type="submit" form="rate-act-${r.id}">${r.active ? "비활성" : "활성"}</button>
        <button class="btn-ghost btn-xs text-danger" type="submit" form="rate-del-${r.id}">삭제</button>
      </span>
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
```

(b) `ratesGroupedByCategory(rates)` 대체 — 접이식 제거, `{list, actionForms}` 반환(분류 헤더 줄 + 행 나열):

```js
/** 단가표를 분류별로 묶어 **항상 펼침**(2026-07-27 인라인 편집 — 옛 접이식 폐기). {list, actionForms} 반환. */
function ratesGroupedByCategory(rates) {
  if (!rates.length) return { list: emptyState("등록된 단가 항목이 없습니다."), actionForms: "" };
  const order = listRateCategories().map((c) => c.name);
  const groups = {};
  rates.forEach((r) => { const c = r.category || order[0] || ""; (groups[c] = groups[c] || []).push(r); });
  const orderedCats = [...order.filter((c) => groups[c]), ...Object.keys(groups).filter((c) => !order.includes(c))];
  const list = orderedCats
    .map((c) => {
      const items = groups[c];
      const activeN = items.filter((r) => r.active).length;
      const countLabel = activeN !== items.length ? `${items.length}개 · 활성 ${activeN}` : `${items.length}개`;
      return `
        <div class="rounded-lg border border-border">
          <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm font-medium">
            <span>${esc(c)}</span><span class="text-xs font-normal text-muted">${esc(countLabel)}</span>
          </div>
          <div class="space-y-1.5 p-2">${items.map((r) => rateItemRow(r)).join("")}</div>
        </div>`;
    })
    .join("");
  const actionForms = rates.map((r) => rateItemActionForms(r)).join("");
  return { list, actionForms };
}
```

(c) `contentTab()` 수정 — 단가표 섹션: `<section class="card space-y-4" id="rates-section">`으로 앵커 부여, 추가 폼(기존 유지) 아래의 `<div class="space-y-2">${ratesGroupedByCategory(rates)}</div>`를 다음으로 교체:

```js
        ${(() => {
          const g = ratesGroupedByCategory(rates);
          if (!g.actionForms) return g.list; // 빈 상태
          return `
        <form method="post" action="/settings/rate-items/bulk" id="rates-bulk-form" class="space-y-2" data-dirty-form>
          <div class="hidden gap-1.5 px-2 text-xs text-muted sm:grid sm:grid-cols-[minmax(0,1.3fr)_7.5rem_4rem_6rem_4rem_6rem_5.5rem_auto]"><span>이름</span><span>분류</span><span>기준(h)</span><span>기준가(원)</span><span>초과(h)</span><span>초과가(원)</span><span>유형</span><span></span></div>
          ${g.list}
          <div class="flex items-center gap-2"><button class="btn-primary btn-sm transition" type="submit" data-dirty-save>통합 저장</button><span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span></div>
        </form>
        ${g.actionForms}`;
        })()}
```

작업 종류 섹션도 동일 구조: `<section class="card space-y-4" id="task-types-section">` + `taskTypeRows`를 bulk 폼(`id="task-types-bulk-form"`, action `/settings/task-types/bulk`, 열 제목 `이름·과금·기본 단가(원)·유형·빠른추가·(빈칸)`, 그리드 `sm:grid-cols-[minmax(0,1.4fr)_8rem_6.5rem_6rem_auto_auto]`) + 액션 폼으로 교체. 단가표 설명(`explain`)의 "잠시 안 쓰는 항목은 삭제 대신 비활성" 문구는 유지하되 '↑↓로 …' 문장은 그대로 둔다(동작 불변).

(d) `taskTypeRow(t)` 대체 + `taskTypeActionForms(t)` 신설 — 단가표와 같은 패턴:

```js
/** 작업 종류 행 = 한 줄 인라인 편집(2026-07-27 통합 저장). */
function taskTypeRow(t) {
  return `
    <div class="grid grid-cols-2 items-center gap-1.5 rounded-lg bg-bg p-2 sm:grid-cols-[minmax(0,1.4fr)_8rem_6.5rem_6rem_auto_auto] ${t.active ? "" : "opacity-60"}" id="task-type-${t.id}">
      <input class="input py-1.5 text-sm col-span-2 sm:col-span-1" name="label_${t.id}" value="${esc(t.label)}" aria-label="작업 종류명" required />
      <select class="input py-1.5 text-sm" name="billing_type_${t.id}" aria-label="과금">
        ${BILLING_TYPES.map((b) => `<option value="${esc(b)}" ${b === t.billing_type ? "selected" : ""}>${esc(BILLING_TYPE_LABELS[b] || b)}</option>`).join("")}
      </select>
      <input class="input py-1.5 text-sm" name="unit_price_${t.id}" inputmode="numeric" value="${esc(String(t.unit_price || ""))}" aria-label="기본 단가(원)" placeholder="기본 단가(원)" />
      <select class="input py-1.5 text-sm" name="price_type_${t.id}" aria-label="가격 유형">${priceTypeOptions(t.price_type)}</select>
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm text-muted"><input type="checkbox" name="is_quick_${t.id}" value="1" ${t.is_quick ? "checked" : ""} /> 빠른추가</label>
      <span class="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
        <button class="btn-ghost btn-xs px-2" type="submit" form="tt-mv-u-${t.id}" aria-label="위로 이동">↑</button>
        <button class="btn-ghost btn-xs px-2" type="submit" form="tt-mv-d-${t.id}" aria-label="아래로 이동">↓</button>
        <button class="btn-ghost btn-xs text-danger" type="submit" form="tt-del-${t.id}">삭제</button>
      </span>
    </div>`;
}

function taskTypeActionForms(t) {
  return `
    <form id="tt-mv-u-${t.id}" method="post" action="/settings/task-types/${t.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="tt-mv-d-${t.id}" method="post" action="/settings/task-types/${t.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="tt-del-${t.id}" method="post" action="/settings/task-types/${t.id}/delete" hidden data-confirm="'${esc(t.label)}' 작업 종류를 삭제할까요? 이 종류로 만든 기존 작업은 유지되지만 종류명이 코드값으로 표시됩니다."></form>`;
}
```

(e) `roomRow(r, depth, tops)` 대체 + `roomActionForms(r)` 신설, `roomsSection()` 수정 — 룸은 flex 한 줄(필드 자체 라벨로 충분해 열 제목 생략), 계층 들여쓰기·`└` 유지, 섹션 컨테이너에 `id="rooms-section"`:

```js
/** 룸 행 = 한 줄 인라인 편집(2026-07-27 통합 저장). 계층 들여쓰기 유지, 배지는 필드가 보이므로 제거. */
function roomRow(r, depth = 0, tops = []) {
  return `
    <div class="flex flex-wrap items-center gap-2 rounded-lg bg-bg p-2 ${depth ? "ml-4 sm:ml-6" : ""}" id="room-${r.id}">
      ${depth ? `<span class="shrink-0 text-muted" aria-hidden="true">└</span>` : ""}
      <input class="input min-w-36 flex-1 py-1.5 text-sm" name="room_name_${r.id}" value="${esc(r.name)}" aria-label="장소 이름" autocomplete="off" required />
      <select class="input py-1.5 text-sm" name="parent_id_${r.id}" aria-label="상위 룸">${roomParentOptions(tops, r.parent_id, r.id)}</select>
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm"><input type="checkbox" name="bookable_${r.id}" value="1" ${r.bookable ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary" /> 예약 대상</label>
      <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm"><input type="checkbox" name="is_external_${r.id}" value="1" ${r.is_external ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary" /> 외부</label>
      <span class="ml-auto flex items-center gap-1">
        <button class="btn-ghost btn-xs px-2" type="submit" form="room-mv-u-${r.id}" aria-label="위로 이동">↑</button>
        <button class="btn-ghost btn-xs px-2" type="submit" form="room-mv-d-${r.id}" aria-label="아래로 이동">↓</button>
        <button class="btn-ghost btn-xs text-danger" type="submit" form="room-del-${r.id}">삭제</button>
      </span>
    </div>`;
}

function roomActionForms(r) {
  return `
    <form id="room-mv-u-${r.id}" method="post" action="/settings/rooms/${r.id}/move" hidden><input type="hidden" name="dir" value="up" /></form>
    <form id="room-mv-d-${r.id}" method="post" action="/settings/rooms/${r.id}/move" hidden><input type="hidden" name="dir" value="down" /></form>
    <form id="room-del-${r.id}" method="post" action="/settings/rooms/${r.id}/delete" hidden data-confirm="'${esc(r.name)}' 장소를 삭제할까요? 이 장소로 예약된 세션은 '장소 미지정'으로 바뀝니다. 이름만 고치려면 이름 칸을 고쳐 통합 저장하세요."></form>`;
}
```

`roomsSection()`의 `<div class="space-y-2">${rows}</div>`를 다음으로 교체(+ 바깥 `<div class="${SETTING_BLOCK}">`에 `id="rooms-section"` 부여):

```js
      ${ordered.length ? `
      <form method="post" action="/settings/rooms/bulk" id="rooms-bulk-form" class="space-y-1.5" data-dirty-form>
        ${rows}
        <div class="flex items-center gap-2"><button class="btn-primary btn-sm transition" type="submit" data-dirty-save>통합 저장</button><span class="text-xs text-warning" data-dirty-hint hidden>저장되지 않은 변경사항</span></div>
      </form>
      ${ordered.map((o) => roomActionForms(o.room)).join("")}` : rows}
```

(f) module.exports에 `contentTab`·`roomsSection` 추가(테스트용 — 이미 있으면 생략), 내부 전용 주석 목록 갱신. 옛 `rateItemRow` 요약용 `hourLabel`이 고아가 되면 **소비처를 확인**하고 남는 소비처가 없을 때만 제거(있으면 유지).

- [ ] **Step 4: app.js MONEY 정규식 확장** — `public/js/app.js` ~L1021:

```js
  var MONEY = /^(unit_price|base_price|extra_price|amount|paid_amount|discount_amount|worker_rate|engineer_rates|purchase_price|task_amount_\d+|session_amount_\d+|unit_price_\d+|base_price_\d+|extra_price_\d+)$/;
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/settings-views.test.js test/guardrails.test.js test/guardrails-ui.test.js test/ui-interactions.test.js 2>&1 | tail -8`
Expected: PASS (가드 ⑫ 금액칸↔MONEY 계약·CSP·마커 계약 포함). 이어서 `npm test 2>&1 | tail -5` 전체 PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/views.settings.js public/js/app.js test/settings-views.test.js
git commit -m "feat: 환경설정 단가표·룸·작업 종류 인라인 편집 + 통합 저장 UI(접이식 폐기·form= 액션 폼)"
```

---

### Task 4: 전체 검증 + CLAUDE.md 현행화

**Files:**
- Modify: `CLAUDE.md` (환경설정 섹션·함정/관례 해당 항목)

- [ ] **Step 1: 전체 테스트**

Run: `npm test 2>&1 | tail -5`
Expected: 전부 PASS.

- [ ] **Step 2: 로컬 실서버 확인** — `pkill -f "src/server.js"`(함정 #5) 후 임시 DB(`DB_PATH=$(mktemp -d)/check.db DEV_LOGIN=1 PORT=3458 node src/server.js` 백그라운드) → `/dev-login` 쿠키 → `/settings?tab=content`·`/settings?tab=settings` HTML에서: ①`rates-bulk-form`·`rooms-bulk-form`·`task-types-bulk-form` 렌더 ②`<details` 가 단가표·룸·작업종류 행 영역에 없음 ③bulk POST(`rate_name_<id>` 등 urlencoded)로 실제 저장 → DB 값 변경 + 302 Location에 `#rates-section` 확인. 종료·정리.

참고: 반응형(390px 가로 오버플로우 0) 실측은 브라우저가 필요해 이 태스크 범위 밖 — 컨트롤러(메인 세션)가 Chrome 자동화로 확인하거나 사용자 육안 확인으로 마무리한다.

- [ ] **Step 3: CLAUDE.md 현행화** — Read→Edit(수술적):
  - 환경설정 섹션(콘텐츠·정렬 UI 서술부): 단가표·룸·작업 종류 = **인라인 한 줄 편집 + 섹션 통합 저장**(`POST /settings/*/bulk`, 필드 `<이름>_<id>`, 행별 검증은 silent-skip, 행 액션은 `form=` 형제 폼·섹션 앵커 복귀, 접이식 '수정'·분류 접이식 폐기 — 2026-07-27). ⚠️ `updateTaskType`의 sort_order 100 리셋 잠복 버그와 bulk의 명시 보존도 한 줄.
  - 미저장 상태에서 행 액션 시 변경 유실 트레이드오프(사용자 수용) 명시.

- [ ] **Step 4: 커밋 + push**

```bash
git add CLAUDE.md
git commit -m "docs: 환경설정 인라인 편집·통합 저장 현행화(bulk 계약·sort_order 보존·트레이드오프)"
git push -u origin <현재 브랜치>
```

(배포는 하지 않는다 — 사용자가 시점 결정.)
