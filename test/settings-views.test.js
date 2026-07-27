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
