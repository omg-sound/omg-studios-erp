"use strict";

/**
 * 1회성 이관: 관리자 개인 내 드라이브의 `omg-studios-manager` 폴더를
 * 조직 소유 공유 드라이브(`omg-studios-erp`)로 통째로 옮긴다. (2026-07-25)
 *
 * 왜 폴더째 옮기나:
 * - 파일 ID가 이동해도 바뀌지 않아 DB(file_id)와 폴더 캐시가 그대로 유효하다.
 *   파일을 하나씩 다시 올리면 ID가 바뀌어 DB 갱신이 필요하고 실패 지점이 늘어난다.
 * - 하위 폴더 구조(사업자등록증·주민등록증 사본·통장사본·deliverables·backups)가 보존된다.
 *
 * 왜 OAuth 토큰을 쓰나:
 * - 원본은 **관리자 개인 드라이브**에 있다. 서비스 계정은 남의 내 드라이브를 볼 수 없으므로
 *   이 이관만은 기존 OAuth 토큰(앱이 만든 폴더라 drive.file 스코프로 보인다)으로 해야 한다.
 * - 이관이 끝나면 이후 모든 접근은 서비스 계정(drive.js)이 담당한다.
 */

const { google } = require("googleapis");
const { config } = require("./../config");
const { getRefreshToken } = require("./../drive");
const { oauthClient } = require("./../auth");

const ROOT_FOLDER_NAME = "omg-studios-manager";

/** 이관 전용 OAuth Drive 클라이언트(개인 드라이브 접근용). drive.js 의 서비스 계정 클라이언트와 별개. */
function oauthDrive() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.drive({ version: "v3", auth });
}

/** 개인 드라이브 최상위에서 옮길 폴더를 찾는다. 여러 개면 가장 오래된 것(원본). */
async function findSourceFolder(drive) {
  const q = `name = '${ROOT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`;
  const { data } = await drive.files.list({
    q,
    fields: "files(id,name,createdTime,parents)",
    orderBy: "createdTime",
    pageSize: 10,
    spaces: "drive",
  });
  return (data.files || [])[0] || null;
}

/** 이관 가능 여부·현황 점검(실행 없이). */
async function inspect() {
  if (!config.driveSharedDriveId) return { ok: false, error: "SHARED_DRIVE_NOT_CONFIGURED" };
  const drive = oauthDrive();
  if (!drive) return { ok: false, error: "OAUTH_NOT_LINKED" };

  const src = await findSourceFolder(drive);
  if (!src) return { ok: true, alreadyMoved: true, source: null };

  // 하위 항목 수(참고용). 폴더째 옮기므로 개수 자체가 조건은 아니다.
  const { data } = await drive.files.list({
    q: `'${src.id}' in parents and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: 200,
    spaces: "drive",
  });
  const children = data.files || [];
  return {
    ok: true,
    alreadyMoved: false,
    source: { id: src.id, parents: src.parents || [] },
    children: children.map((c) => c.name),
  };
}

/**
 * 실제 이관. 폴더 하나를 공유 드라이브 최상위로 옮긴다.
 * 소유권이 개인 → 조직으로 넘어간다(되돌리려면 반대로 옮겨야 한다).
 */
async function moveToSharedDrive() {
  if (!config.driveSharedDriveId) return { ok: false, error: "SHARED_DRIVE_NOT_CONFIGURED" };
  const drive = oauthDrive();
  if (!drive) return { ok: false, error: "OAUTH_NOT_LINKED" };

  const src = await findSourceFolder(drive);
  if (!src) return { ok: true, alreadyMoved: true, movedId: null };

  const { data } = await drive.files.update({
    fileId: src.id,
    addParents: config.driveSharedDriveId,
    removeParents: (src.parents || []).join(","),
    fields: "id,name,driveId,parents",
    supportsAllDrives: true,
  });

  return {
    ok: true,
    alreadyMoved: false,
    movedId: data.id,
    landedInDrive: data.driveId === config.driveSharedDriveId,
  };
}

module.exports = { inspect, moveToSharedDrive, ROOT_FOLDER_NAME };
