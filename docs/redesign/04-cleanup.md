# 개편 4단계 — 정리 (설계)

> 2026-10-13 작성. 전체 방향·확정 결정은 메모리 `erp-redesign-2026-10`.
> 개편 단계: 1 빠른 생성(배포) → 2 곡 계층 제거(배포) → 3 청구 대기함(배포) → **4 정리**.

## 1. 목표

3단계까지 "읽지 않게" 만든 것을 **실제로 지운다**. 화면 동작은 거의 바뀌지 않는다(§5의 작은 변화뿐).

- 단가표·촬영 구간·곡 테이블과 그것을 다루던 코드·설정 화면·라우트를 없앤다.
- 쓰지 않는 컬럼을 없앤다.
- 테스트 시드를 지금 구조(작업이 프로젝트에 바로 붙음)로 바꾼다.
- CLAUDE.md·DATA-MODEL.md·SCREENS.md에서 폐지된 규칙 서술을 걷어낸다(CLAUDE.md는 240k자로 매 세션 로드 비용이 크다).

## 2. 지울 것

### 2-1. 테이블

| 테이블 | 지금 상태 | 비고 |
|---|---|---|
| `rate_items` | 설정 '요금표' 메뉴는 숨겼지만 **POST 라우트·뷰 함수가 살아 있고**, 세션 화면·캘린더 라벨이 아직 읽는다 | |
| `rate_categories` | 세션 종류 드롭다운 **순서**를 아직 여기서 정한다(`orderedSessionTypes`) | §5-2 |
| `session_segments` | 입력은 없앴지만 세션 상세·캘린더 설명이 아직 읽는다 | 3단계 실측 사용 0건 |
| `project_tracks` | 앱은 읽지 않음. **테스트 13개 파일이 시드로 쓴다**(66곳) | |
| `surcharges` | 이미 삭제됨(`surcharges_drop_v1`) — 생성문만 정리 | |

### 2-2. 컬럼

| 컬럼 | 처리 | 이유 |
|---|---|---|
| `sessions.rate_item_id` | **삭제 필수** | 아래 ⚠️ |
| `sessions.surcharge_key`·`surcharge_memo` | 삭제 | 2026-07-27 할증 폐지 후 읽는 코드 0 |
| `sessions.billing_memo`·`track_tasks.billing_memo` | 삭제(값은 메모로 옮김 — §6-3) | 3단계 이후 읽는 코드 0 |
| `task_types.unit_price`·`billing_type`·`price_type` | 삭제 | 기본 단가 폐지(3단계 결정 1) |
| `sessions.director_contact_id` | **삭제 + 재생성 막기** | §3 발견한 결함 |
| `track_tasks.billing_type`·`quantity`·`unit_price` | **유지** | 청구 발행이 지금도 쓴다(`createInvoice`가 `unit_price` 기록). 값이 늘 상수라도 손댈 이득이 없다 |

⚠️ **`rate_item_id`를 남긴 채 `rate_items`만 지우면 세션을 만들거나 지울 수 없게 된다.** 이 컬럼이 `REFERENCES rate_items(id)`라서, 부모 테이블이 없으면 SQLite가 INSERT·DELETE 때 `no such table`로 실패한다(로컬에서 실험으로 확인 — UPDATE는 통과해서 눈치채기 어렵다). 그래서 컬럼 삭제가 테이블 삭제보다 먼저다. SQLite 3.53(better-sqlite3 12)은 외래키가 걸린 컬럼도 `ALTER TABLE … DROP COLUMN`으로 바로 지운다(재구성 불필요, 실험으로 확인). 삭제 대상 컬럼에 인덱스는 없다.

### 2-3. 코드

