"use strict";

/**
 * 구글 Drive 스토리지 모듈.
 *
 * 핵심 설계:
 * - 첨부·백업은 **조직 소유 공유 드라이브 `omg-studios-erp`** 에 저장한다(2026-07-25 전환).
 *   전에는 관리자 개인 내 드라이브(`omg-studios-manager` 폴더)에 두었는데,
 *   그 계정에 문제가 생기면 사업자등록증·주민등록증 사본이 함께 사라지는 구조였다.
 * - 접근은 **전용 서비스 계정**(erp-drive@…)으로 한다. 공유 드라이브는 멤버십이 접근
 *   근거라, 예전 `drive.file` 스코프의 "앱이 만든 파일만 보임" 제약이 없다.
 * - ⚠️ 이 파일의 `getRefreshToken()` 은 Drive 전용이 아니다. mailer·calendar·people 이
 *   같은 OAuth 토큰을 함께 쓰므로 **걷어내면 안 된다.**
 * - 업로드 파일은 공개하지 않고 백엔드가 프록시 스트리밍(/api/assets/:id/raw).
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { getState, setState, encrypt, decrypt } = require("./db");

const STATE_REFRESH_TOKEN = "drive_refresh_token"; // 암호화 저장
const STATE_FOLDER_PREFIX = "drive_folder_"; // kind별 folder_id 캐시

class DriveNotLinkedError extends Error {
  constructor() {
    super("DRIVE_NOT_LINKED");
    this.code = "DRIVE_NOT_LINKED";
  }
}

/** 관리자 OAuth 콜백에서 받은 refresh token을 암호화 저장. */
function saveRefreshToken(refreshToken) {
  if (!refreshToken) return;
  setState(STATE_REFRESH_TOKEN, encrypt(refreshToken));
}

function getRefreshToken() {
  return decrypt(getState(STATE_REFRESH_TOKEN));
}

const STATE_DRIVE_EMAIL = "drive_account_email"; // 현재 Drive 토큰이 어느 구글 계정 것인지(표시용, 평문)
function setDriveAccountEmail(email) { setState(STATE_DRIVE_EMAIL, String(email || "").trim() || null); }
function getDriveAccountEmail() { return getState(STATE_DRIVE_EMAIL) || null; }

/**
 * Drive 백엔드를 쓸 수 있는지. 서비스 계정 키와 공유 드라이브 ID가 모두 설정돼야 한다.
 * (OAuth 토큰 유무와 무관 — 그쪽은 메일·캘린더·연락처용이다.)
 */
function isLinked() {
  return config.driveConfigured;
}

/**
 * 관리자 OAuth 연동 여부. 메일·캘린더·연락처가 이 토큰을 쓴다.
 * 2026-07-25 이전에는 `isLinked()` 가 이 뜻이었고 Drive 판정도 겸했는데,
 * Drive 가 서비스 계정으로 갈라지면서 둘을 분리했다.
 */
function isOAuthLinked() {
  return Boolean(config.googleConfigured && getRefreshToken());
}

let saAuth = null;

/** 서비스 계정으로 인증된 Drive 클라이언트. 미설정 시 DriveNotLinkedError. */
function driveClient() {
  if (!config.driveConfigured) throw new DriveNotLinkedError();
  if (!saAuth) {
    const key = JSON.parse(Buffer.from(config.driveSaKey, "base64").toString("utf8"));
    saAuth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
  }
  return google.drive({ version: "v3", auth: saAuth });
}

// 공유 드라이브를 다루려면 모든 호출에 붙여야 하는 파라미터.
const SHARED = { supportsAllDrives: true };
/** list 계열 전용 — 공유 드라이브 안만 검색한다. */
function sharedListParams() {
  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: config.driveSharedDriveId,
  };
}

const fs = require("fs");

// 개인 내 드라이브 시절의 래퍼 폴더(omg-studios-manager)와 그 캐시·이름 변경 게이트는
// 공유 드라이브 전환(2026-07-25)으로 사라졌다. 저장 루트는 공유 드라이브 자체다.

