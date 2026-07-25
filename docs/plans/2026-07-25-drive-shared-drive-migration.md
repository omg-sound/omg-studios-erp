# ERP Drive 저장소를 공유 드라이브로 이전

첨부 서류(사업자등록증 등)와 DB 백업을 **관리자 개인 내 드라이브**에서
**조직 소유 공유 드라이브 `omg-studios-erp`** 로 옮긴다.

작성 2026-07-25.

## 왜

지금 ERP 첨부 파일은 `studio@omgworks.kr` 의 **내 드라이브**에 있다
(`drive.js` 의 `ROOT_FOLDER_NAME = "omg-studios-manager"`, `'root' in parents`).
개인 계정 소유라 그 계정에 문제가 생기면 첨부 서류가 함께 사라진다.
공유 드라이브로 옮기면 파일이 조직 소유가 되어 담당자 계정과 무관해진다.

홈페이지는 2026-07-25 에 같은 이유로 공유 드라이브(`omg-studios-web`)로 전환했다.
ERP 도 같은 축으로 맞춘다. **두 드라이브는 분리한다** — 홈페이지 서비스 계정은
`omg-studios-erp` 의 멤버가 아니며, 그 반대도 마찬가지다. (격리 확인 완료)

## 현재 구조

| | 현재 | 목표 |
|---|---|---|
| 인증 | 관리자 OAuth refresh token (암호화 저장) | 전용 서비스 계정 |
| 스코프 | `drive.file` (앱이 만든 파일만) | `drive` (해당 공유 드라이브 한정) |
| 위치 | 내 드라이브 `omg-studios-manager/` | 공유 드라이브 `omg-studios-erp` |
| 소유자 | `studio@omgworks.kr` 개인 | omgworks.kr 조직 |

Drive 접근은 전부 `src/drive.js` 를 지나고, 그 위를 `src/storage.js` 가
`drive | local` 백엔드로 추상화한다. 라우트는 `storage` 만 쓰므로
**바꿀 곳은 사실상 `drive.js` 하나다.**

## 핵심 사실 두 가지

**1. 파일 ID 는 이동해도 바뀌지 않는다.**
DB(`deliverables.file_id`, 클라이언트 첨부)에 저장된 값은 그대로 유효하다.
→ **데이터 마이그레이션이 필요 없다.**

**2. 공유 드라이브 멤버는 그 드라이브의 모든 파일을 본다.**
지금 `drive.file` 스코프의 "앱이 만든 파일만" 제약 때문에 소유권이 바뀌면
접근이 끊길 위험이 있는데, 공유 드라이브에서는 **멤버십이 접근 근거**라
이 문제가 사라진다. 서비스 계정 전환이 곧 해법이다.

## 단계

### 1단계 — 서비스 계정 준비

- GCP `durable-pulsar-500418-p3` 에 **ERP 전용** 서비스 계정 생성
  (홈페이지의 `homepage-drive@…` 와 **분리**한다. 한쪽이 털려도 다른 쪽에 닿지 않게)
- 공유 드라이브 `omg-studios-erp` 에 **콘텐츠 관리자**로 추가
- 키 발급 → Render 환경변수 `GOOGLE_SA_KEY`(base64)
- 공유 드라이브 ID → `DRIVE_ERP_DRIVE_ID`

### 2단계 — `drive.js` 전환

- `driveClient()` 를 OAuth refresh token 대신 서비스 계정 JWT 로
- 루트 폴더 결정: `'root' in parents` → 공유 드라이브 ID 를 부모로
- 모든 `files.*` 호출에 `supportsAllDrives: true`,
  `list` 계열에는 `includeItemsFromAllDrives: true` + `corpora: 'drive'` + `driveId` 추가
- `backupToDrive()` 의 `spaces: "drive"` 목록 조회도 위 파라미터 반영
- `isLinked()` 의미 변경: "OAuth 토큰 있음" → "서비스 계정·드라이브 설정 있음"

### 3단계 — 기존 파일 이동

- `studio@omgworks.kr` 이 Drive UI 에서 `omg-studios-manager/` 내용을
  공유 드라이브 `omg-studios-erp` 로 이동 (소유권이 조직으로 넘어간다)