| 곳 | 지울 것 |
|---|---|
| `src/data/rate-items.js`·`rate-categories.js` | 파일 통째(352줄) + `data.js` 재노출 |
| `src/routes/settings.routes.js` | `/settings/rate-items*`·`/rate-categories*`·`/rates/bulk` POST 9개, `TABLE_SCREENS`의 `rates` |
| `src/views.settings.js` | `ratesPane`·`ratesTree`·`rateCategoryRow`·`rateItemRow`·액션 폼들, 작업 종류 행의 **'과금' 선택 칸**(§5-3) |
| `src/data/sessions.js` | `rate_item_id` 입력 처리, 촬영 구간 함수(`listSessionSegments`·저장·분 계산), `sessionRateAmount`의 단가표 분기(확정액만 남김) |
| `src/views.sessions.js` | `rateOptionsHtml`·빈 `rateField`, `orderedSessionTypes`(→ config 순서), 세션 상세의 구간 줄 |
| `src/routes/sessions.routes.js` | 캘린더 라벨의 `getRateItem`(§5-1), 설명의 구간 줄 |
| `src/routes/new.routes.js`·`projects.routes.js`·`sessions.routes.js` | 폼에 넘기던 `listRateItems()` |
| `src/data/task-types.js`(작업 종류) | `unit_price`·`billing_type` 읽기·쓰기, `taskTypeUnitPrice` |
| `src/config.js` | `SESSION_TYPE_RATE_KIND`·`SESSION_SEGMENT_KINDS/LABELS`·`RECORDING/FILMING/PERFORMANCE_CATEGORIES`·`RATE_KIND_LABELS` |
| `src/seed.js` | 단가표 시드 |
| `public/js/app.js` | `rateSel`·`baseMinutes`(늘 0 — 1Pro 기준은 이미 `proDefaultMinutes`), 촬영 구간 처리(`segSpanMin` 등), `data-rec-types` 분기, 금액 정규식의 `base_price|extra_price` |
| `src/lib/date.js` | `computeCharge` 언급 주석 |

## 3. 발견한 결함 — 지운 컬럼이 기동마다 되살아난다

`db.js`의 `addColumn`은 "없으면 추가"를 **기동할 때마다** 실행한다. 2026-07 정체성 정리(`legacy_drop_v1`)가 `sessions.director_contact_id`를 DROP했지만 `addColumn("sessions", "director_contact_id", …)`가 남아 있어서, **운영 DB에서는 그 컬럼이 다음 기동 때 빈 채로 다시 생겼다**(코드 흐름상 확실하고, 리허설에서 운영 스키마로 확인한다 — DATA-MODEL.md가 '레거시 컬럼'으로 적고 있는 게 그것). 해는 없었지만, 이번에 같은 실수를 하면 결과가 다르다 — `rate_item_id`가 `REFERENCES rate_items`로 되살아나면 **세션 생성이 깨진다**(§2-2 ⚠️).

→ 지우는 것의 `CREATE TABLE`·`addColumn`·`CREATE INDEX`를 **전부 함께 지우고**, 회귀 테스트로 잠근다(§7 가드 ①).

## 4. 마이그레이션 방식

`db.js` `init()`은 **새 DB도 운영과 같은 경로**로 만든다: 옛 구조를 만들고 → 이행 46개를 차례로 돌리고 → 맨 끝에서 평탄화(2단계). 테스트가 매번 새 DB를 만들어 이 경로를 검증한다.

### 추천 — 선례 방식(`legacy_drop_v1`과 같다)

1. 지우는 것의 생성문(`CREATE TABLE`·`addColumn`·인덱스)을 없앤다.
2. **새 DB의 `track_tasks`는 처음부터 최종 모양**(`project_id`·`song_title`·`song_artist`, `track_id` 없음)으로 만든다.
3. 지운 것만 다루던 옛 이행을 삭제한다 — 운영에서 전부 `done`이라 다시 돌 일이 없다:
   `rate_categories_seed_v1`·`rate_categories_flat_order_v1`·`surcharges_drop_v1`·`tasks_flatten_v1`(평탄화 본체)·`backfillLegacyServicesToTracks`(`legacy_backfill_v1`의 곡 부분), `pricing_rooms_v2`·`task_types_seed_v1`의 단가 부분(룸 이름·작업 종류 시드 부분은 남긴다).
   그 밖의 `track_id`를 쓰는 SQL이 남아 있으면 같은 기준으로 정리한다(새 DB에선 테이블이 없어 prepare 단계에서 실패하므로, 빠뜨리면 테스트가 바로 잡는다).
