"use strict";

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { renderInvoicePdf } = require("../src/invoice-pdf");

const STUDIO = { studio_biz_name: "오엠지 스튜디오", studio_address: "서울시 용산구", studio_tel: "02-000-0000", studio_biz_no: "123-45-67890", studio_owner_name: "조형우" };
const INV = { invoice_number: "OMG-202607-001", amount: 1100000, tax_amount: 100000, discount_amount: 0, issued_date: "2026-07-28" };
const ITEMS = [{ description: "7월 20일 · 루나 · 보컬녹음", amount: 500000 }, { description: "믹싱", amount: 500000 }];

/**
 * PDFKit은 기본적으로 스트림(폰트 파일·ToUnicode CMap·페이지 콘텐츠)을 FlateDecode로 압축한다(2026-07-28
 * compress:false 제거 — 무압축이면 실제 PDF가 ~3배 커진다). 문자열 스캔 회귀 검증(임베드 폰트·ToUnicode
 * 코드포인트 확인)이 계속 동작하도록, 버퍼 안의 `stream…endstream` 구간을 찾아 inflate해 이어붙인 텍스트를 만든다.
 * FlateDecode가 아니거나 손상된 구간은 조용히 건너뛴다(원본 latin1도 함께 포함해 압축 안 된 부분은 그대로 잡힘).
 */
function decodedText(buf) {
  const raw = buf.toString("latin1");
  let combined = raw;
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const dataStart = m.index + m[0].length;
    let dataEnd = raw.indexOf("endstream", dataStart);
    if (dataEnd === -1) continue;
    if (raw[dataEnd - 1] === "\n") dataEnd--;
    if (raw[dataEnd - 1] === "\r") dataEnd--;
    try {
      combined += "\n" + zlib.inflateSync(buf.slice(dataStart, dataEnd)).toString("latin1");
    } catch (_e) {
      // FlateDecode가 아니거나(이미지 등) 슬라이스 경계 오차 — 이 구간은 건너뛴다.
    }
  }
  return combined;
}

test("renderInvoicePdf: PDF 버퍼 생성(벡터 텍스트) — %PDF 매직·폰트 임베드", async () => {
  const buf = await renderInvoicePdf({ studio: STUDIO, client: { name: "주식회사 뮤직팜" }, invoice: INV, items: ITEMS, logo: null, docType: "거래명세서" });
  assert.ok(Buffer.isBuffer(buf), "Buffer 반환");
  assert.equal(buf.slice(0, 5).toString("latin1"), "%PDF-", "PDF 매직");
  const s = decodedText(buf);
  assert.match(s, /\/Subtype\s*\/(TrueType|Type0)/, "임베드 폰트 존재(벡터 텍스트 — 이미지 전용 PDF가 아님)");
  assert.doesNotMatch(s, /\/Subtype\s*\/Image/, "본문이 이미지로 들어가지 않음(로고 없는 문서)");
});

test("renderInvoicePdf: 일본어·한자·₩가 텍스트로 실제 포함된다(옛 폰트에선 통째로 사라지던 회귀)", async () => {
  const buf = await renderInvoicePdf({
    studio: STUDIO, client: { name: "株式会社ミュージック" },
    invoice: INV, items: [{ description: "録音 · こんにちは · 漢字", amount: 1000000 }], logo: null, docType: "거래명세서",
  });
  const s = decodedText(buf); // ToUnicode CMap도 FlateDecode 스트림 — 압축 해제 후 스캔해야 잡힌다.
  // PDFKit은 ToUnicode CMap을 넣는다 — 원문 코드포인트가 매핑 테이블에 나타나야 한다.
  // PDFKit은 ToUnicode CMap 16진수를 항상 소문자로 낸다(node_modules/pdfkit toHex: num.toString(16), 대문자화 없음)
  // — 대소문자는 매핑 존재 여부와 무관하므로 대소문자 무관 매칭.
  // "録"(U+9332)은 2026-07-28 실측에서 Noto Sans KR "Subset" 빌드(가나+상용한자 위주)에 없어 조용히 사라졌던
  // 실제 글리프(자동 테스트가 아니라 육안 검증 중 발견 — ToUnicode 매핑 자체가 안 생기는 것으로 확인).
  // pan-CJK "Noto Sans CJK KR" 전체 빌드로 교체한 뒤에는 존재해야 한다(회귀 재발 방지).
  const cps = ["ミ", "こ", "漢", "₩", "명", "録"].map((c) => c.codePointAt(0).toString(16).padStart(4, "0").toUpperCase());
  for (const cp of cps) assert.match(s, new RegExp("<" + cp + ">", "i"), `ToUnicode에 U+${cp} 매핑 존재`);
});

test("renderInvoicePdf: 항목이 많으면 여러 페이지(합계는 마지막 페이지)", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ description: `항목 ${i + 1} · 세션 녹음`, amount: 100000 }));
  const buf = await renderInvoicePdf({ studio: STUDIO, client: { name: "다항목사" }, invoice: { ...INV, amount: 4400000, tax_amount: 400000 }, items: many, logo: null, docType: "거래명세서" });
  const n = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(n >= 2, `다중 페이지 생성(실제 ${n})`);
});

test("renderInvoicePdf: 견적서·내역서 문서 유형", async () => {
  for (const t of ["견적서", "내역서", "거래명세서"]) {
    const buf = await renderInvoicePdf({ studio: STUDIO, client: { name: "유형사" }, invoice: INV, items: ITEMS, logo: null, docType: t });
    assert.equal(buf.slice(0, 5).toString("latin1"), "%PDF-", `${t} 생성`);
  }
});

test("renderInvoicePdf: 할인 있는 청구서(과세표준 분기)도 생성된다", async () => {
  const buf = await renderInvoicePdf({
    studio: STUDIO, client: { name: "할인사" },
    invoice: { ...INV, amount: 990000, tax_amount: 90000, discount_amount: 100000 },
    items: ITEMS, logo: null, docType: "거래명세서",
  });
  assert.equal(buf.slice(0, 5).toString("latin1"), "%PDF-");
});