- 하위 폴더 구조(`backups/` 등)는 그대로 유지
- **이동 후 `app_state` 의 폴더 캐시를 비운다** — `drive_folder_root`,
  `drive_folder_sub_*`. 비우지 않으면 옛 폴더 ID 를 계속 참조한다.

### 4단계 — 설정 화면 정리

`views.settings.js` 의 Drive 연동/해제 UI 는 OAuth 전제다. 서비스 계정은
사람이 로그인하는 방식이 아니므로 **연동 버튼을 없애고 상태 표시로 바꾼다**
(드라이브 이름·파일 수·`probeUpload()` 진단 유지).

### 5단계 — 검증

- **이전 전후 `driveFileCount()` 비교** — 숫자가 같아야 한다 (유실 확인)
- `checkFolder()` / `probeUpload()` 진단 통과
- 기존 첨부 **다운로드가 되는지** — 사업자등록증(거래처)과 **주민등록증 사본(외주 작업자)**
  양쪽 다. 파일 ID 유지 확인의 실질 검증이다
- 첨부 신규 업로드 → 공유 드라이브의 올바른 하위 폴더에 생성되는지
- `backupToDrive()` 1회 실행 → `backups/` 에 쌓이고 보존 개수(기본 14)가 정리되는지
- 로컬 폴백(미설정 시 `local` 백엔드)이 여전히 동작하는지

## 위험 요소

| 위험 | 대응 |
|---|---|
| 이동 중 첨부 다운로드 실패 | Render 는 **자동배포가 꺼져 있다**(`autoDeploy: false`). 코드 배포와 파일 이동 시점을 사람이 골라 붙인다. 배포 시 ~1분 중단은 예정된 것 |
| 이동 후 접근 끊김 | 파일 1개로 먼저 시험 이동 → 서비스 계정으로 읽히는지 확인한 뒤 나머지 진행 |
| 두 서비스 계정 혼동 | 홈페이지용과 ERP용을 이름으로 분명히 구분하고, 각자 자기 드라이브에만 멤버로 넣는다 |
| 백업 유실 | 이전 전 `backups/` 를 로컬에도 1부 내려둔다 |

## 이전 대상 파일 전체

**전부 ERP 가 올린 파일이다.** 드라이브에 직접 올린 파일은 없다.

| 테이블 | kind | Drive 하위 폴더 | 출처 화면 |
|---|---|---|---|
| `client_files` | `biz_license` | 사업자등록증 | 거래처 상세 |
| `client_files` | `bankbook` | 통장사본 | (폐기 2026-07-01, 과거분 열람만) |
| `worker_files` | `id_card` | 주민등록증 사본 | **외주 작업자 상세** |
| `worker_files` | `bankbook` | 통장사본 | 외주 작업자 상세 |
| `deliverables` | — | (프로젝트별) | 자료 전달 |
| — | — | `backups/` | DB 자동 백업 |

폴더명 매핑은 `lib/storage-migrate.js` 의 `KIND_FOLDER` 에 있다.

`storage_backend` 컬럼으로 `local | drive` 를 구분하고,
`localFileCount()` / `driveFileCount()` 로 현황을 셀 수 있다.
**이전 전후로 이 수치를 비교하면 유실 여부를 바로 확인할 수 있다.**

## PII 취급 — 이전 후에도 유지할 것

이 드라이브에는 **주민등록증 사본**이 들어간다. ERP 는 이미 다음을 지키고 있으니
이전 과정에서 깨뜨리지 않는다.

- 주민등록번호·계좌번호는 **DB 암호화 저장**(`db.encrypt`, `project_managers.id_number`)
- 감사 로그에 민감정보 금지 (`lib/audit.js`)
- 목록 화면은 **등록 여부만** 표시하고 번호를 흘리지 않는다 (`data/worker-summary.js`)
- 작업자 삭제 시 첨부 실파일까지 회수 — 드라이브에 PII 스캔본이 고아로 남지 않게
  (`routes/workers.routes.js:175`)
- 첨부 삭제는 영구삭제가 아니라 휴지통 — 30일 복구 창 (`drive.js` `deleteFile`)

**추가 권장**: Admin 콘솔에서 `omg-studios-erp` 공유 드라이브에
**외부 공유 차단**과 다운로드 제한을 걸어둔다. Enterprise Plus 라 DLP 규칙도 쓸 수 있다.
주민등록번호가 담긴 문서는 개인정보보호법상 안전조치 의무 대상이다.
