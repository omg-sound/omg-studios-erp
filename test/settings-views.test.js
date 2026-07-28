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
  // 2026-07-28 화면 분리 — 요금표(ratesPane)·작업 종류(taskTypesPane)는 이제 별도 화면.
  const html = V.ratesPane() + V.taskTypesPane();

  assert.ok(html.includes('id="rates-section"'), "단가표 섹션 앵커");
  assert.ok(html.includes('id="task-types-section"'), "작업 종류 섹션 앵커");
  // 2026-07-29 트리 전환 — 요금표는 분류 행과 항목 행을 **한 폼**(/settings/rates/bulk)에서 함께 저장한다.
  assert.ok(html.includes('action="/settings/rates/bulk"'), "요금표 트리 통합 저장 폼");
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

test("룸: 인라인 필드 + bulk 폼, 계층 UI 없음, 중첩 폼 없음", () => {
  const a = D.createRoom({ room_name: "뷰검사스튜디오", bookable: "1" });
  const b = D.createRoom({ room_name: "뷰검사부스" });
  const html = V.roomsSection();

  assert.ok(html.includes('id="rooms-section"'), "룸 섹션 앵커");
  assert.ok(html.includes('action="/settings/rooms/bulk"'), "룸 bulk 폼");
  assert.ok(html.includes(`name="room_name_${a.id}"`) && html.includes(`name="bookable_${a.id}"`) && html.includes(`name="is_external_${b.id}"`), "룸 행 인라인 입력");
  assert.ok(!html.includes(">수정 "), "접이식 '수정' 토글 제거");
  // 계층 폐지(2026-07-28) — 상위 룸 select·들여쓰기 마커가 남아 있으면 안 된다.
  assert.ok(!html.includes("parent_id"), "상위 룸 select 없음");
  assert.ok(!html.includes("상위 없음"), "상위 룸 옵션 문구 없음");
  assert.ok(!formSegment(html, 'id="rooms-bulk-form"').slice(1).includes("<form"), "룸 bulk 폼 안에 중첩 폼 없음");
  for (const fid of [`room-mv-u-${a.id}`, `room-del-${b.id}`]) {
    assert.ok(html.includes(`form="${fid}"`) && html.includes(`id="${fid}"`), `액션 폼 짝 ${fid}`);
  }
});

// ⚠️ 이 파일의 마지막 테스트여야 한다 — 위 두 테스트가 만든 행(+기본 시드)을 전부 지워 진짜 0건 상태를
// 재현하므로, 뒤에 행을 전제하는 테스트가 오면 깨진다. 파일 정리 후 temp DB 자체가 버려지므로 복구는 불필요.
test("빈 목록: 단가표·작업 종류·룸이 0건이어도 예외 없이 렌더 + bulk 폼 대신 빈 안내", () => {
  db().exec("DELETE FROM rate_items; DELETE FROM rooms;");
  // task_types는 모듈 캐시가 있어 raw DELETE로는 캐시가 무효화되지 않는다 — D.deleteTaskType로 지워야
  // invalidateTaskTypeCache가 함께 호출돼 listTaskTypes가 실제로 빈 목록을 본다.
  for (const t of D.listTaskTypes({ includeInactive: true })) D.deleteTaskType(t.id);

  // 항목만 0인 상태 — 분류는 남아 있으므로 트리는 그려지고 각 분류가 '항목 없음'을 보여준다.
  assert.ok(V.ratesPane().includes("항목 없음"), "항목 0인 분류는 '항목 없음'");

  db().exec("DELETE FROM rate_categories;");
  const contentHtml = V.ratesPane() + V.taskTypesPane();
  // 트리 전환 후 요금표의 '비었다'는 **분류가 하나도 없을 때**다(항목은 분류 아래에 붙는다).
  assert.ok(contentHtml.includes("등록된 분류가 없습니다."), "요금표 빈 안내(emptyState)");
  assert.ok(contentHtml.includes("등록된 작업 종류가 없습니다."), "작업 종류 빈 안내(emptyState)");
  // 분류가 0개여도 트리 폼 자체는 남는다(빈 안내를 그 안에 그린다) — 분류 추가 폼으로 곧장 이어지게.
  assert.ok(!contentHtml.includes('id="task-types-bulk-form"'), "작업 종류 bulk 폼은 행이 있을 때만 렌더");

  const roomsHtml = V.roomsSection();
  assert.ok(roomsHtml.includes("등록된 룸이 없습니다."), "룸 빈 안내(emptyState)");
  assert.ok(!roomsHtml.includes('id="rooms-bulk-form"'), "룸 bulk 폼은 행이 있을 때만 렌더");
});