4. `init()` 맨 끝에 **`redesign_cleanup_v1`** 하나: 외래키를 끄고 한 트랜잭션에서
   ① 메모 이관(§6-3) ② 컬럼 DROP(§2-2) ③ 테이블 DROP(§2-1) ④ **전후 비교** — 세션·작업·청구서·청구 라인 수, 라인↔세션·작업 연결 수, 금액 합계, `foreign_key_check`. 하나라도 어긋나면 롤백하고 **기동 중단**(2단계 평탄화와 같은 안전장치).
   새 DB에선 지울 게 없으므로 그냥 `done`만 기록한다.
5. 옛 운영 DB(이 이행들을 거치지 않은 백업)를 새 코드로 열 일은 없다(운영 DB는 하나이고 모든 게이트가 `done`). 그래도 열면 실패해야 하므로, 새 코드는 **`tasks_flatten_v1`이 `done`이 아닌 기존 DB를 만나면 기동을 거부**하고 "옛 버전으로 먼저 이행하라"고 로그를 남긴다.

### 대안 — 기준선(baseline)으로 다시 쓰기(추천 안 함)

옛 이행 46개를 전부 지우고 새 DB를 최종 스키마로 바로 만든다. `db.js`(1640줄)가 크게 줄지만, **개편과 무관한 이행(당사자 모델·연락처 등)까지 손대는** 큰 변경이다. 이번 단계 범위를 넘으므로 하지 않는다. 필요하면 나중에 별도로.

## 5. 화면에서 달라지는 것

1. **캘린더 일정 설명의 녹음 종류**: `녹음 · 보컬녹음` → `녹음 세션`(다른 종류는 지금도 `{종류} 세션`). 제목은 그대로(아티스트·제작사). 이미 만들어진 일정은 그 세션을 다시 저장할 때만 바뀐다.
2. **세션 종류 드롭다운 순서**: 요금표 분류 순서 대신 `config.SESSION_TYPES` 순서로 고정. 리허설 때 운영의 현재 순서를 확인하고, 다르면 config를 **운영 순서로** 맞춰 보이는 순서가 바뀌지 않게 한다.
3. **환경설정 > 작업 종류의 '과금' 선택 칸 삭제**: 후반작업은 전부 곡 단위 고정이라 고를 일이 없었다(남은 칸은 이름·빠른추가·순서·삭제).
4. **옛 주소 `/settings?s=rates`** → `?s=rooms`로 302.

그 밖의 화면·청구·매출·외주 정산 숫자는 바뀌지 않아야 한다(§8에서 검증).

## 6. 확정할 것

1. **마이그레이션 방식** = §4 추천(선례 방식). 기준선 재작성은 하지 않는다.
2. **운영 단가표 기록**: 테이블을 지우면 단가표는 백업에만 남고, 백업은 **14일 뒤 순환 삭제**된다. → 리허설 때 운영 단가표(분류·항목·기본가·초과 단가)를 **`docs/redesign/rate-items-2026-10.md` 한 장**으로 남길 것을 추천(청구 금액을 직접 쓸 때 참고용). 홈페이지 공개 가격표와는 별개이고 동기화하지 않는다.
3. **`billing_memo`(금액 조정 사유)에 값이 있는 세션·작업**: 버리지 않고 세션 메모(작업은 프로젝트 메모) 끝에 `금액 조정 사유: …`로 옮긴다(2단계 '빈 곡 → 프로젝트 메모'와 같은 원칙). 촬영 구간이 실제로 있는 세션이 있으면 같은 방식으로 `촬영 구간: 반입 09:00–10:00 · …`을 옮긴다(3단계 실측 0건 — 리허설에서 재확인).
4. **세션의 녹음 종류(`rate_item_id`) 기록은 옮기지 않는다**: 청구된 세션은 청구 라인이 그 이름을 이미 담고 있고, 미청구 세션에는 의미가 없다.
5. **`director_contact_id` 결함(§3)도 이번에 함께 고친다.**