/** 캐시된 폴더 id가 실재하고 휴지통이 아니면 true. 조회 실패(404 등)·휴지통이면 false. */
async function folderAlive(drive, id) {
  try {
    const { data } = await drive.files.get({ fileId: id, fields: "id,trashed", ...SHARED });
    return !data.trashed;
  } catch (_e) {
    return false;
  }
}

/**
 * 저장 루트 = 공유 드라이브 자체.
 *
 * 개인 내 드라이브를 쓰던 시절에는 그 안에 `omg-studios-manager` 폴더를 두고 그걸 루트로 삼았고,
 * 캐시 유실·토큰 변경으로 같은 이름 폴더가 여러 개 생기는 문제가 있어 탐색·통합 로직이 필요했다.
 * 이제는 ERP 전용 공유 드라이브(omg-studios-erp)를 쓰므로 래퍼 폴더도, 그 중복 처리도 필요 없다.
 * (2026-07-25 이관 완료 후 정리)
 */
async function ensureFolder() {
  if (!config.driveRootFolderId) throw new DriveNotLinkedError();
  return config.driveRootFolderId;
}

/** 루트(또는 지정 부모) 아래 같은 이름의 하위 폴더 목록. 생성일 오름차순(가장 오래된=원본). */
async function listSubfolders(name, parentId) {
  const drive = driveClient();
  const q = `name = '${String(name).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${parentId}' in parents`;
  const { data } = await drive.files.list({ q, fields: "files(id,name,createdTime)", orderBy: "createdTime", pageSize: 50, ...sharedListParams() });
  return data.files || [];
}

/**
 * 루트 아래 하위 폴더(이름별)를 lazy 생성·캐시. 캐시가 삭제/휴지통/안 보임이면 **이름으로 기존 폴더를 먼저 검색**해
 * 재사용(중복 생성 방지 — 루트 캐시 변경/토큰 변경으로 같은 이름 하위 폴더가 여러 개 생기던 문제). 여러 개면 가장 오래된 것.
 */
async function ensureSubfolder(name) {
  const key = STATE_FOLDER_PREFIX + "sub_" + name;
  const drive = driveClient();
  const cached = getState(key);
  if (cached && (await folderAlive(drive, cached))) return cached;
  if (cached) setState(key, null); // 무효 캐시 폐기
  const root = await ensureFolder();
  // 새로 만들기 전에 루트 아래 같은 이름의 기존 하위 폴더 검색 — 있으면 재사용(가장 오래된 원본).
  try {
    const existing = await listSubfolders(name, root);
    if (existing.length) { setState(key, existing[0].id); return existing[0].id; }
  } catch (_e) { /* 검색 실패 시 생성 폴백 */ }
  const { data } = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [root] },
    fields: "id",
    ...SHARED,
  });
  setState(key, data.id);
  return data.id;
}

/** 로컬 파일 → Drive 업로드(스트리밍). folder(하위 폴더명) 지정 시 그 아래, 없으면 루트. drive fileId 반환. */
async function uploadFile({ filePath, name, mimeType, folder }) {
  const drive = driveClient();
  const parent = folder ? await ensureSubfolder(folder) : await ensureFolder();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: mimeType || "application/octet-stream", body: fs.createReadStream(filePath) },
    fields: "id",
    ...SHARED,
  });
  return data.id;
}

/** Drive 파일을 res로 프록시 스트리밍(공개 URL 없이, 백엔드가 비공개 유지). */
async function streamFile(fileId, res) {
  const drive = driveClient();
  const resp = await drive.files.get({ fileId, alt: "media", ...SHARED }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    res.on("close", () => { try { resp.data.destroy(); } catch (_e) {} }); // 클라이언트 중단 시 업스트림 파괴(FD/소켓 누수 방지) — 로컬 스트림과 동일
    resp.data.on("end", resolve).on("error", reject).pipe(res);
  });
}

async function deleteFile(fileId) {
  const drive = driveClient();
  // 영구삭제 대신 휴지통으로 이동 — 첨부 교체·오삭제 시 30일 복구 창 확보(민감 금융서류 보호).
  await drive.files.update({ fileId, requestBody: { trashed: true }, ...SHARED });
}

