"use strict";

require("dotenv").config();

const path = require("path");

// 앱이 만들어 **밖으로 나가는 모든 링크**의 기준 주소 — 구글 OAuth redirect_uri, 자료 전달 공개 링크(/d/:token),
// 청구 발행 알림, 캘린더 일정의 프로젝트 링크가 전부 이 값을 쓴다.
// 우선순위: BASE_URL(명시) > RENDER_EXTERNAL_URL(Render 자동 주입) > 로컬.
// ⚠️ 커스텀 도메인(erp.omgworks.kr) 필수 조건: Render는 RENDER_EXTERNAL_URL(=*.onrender.com)을 **항상** 주입하고
// 지울 수 없다. 이전엔 그 값이 BASE_URL보다 우선해서, 도메인을 붙이고 BASE_URL을 설정해도 링크가 전부
// onrender.com으로 나갔다(2026-07-14 도메인 연결 검토에서 발견). 명시 설정이 자동 주입을 이긴다.
const baseUrl =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${process.env.PORT || 3000}`;

const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),
  baseUrl: baseUrl.replace(/\/+$/, ""),

  adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),

  // 자료 저장 Drive는 **이 계정 하나로 영구 고정**한다(치프가 바뀌어도 무관).
  // 이 이메일로 로그인할 때만 Drive refresh token을 저장 → 항상 스튜디오 계정 Drive에 저장.
  // 기본 studio@omgworks.kr, 배포 env(STUDIO_DRIVE_EMAIL)로만 변경(앱 UI로는 못 바꿈).
  studioDriveEmail: (process.env.STUDIO_DRIVE_EMAIL || "studio@omgworks.kr").trim().toLowerCase(),

  // 첨부·백업 저장 Drive는 **조직 소유 공유 드라이브(omg-studios-erp)** 를 쓴다(2026-07-25).
  // 개인 내 드라이브에 두면 그 계정에 문제가 생길 때 서류가 함께 사라진다.
  // 접근은 전용 서비스 계정으로 하며, 메일·캘린더·연락처가 쓰는 OAuth 토큰과는 별개다.
  driveSaKey: process.env.GOOGLE_SA_KEY || "", // 서비스 계정 JSON 키(base64)
  // 드라이브 ID와 루트 폴더 ID를 따로 둔다. 공유 드라이브 omg-studios 안의
  // omg-studios-erp 폴더만 이 앱에 공유돼 있어서(드라이브 멤버 아님),
  // 파일을 만들 부모는 폴더 ID 이고 목록 조회(corpora=drive)에는 드라이브 ID 가 필요하다.
  driveSharedDriveId: (process.env.DRIVE_ERP_DRIVE_ID || "").trim(),
  driveRootFolderId: (process.env.DRIVE_ERP_ROOT_FOLDER_ID || "").trim(),

  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-session-secret",
  tokenEncKey: process.env.TOKEN_ENC_KEY || "dev-insecure-token-enc-key",

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    get redirectUri() {
      return `${baseUrl.replace(/\/+$/, "")}/auth/google/callback`;
    },
  },

  dbPath: path.resolve(process.env.DB_PATH || "./data/app.db"),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || "200", 10),
  // 로컬 스토리지 백엔드 디렉터리(DB와 같은 디스크에). Render는 영속 Disk(/var/data/uploads).
  uploadsDir: path.join(path.dirname(path.resolve(process.env.DB_PATH || "./data/app.db")), "uploads"),

  // 개발 전용 로그인(OAuth 자격증명 없이 로컬 검증). 프로덕션에서는 반드시 빈 값.
  devLogin: process.env.DEV_LOGIN === "1" || process.env.DEV_LOGIN === "true",

  backupToken: process.env.BACKUP_TOKEN || "",

  // Google Places API 키(장소 주소 자동완성 백엔드 프록시용). 미설정 시 자동완성 비활성(자유입력만).
  // Cloud에서 Places API(New) 활성화 + 결제 등록 + API 키 필요. 키는 서버에서만 사용(클라 미노출).
  placesApiKey: (process.env.GOOGLE_PLACES_API_KEY || "").trim(),

  cookieName: "omg_session",
  sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30일
};

config.isProd = config.env === "production";
config.googleConfigured = Boolean(config.google.clientId && config.google.clientSecret);
// Drive 백엔드 사용 가능 여부. googleConfigured(OAuth = 메일·캘린더·연락처)와 별개다.
config.driveConfigured = Boolean(config.driveSaKey && config.driveSharedDriveId && config.driveRootFolderId);

function isWeakSecret(value, devDefault) {
  const v = String(value || "").trim();
  return !v || v === devDefault || /^change-me/i.test(v) || v.length < 32;
}

function validateConfig() {
  const errors = [];
  if (!Number.isInteger(config.port) || config.port <= 0) errors.push("PORT must be a positive integer");
  if (!Number.isInteger(config.maxUploadMb) || config.maxUploadMb <= 0) {
    errors.push("MAX_UPLOAD_MB must be a positive integer");
  }

  if (config.isProd) {
    if (config.devLogin) errors.push("DEV_LOGIN must be disabled in production");
    if (!config.adminEmail) errors.push("ADMIN_EMAIL is required in production");
    if (isWeakSecret(config.sessionSecret, "dev-insecure-session-secret")) {
      errors.push("SESSION_SECRET must be set to a strong random value in production");
    }
    if (isWeakSecret(config.tokenEncKey, "dev-insecure-token-enc-key")) {
      errors.push("TOKEN_ENC_KEY must be set to a strong random value in production");
    }
    if (!config.googleConfigured) {
      errors.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for production admin login");
    }
    // 백업 cron 인증 토큰. 미설정 시 백업이 조용히 비활성(404)되므로 프로덕션에서 강제.
    // (다른 시크릿과 동일한 강도 가드 — render.yaml은 web·cron 양쪽에 같은 값을 sync:false로 받는다.)
    if (isWeakSecret(config.backupToken, "")) {
      errors.push("BACKUP_TOKEN must be set to a strong random value (>=32 chars) in production (백업 cron 인증; 예: openssl rand -hex 32)");
    }
  }

  if (errors.length) throw new Error("Configuration error:\n- " + errors.join("\n- "));
}

validateConfig();

// ── 도메인 상수: 옵션값은 코드가 단일 진실원천. DB CHECK 제약 금지(플레이북 §2.8) ──
// owner = OMG 대표(전체 열람 모니터링 + 청구 관리), chief = 치프 엔지니어(운영 전반),
// staff = 녹음실 엔지니어/매니저(프로젝트·항목·작업·자료 편집까지).
// 전원 Google 화이트리스트 로그인(거래처 외부 열람은 폐기).
const ROLES = ["owner", "chief", "staff"];
const ROLE_LABELS = { owner: "대표", chief: "치프 엔지니어", staff: "스태프" };

// 프로젝트 유형 2종(핵심 모티브):
//  session = 클라이언트가 방문해 담당자와 실시간으로 진행. 예약 + 실제 작업시간이 존재(세션 일정 탭 노출).
//  task    = 예약 없이 항목만 존재하는 업무흐름(세션 일정 탭 숨김, 곡·콘텐츠 중심).
const PROJECT_TYPES = [
  // label = 배지·제목용, menuLabel = '+ 새 프로젝트' 드롭다운 표기(액션형).
  { key: "session", label: "세션", menuLabel: "세션 프로젝트 만들기", hint: "고객 방문 · 예약 · 실시간 작업" },
  { key: "task", label: "작업", menuLabel: "작업 프로젝트 만들기", hint: "예약 없이 항목 단위로 진행" },
];
const PROJECT_TYPE_KEYS = PROJECT_TYPES.map((t) => t.key);

const PROJECT_SERVICES = [
  { key: "recording", label: "녹음" },
  { key: "vocal_tune", label: "보컬튠" },
  { key: "mixing", label: "믹싱" },
  { key: "mastering", label: "마스터링" },
];
// 단가표 분류의 **1회 시드 데이터**(2026-07-05부터 진실원천은 DB `rate_categories` 테이블 — 치프가 관리>콘텐츠에서
// 커스텀 분류를 추가·수정·삭제할 수 있게 전환. 이 4개는 시드 시 locked=1로 들어가 수정·삭제 불가). db.js seedDefaultCatalogs만 참조.
// 분류→kind 조회·검증은 이제 DB 기반(`src/data/rate-categories.js`의 rateCategoryKind/listRateCategories)을 쓴다.
const RECORDING_CATEGORIES = ["스튜디오 녹음", "로케이션 녹음"];
const FILMING_CATEGORIES = ["스튜디오 촬영"]; // 로케이션 촬영은 미사용(사용자 결정)
const PERFORMANCE_CATEGORIES = ["공연"]; // 항목 예: 플레이백 세션·라이브 믹스
// 세션 종류(대관) → 단가 kind. 녹음=recording, 대관=filming, 공연=performance.
// ⚠️키는 **DB에 저장되는 session_type 문자열**이다(사용자에게 보이는 라벨과 같은 값).
const SESSION_TYPE_RATE_KIND = { 녹음: "recording", 대관: "filming", 공연: "performance" };
// ── 가격 유형(2026-07-26 과금 체계 개편) ──
// 단가 항목·작업 종류가 '금액을 어떻게 다룰지'를 정한다. 홈페이지 pricing.ts의 PriceType와 같은 세 값.
//  fixed   = 기본가 잠금(청구 화면에서 못 고침). 초과 시간만 자동 가산 — 녹음·촬영 대관.
//  base    = 기준가를 자동 입력한 뒤 위아래로 수정 가능 — 믹싱(작업량에 따라 차등).
//  minimum = 최소가를 자동 입력한 뒤 상향만 — 보컬튠(작업량에 따라 상향).
// 촬영 세션의 구간(2026-07-26) — 반입·설치 / 촬영 / 철수를 각각 시작·종료 시각으로 입력한다.
// 룸 점유는 세 구간을 아우르는 한 덩어리(sessions.start_time~end_time)이고, 요금 시간은 구간 합산이다.
const SESSION_SEGMENT_KINDS = ["setup", "shoot", "teardown"];
const SESSION_SEGMENT_LABELS = { setup: "반입·설치", shoot: "촬영", teardown: "철수" };
const COMPANY_ROLES = ["소속사/레이블", "제작사"]; // 업체 역할 다중(겸업: 소속사가 제작도 함). CSV로 clients.roles에 저장
const DELIVERABLE_KINDS = ["녹음본", "튠본", "믹스", "스템", "마스터", "레퍼런스", "기타"];
// 계산서(세금계산서)·입금 상태 — 청구서 발행과 독립적으로 진행(자유 선택). '입금완료'는 완납 처리와 연동.
const TAX_STATUSES = ["계산서 미발행", "계산서 발행", "입금완료"];
// 청구 PDF 문서 제목 — 발행 시 골라서(내용 동일, 제목·일부 문구만 분기).
const DOC_TYPES = ["견적서", "내역서", "거래명세서"];
// 문서 유형별 번호 — 기준 채번(OMG-YYYYMM-### 또는 레거시 INV-)에 유형 코드 삽입.
// 견적서=OMG-EST-…, 내역서=OMG-L-…, 거래명세서=기준번호(OMG-…). 미리보기(청구 생성 전)도 다음 번호로 표기.
function docNumberWithType(baseNumber, docType) {
  if (!baseNumber) return "";
  const code = docType === "견적서" ? "EST-" : docType === "내역서" ? "L-" : "";
  return String(baseNumber).replace(/^(OMG|INV)-/, "OMG-" + code);
}
const TRACK_CONTENT_TYPES = ["Music", "Video_Post"];
// 작업 종류: DB 카탈로그(task_types)의 시드 데이터. 부팅 시 1회 시드 후로는 DB가 단일 진실원천.
// billing=기본 과금, price=기본 단가(원), quick=곡·콘텐츠 '빠른 추가' 버튼 노출.
const TASK_TYPES = [
  { key: "Vocal_Recording", label: "보컬 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "Instrument_Recording", label: "악기 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "ADR_Recording", label: "ADR/후시 녹음", group: "Recording", billing: "Time_Charge", price: 0, quick: false },
  { key: "Vocal_Tuning", label: "보컬튠", group: "Post_Production", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Audio_Editing", label: "오디오 편집", group: "Post_Production", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Mixing", label: "믹싱", group: "Mix_Master", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Mastering", label: "마스터링", group: "Mix_Master", billing: "Fixed_Per_Track", price: 0, quick: true },
  { key: "Audio_Dub_Mixing", label: "더빙 믹싱", group: "Video_Audio", billing: "Fixed_Per_Track", price: 0, quick: false },
  { key: "SFX_Foley", label: "SFX/Foley", group: "Video_Audio", billing: "Fixed_Per_Track", price: 0, quick: false },
];
// 작업 종류 분류(그룹) — 구조적 상수(요약·빠른버튼 그룹핑). 카탈로그 행이 이를 참조.
const TASK_GROUPS = ["Recording", "Post_Production", "Mix_Master", "Video_Audio"];
const BILLING_TYPES = ["Time_Charge", "Fixed_Per_Track"];
const BILLING_TYPE_LABELS = {
  Time_Charge: "시간 과금",
  Fixed_Per_Track: "트랙/콘텐츠 고정",
};
// 세션(스튜디오 일정). 청구 시간 산정의 기반.
// ⚠️이 값이 **그대로 DB(`sessions.session_type`)에 저장**된다 — 이름을 바꾸면 기존 행 마이그레이션이 필요하다
// (2026-07-30 '촬영'→'대관' 개명: db.js `session_type_filming_to_rental_v1`). 스튜디오가 촬영을 대행하는 게
// 아니라 공간을 대관하는 것이라는 사용자 판단 — 무엇을 위한 대관인지는 단가 항목 이름으로 표현한다(예 '촬영 대관').
const SESSION_TYPES = ["녹음", "대관", "공연", "믹싱", "마스터링", "기타"];
// 옛 이름 → 새 이름(정규화가 흡수). 캐시된 폼·외부 호출이 옛 값을 보내도 조용히 첫 값으로 떨어지지 않게.
const LEGACY_SESSION_TYPE_ALIAS = { 촬영: "대관" };
// 대관 매출 세션 — 세션 자체가 단가표(시간제) 청구 대상. 완료 시 청구로 넘어간다.
// (믹싱·마스터링 등은 세션이 청구 단위가 아님 — 곡·콘텐츠 후반작업으로 청구.) 녹음·대관·공연.
const RENTAL_SESSION_TYPES = ["녹음", "대관", "공연"];
// 후반작업 세션 — 세션 자체는 청구 단위가 아니고 곡·콘텐츠 '작업'으로 청구한다.
// 세션만 마치고 작업을 안 만들면 청구할 게 없어 보여 완료로 샜다(2026-07-24) → unbilled_cnt에서 '청구 미착수' 신호로 쓴다.
const POSTPROD_SESSION_TYPES = ["믹싱", "마스터링"];
const SESSION_STATUSES = ["예정", "완료", "취소"];
// (SESSION_TIME_SLOTS 제거 2026-07-23 — 겹침 경고가 슬롯 근사에서 구간 비교(busySessionRanges)로 바뀌며 소비처 소멸.
//  12:00~23:30 창이 오전 세션을 경고 사각지대로 만들던 원인이라, 시간대 창 자체를 없앤 것이 수정의 일부다.)
const SESSION_STATUS_BADGE = {
  예정: "bg-primary/10 text-primary",
  완료: "bg-success/10 text-success",
  취소: "bg-muted/10 text-muted",
};

// 작업 상태 = 대기/완료 2단계('진행중' 개념 폐기 — 사용자 결정 2026-07-03). 레거시 In_Progress는 normalize·마이그레이션으로 Pending 처리.
const TASK_STATUSES = ["Pending", "Completed"];
const TASK_STATUS_LABELS = {
  Pending: "대기",
  Completed: "완료",
};
const TASK_STATUS_BADGE = {
  Pending: "bg-muted/10 text-muted",
  Completed: "bg-success/10 text-success",
};

// 인보이스 상태 배지 색. '부분납'은 코드에서 파생(별도 상태 아님).
const INVOICE_STATUS_BADGE = {
  미발행: "bg-muted/10 text-muted",
  "청구서 미발행": "bg-muted/10 text-muted",
  발행: "bg-primary/10 text-primary",
  "청구서 발행": "bg-primary/10 text-primary",
  "계산서 미발행": "bg-muted/10 text-muted",
  "계산서 발행": "bg-info/10 text-info",
  입금완료: "bg-success/10 text-success",
  부분납: "bg-warning/10 text-warning",
};

/** 화이트리스트 정규화: 허용 목록에 없으면 fallback(첫 값) 반환(플레이북2 §9). */
function normalize(value, allowed, fallback) {
  const v = (value || "").trim();
  return allowed.includes(v) ? v : fallback !== undefined ? fallback : allowed[0];
}

const PROJECT_SERVICE_LABELS = Object.fromEntries(PROJECT_SERVICES.map((s) => [s.key, s.label]));

module.exports = {
  config,
  ROLES,
  ROLE_LABELS,
  normalizeRole: (v) => normalize(v, ROLES, "staff"),
  PROJECT_TYPES,
  PROJECT_TYPE_KEYS,
  normalizeProjectType: (v) => normalize(v, PROJECT_TYPE_KEYS, "session"),
  PROJECT_SERVICES,
  PROJECT_SERVICE_LABELS,
  COMPANY_ROLES,
  DELIVERABLE_KINDS,
  TAX_STATUSES,
  normalizeTaxStatus: (v) => normalize(v, TAX_STATUSES, "계산서 미발행"),
  DOC_TYPES,
  docNumberWithType,
  normalizeDocType: (v) => normalize(v, DOC_TYPES, "거래명세서"),
  INVOICE_STATUS_BADGE,
  TRACK_CONTENT_TYPES,
  TASK_TYPES,
  TASK_GROUPS,
  BILLING_TYPES,
  BILLING_TYPE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_BADGE,
  SESSION_TYPES,
  RENTAL_SESSION_TYPES,
  POSTPROD_SESSION_TYPES,
  SESSION_STATUSES,
  SESSION_STATUS_BADGE,
  RECORDING_CATEGORIES,
  FILMING_CATEGORIES,
  PERFORMANCE_CATEGORIES,
  SESSION_TYPE_RATE_KIND,
  SESSION_SEGMENT_KINDS,
  SESSION_SEGMENT_LABELS,
  // 옛 이름이 들어오면 새 이름으로 흡수한 뒤 검증한다 — 그냥 normalize하면 목록에 없어 첫 값(녹음)으로 조용히 떨어진다.
  normalizeSessionType: (v) => normalize(LEGACY_SESSION_TYPE_ALIAS[String(v == null ? "" : v).trim()] || v, SESSION_TYPES),
  normalizeSessionStatus: (v) => normalize(v, SESSION_STATUSES),
  normalizeDeliverableKind: (v) => normalize(v, DELIVERABLE_KINDS),
  normalizeTrackContentType: (v) => normalize(v, TRACK_CONTENT_TYPES),
  normalizeBillingType: (v) => normalize(v, BILLING_TYPES),
  normalizeTaskStatus: (v) => normalize(v, TASK_STATUSES),
  normalize,
};