## 7. 테스트

- **삭제**: 단가표·구간·요금 산정 전용 테스트 7개 — `rate-items`·`rate-categories`·`rate-price`·`charge-lines`·`pricing-rooms-migration`·`session-type-order`(순서는 config 고정으로 대체), `session-amount`(확정액 부분만 남기고 정리).
- **수정**: 단가표·구간을 언급하는 16개 파일, `project_tracks` 시드를 쓰는 13개 파일 → `INSERT INTO track_tasks (project_id, …)`로.
- `flatten-tasks.test.js`: 평탄화 이행 검증은 이행과 함께 사라진다. 지금 구조의 계약(곡명 묶음·정렬·이름 바꾸기)은 남긴다.
- **새 가드**
  ① **지운 것이 되살아나지 않는다**: `init()`을 두 번 돌린 뒤 §2의 테이블·컬럼이 하나도 없는지(§3 결함 재발 방지).
  ② **세션 생성·삭제가 된다**(§2-2 ⚠️의 직접 회귀).
  ③ **소스 문자열 가드**: `src/`·`public/js/`에 `rate_items`·`rate_categories`·`session_segments`·`project_tracks`·`rate_item_id`가 없을 것(`db.js`의 정리 이행 함수만 예외) — 기존 가드레일과 같은 방식.
  ④ `redesign_cleanup_v1` 단위 테스트: 옛 모양 테이블에 행을 넣고 → 이행 → 메모 이관·전후 수 일치·외래키 무결.

## 8. 진행 순서

각 단계 끝에서 `npm test` 전량 통과, 단계마다 커밋.

1. **코드에서 참조 제거** — 테이블은 아직 있다. 화면·라우트·data·app.js·config(§2-3, §5).
2. **테스트 시드 전환** — `project_tracks` → `track_tasks` 직접.
3. **db.js** — 생성문 제거·새 DB 최종 모양·옛 이행 정리·`redesign_cleanup_v1`·기동 거부 가드 + 새 가드 테스트(§4, §7).
4. **문서** — CLAUDE.md(단가표·촬영 구간·1프로 산정·요금 근거 라인 서술을 걷어내고 '🚧 개편 진행 중' 절을 현행 서술로 정리), DATA-MODEL.md, SCREENS.md.
5. **운영 백업 리허설**(사용자 승인 후 백업을 받아서)
   - 사전 실측: `rate_item_id` 연결 세션 수, 구간 있는 세션 수, `billing_memo` 값 있는 행 수, `project_tracks` 행 수, 운영 세션 종류 순서, 단가표 전체(§6-2 문서용).
   - 새 코드로 기동 → `redesign_cleanup_v1` 통과, 지운 것이 없는지, 한 번 더 기동해도 그대로인지.
   - 옛 코드 결과와 비교: 청구서 목록·프로젝트별 청구서·매출 5종·외주 정산·프로젝트 목록 금액 **일치**.
   - 주요 화면 렌더(세션 추가·삭제 포함).
6. **배포** — 배포 전 백업 job → 수동 배포 → 로그에서 `[migrate redesign_cleanup_v1]` 확인.

## 9. 범위 밖

- 개편과 무관한 레거시 컬럼(`projects.project_type`·`due_date`, `invoices.due_date`, `rooms.parent_id` 등)과 기준선 재작성(§4 대안).
- `track_tasks.billing_type`·`quantity`·`unit_price`(§2-2 — 청구가 쓴다).
- 프로젝트 목록 3탭(진행 중·청구 필요·완료)의 재정의 — 3단계 설계 §8에서 '대기함이 자리 잡은 뒤 판단'으로 남긴 것.