/**
 * DB 백업 파일을 Drive 'backups' 하위 폴더로 오프사이트 전송(Render 디스크 단일 장애점 완화).
 * 같은 이름(같은 날) 기존본은 교체, 이름(=날짜) 사전순 최신 keep개만 보존. 미연동이면 skip.
 * @returns {Promise<{ok?:boolean, skipped?:boolean, reason?:string, fileId?:string, pruned?:number}>}
 */
async function backupToDrive(filePath, { keep = 14 } = {}) {
  if (!filePath || !isLinked()) return { skipped: true, reason: "no-drive" };
  const path = require("path");
  const drive = driveClient();
  const parent = await ensureSubfolder("backups");
  const name = path.basename(filePath);
  const { data } = await drive.files.list({
    q: `'${parent}' in parents and trashed = false`,
    fields: "files(id,name)", orderBy: "name", pageSize: 200, ...sharedListParams(),
  });
  const files = (data.files || []).filter((f) => /^app-\d.*\.db$/.test(f.name));
  for (const f of files) { if (f.name === name) { try { await deleteFile(f.id); } catch (_e) {} } } // 같은 날 재실행 중복 제거
  const { data: up } = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: "application/x-sqlite3", body: fs.createReadStream(filePath) },
    fields: "id",
    ...SHARED,
  });
  // 정리: 이름(app-YYYY-MM-DD.db) 사전순 = 날짜순 → 최신 keep개만 보존, 나머지 휴지통.
  const remaining = files.filter((f) => f.name !== name).map((f) => ({ id: f.id, name: f.name }));
  remaining.push({ id: up.id, name });
  remaining.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let pruned = 0;
  for (const f of remaining.slice(0, Math.max(0, remaining.length - keep))) { try { await deleteFile(f.id); pruned++; } catch (_e) {} }
  return { ok: true, fileId: up.id, pruned };
}

/** Drive 파일/폴더 메타(존재 확인·바로가기 링크). 없으면(404 등) 예외. */
async function getFileMeta(fileId) {
  const drive = driveClient();
  const { data } = await drive.files.get({ fileId, fields: "id,name,webViewLink,mimeType,trashed,createdTime", ...SHARED });
  return data;
}

/**
 * 저장 폴더 점검: 폴더가 있으면 그대로, 없으면 생성 후 메타(id·name·webViewLink) 반환.
 * 반환: { id, name, webViewLink, created(신규생성 여부) } 또는 미연동 시 예외.
 */
async function checkFolder() {
  const id = await ensureFolder(); // = omg-studios-erp 폴더
  const meta = await getFileMeta(id);
  return { id: meta.id, name: meta.name, webViewLink: meta.webViewLink || null, trashed: !!meta.trashed, created: false };
}

/**
 * 업로드 왕복 프로브: 작은 임시 파일을 Drive에 업로드→메타 확인→삭제. 실제 첨부 저장 경로(uploadFile)를
 * 그대로 검증한다(폴더 접근만 보는 checkFolder보다 강함). 성공 { ok:true, fileId } / 실패 시 예외.
 */
async function probeUpload() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = path.join(os.tmpdir(), `omg-drive-probe-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "OMG Studios Drive 연결 테스트 — 자동 삭제됩니다.\n");
  let fileId;
  try {
    fileId = await uploadFile({ filePath: tmp, name: "_연결테스트.txt", mimeType: "text/plain" });
    await getFileMeta(fileId); // 읽기 확인
    return { ok: true, fileId };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) { /* noop */ }
    if (fileId) { try { await deleteFile(fileId); } catch (_e) { /* 삭제 실패는 무해(휴지통 처리) */ } }
  }
}

module.exports = {
  DriveNotLinkedError,
  STATE_REFRESH_TOKEN,
  STATE_FOLDER_PREFIX,
  saveRefreshToken,
  getRefreshToken,
  setDriveAccountEmail,
  getDriveAccountEmail,
  isLinked,
  isOAuthLinked,
  driveClient,
  ensureFolder,
  ensureSubfolder,
  getFileMeta,
  checkFolder,
  probeUpload,
  listSubfolders,
  uploadFile,
  streamFile,
  deleteFile,
  backupToDrive,
};
