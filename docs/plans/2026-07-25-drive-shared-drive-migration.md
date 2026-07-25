# ERP Drive 저장소를 공유 드라이브로 이전 — **완료**

첨부 서류(사업자등록증·주민등록증 사본·통장사본)와 DB 백업을 **관리자 개인 내 드라이브**에서
**조직 소유 공유 드라이브**로 옮겼다.

작성 2026-07-25 · **완료 2026-07-26**

## 최종 구조

```
공유 드라이브 omg-studios          ← 서비스 계정은 둘 다 비멤버
├── omg-studios-erp/              ← erp-drive 계정에만 폴더 공유
│   ├── 사업자등록증/   13   주민등록증 사본/ 1
│   └── 통장사본/        1   backups/       14
└── omg-studios-web/              ← homepage-drive 계정에만 폴더 공유
    └── discography-covers/ 644
```

계획 단계에서는 드라이브를 둘로 나눌 생각이었으나, 사용자 결정으로 **드라이브 하나에
폴더로 나누고 접근은 폴더 공유로 좁히는** 구조가 됐다. 실측으로 성립을 확인했다:
각 계정은 자기 폴더 200, 상대 폴더 404, 드라이브 루트 404(비멤버).

검증(2026-07-26): Drive 폴더 점검 "업로드 테스트 통과", 사업자등록증 실제 다운로드 성공.
앱 기록 15개(첨부) + 백업 14개 = 드라이브 실제 29개로 일치.

## 이 작업에서 배운 것 — 다음에 같은 함정을 피하려면

**1. Drive API 는 폴더를 공유 드라이브로 옮기지 못한다.**
`Moving folders into shared drives is not supported.` 권한 문제가 아니라 API 제약이다.
**웹 UI 는 된다.** 파일 단위 이동은 API 로도 된다. 폴더째 옮겨야 하면 사람이 UI 에서 해야 한다.

**2. 성공 판정을 API 응답으로 하면 안 된다.**
첫 시도에서 화면에는 "옮겼습니다"가 떴는데 실제로는 아무것도 옮겨지지 않았다.
이동 후 **재조회해서 driveId 를 비교**해야 한다. 결과를 flash 한 줄로 뭉개면 원인을 못 찾는다 —
단계·오류를 그대로 보여주는 진단 화면이 낫다.

**3. 공유 드라이브의 접근 경계는 드라이브지 폴더가 아니다.**
드라이브 멤버는 드라이브 전체를 본다. 단 **멤버로 넣지 않고 특정 폴더만 공유**하면 그 폴더만
접근하게 만들 수 있다(실측 확인). 신뢰 수준이 다른 자료를 한 드라이브에 둘 때는 이 방식이어야 한다.
멤버로 추가하는 순간 조용히 전체가 열린다.

**4. 파일·폴더 ID 는 이동해도 바뀌지 않는다.**
그래서 DB(file_id)·폴더 캐시·기존 링크를 손대지 않고 옮길 수 있었다.

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

### ⚠️ OAuth 토큰은 걷어내면 안 된다

`drive.js` 의 `getRefreshToken()` 을 **Drive 말고도 세 모듈이 함께 쓴다.**

| 모듈 | 용도 |
|---|---|
| `mailer.js` | 메일 발송 |
| `calendar.js` | 캘린더 (주석에 "Drive와 같은 refresh token 재사용") |
| `people.js` | 연락처 |

따라서 이번 작업은 **"OAuth 를 서비스 계정으로 교체" 가 아니라 "Drive 만 서비스
계정으로 분리"** 다. OAuth 저장·조회 경로(`saveRefreshToken`, `getRefreshToken`,
`setDriveAccountEmail`, `getDriveAccountEmail`)와 `routes/auth.routes.js` 의
토큰 저장은 그대로 둔다.

`isLinked()` 의 의미도 나눈다. 지금은 "OAuth 토큰 있음" 이고 `storage.js` 가
이걸로 백엔드를 고르는데, 앞으로 **Drive 백엔드 판정은 서비스 계정 설정 여부**로
바꾼다. 메일·캘린더·연락처의 판정에는 손대지 않는다.

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

- `driveClient()` 를 OAuth refresh token 대신 **서비스 계정 JWT** 로
  (`getRefreshToken()` 자체는 메일·캘린더·연락처가 쓰므로 **남겨둔다**)
- 루트 폴더 결정: `'root' in parents` → 공유 드라이브 ID 를 부모로
- 모든 `files.*` 호출에 `supportsAllDrives: true`,
  `list` 계열에는 `includeItemsFromAllDrives: true` + `corpora: 'drive'` + `driveId` 추가
- `backupToDrive()` 의 `spaces: "drive"` 목록 조회도 위 파라미터 반영
- `isLinked()` 는 **Drive 백엔드 판정용**으로 의미를 바꾼다:
  "OAuth 토큰 있음" → "서비스 계정 키 + 공유 드라이브 ID 설정됨".
  `storage.js` 의 `activeBackend()` 가 이걸 따른다.

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
