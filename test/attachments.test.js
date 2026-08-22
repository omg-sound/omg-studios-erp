"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { detectMimeFromBuffer, detectMimeFromFile } = require("../src/lib/attachments");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const FAKE = Buffer.from("<svg onload=alert(1)>", "utf8");

test("detectMimeFromBuffer: PNG·JPEG·PDF 매직바이트를 인식하고, 그 외는 null(스푸핑 차단)", () => {
  assert.equal(detectMimeFromBuffer(PNG), "image/png");
  assert.equal(detectMimeFromBuffer(JPEG), "image/jpeg");
  assert.equal(detectMimeFromBuffer(PDF), "application/pdf");
  assert.equal(detectMimeFromBuffer(FAKE), null, "Content-Type을 image/png로 속여도 실제 바이트가 아니면 거부");
  assert.equal(detectMimeFromBuffer(Buffer.alloc(0)), null, "빈 버퍼");
  assert.equal(detectMimeFromBuffer(null), null, "null 안전");
});

// ── 2026-08-22 감사: settings.routes.js가 별도 매직바이트 구현을 두고 있었다(판정 방향도 반대) ──
// 이제 lib/attachments.detectMimeFromFile(파일 경로)이 detectMimeFromBuffer에 위임하는지 확인.
test("detectMimeFromFile: 파일 경로 버전도 같은 판정을 준다(detectMimeFromBuffer 위임)", () => {
  const tmp = path.join(os.tmpdir(), `attach-test-${Date.now()}.bin`);
  fs.writeFileSync(tmp, PNG);
  try {
    assert.equal(detectMimeFromFile(tmp), "image/png");
  } finally {
    fs.unlinkSync(tmp);
  }
  assert.equal(detectMimeFromFile("/no/such/file"), null, "존재하지 않는 파일은 null");
});

test("settings.routes.js: 로고 업로드가 lib/attachments의 공용 판정을 쓴다(자체 구현이 되살아나지 않는다)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "settings.routes.js"), "utf8");
  assert.match(src, /require\("\.\.\/lib\/attachments"\)/, "공용 헬퍼에서 가져다 쓴다");
  assert.ok(!/function checkMagicBytes/.test(src), "자체 매직바이트 구현이 되살아나지 않는다");
});
