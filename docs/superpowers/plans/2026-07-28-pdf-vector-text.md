# 거래명세서 PDF 벡터 텍스트 전환(PDFKit) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 거래명세서·견적서·내역서 PDF를 저해상도 이미지에서 **벡터 텍스트**로 바꿔 번짐을 없애고, 일본어·한자가 실제로 렌더되게 한다.

**Architecture:** `SVG→PNG(resvg)→pdf-lib 이미지 삽입` 파이프라인을 **PDFKit 직접 그리기**로 교체한다. PDFKit은 SVG와 좌표계가 같고(원점 좌상단, y 아래로 증가) `doc.scale()`을 지원하므로, **레이아웃 좌표·크기·색은 하나도 바꾸지 않고** `text()`/`line()`/`rect()` 세 헬퍼만 "문자열 반환"에서 "doc에 그리기"로 교체한다. 폰트는 CJK를 커버하는 Noto Sans KR static 인스턴스로 교체하고, PDFKit이 문서에 쓰인 글자만 서브셋한다.

**Tech Stack:** Node/Express(기존), `pdfkit`(신규), Noto Sans KR static TTF(OFL), node:test.

**스펙:** `docs/superpowers/specs/2026-07-28-pdf-vector-text-design.md`

## Global Constraints

- **레이아웃 수치 불변**: 캔버스 1240×1754 기준 좌표·폰트 크기·색을 그대로 유지한다(디자인 변경은 범위 밖). 배치가 달라지면 실패로 본다.
- `renderInvoicePdf(data)` 시그니처·반환(Promise<Buffer>) **불변** — 라우트 3곳 무변경이 목표.
- 돈 표기·문서번호·페이지 분할 규칙 등 **기존 도메인 로직 무변경**(옮겨 담기만 한다).
- 폰트 파일명은 `public/fonts/NotoSansKR-Regular.ttf`·`NotoSansKR-Bold.ttf` 유지(내용만 CJK 커버 버전으로 교체).
- PDF 생성은 **메모리에서만**(디스크 임시파일 금지 — PII 최소화, 기존 주석의 원칙).
- `test/guardrails-ui.test.js`의 인라인 style 예외 목록에 `invoice-pdf.js`가 있다 — SVG를 안 쓰게 되므로 **예외를 지울지 검토**하되, 지우면 통과하는지 확인 후에만 지운다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. **배포 금지**(사용자가 시점 결정).

---

### Task 1: 폰트 교체 + 의존성 전환

**Files:**
- Replace: `public/fonts/NotoSansKR-Regular.ttf`, `public/fonts/NotoSansKR-Bold.ttf`
- Modify: `package.json`(+`pdfkit`, −`@resvg/resvg-js`, −`pdf-lib`, −`@pdf-lib/fontkit`), `package-lock.json`
- Create: `docs/fonts-README.md`(폰트 재생성 절차)

**Interfaces:**
- Produces: `require("pdfkit")`가 동작하고, 두 폰트 파일이 한글·가나·한자·₩를 커버한다. Task 2가 이 폰트를 로드한다.

- [ ] **Step 1: 폰트 파일 준비** — 이미 생성된 파일이 `/tmp/keep-fonts/NotoSansKR-Static.ttf`(wght=400)에 있다. Bold는 재생성이 필요하다. 없으면 아래 절차로 만든다(fonttools는 `/tmp/fontvenv/bin`에 설치돼 있고, 없으면 `python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli`):

```bash
cd /tmp && mkdir -p fontbuild && cd fontbuild
curl -sL -o NotoSansKR-VF.ttf "https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/Subset/NotoSansKR-VF.ttf"
/tmp/fontvenv/bin/fonttools varLib.instancer NotoSansKR-VF.ttf wght=400 -o Regular.ttf
/tmp/fontvenv/bin/fonttools varLib.instancer NotoSansKR-VF.ttf wght=700 -o Bold.ttf
```

두 파일을 `public/fonts/NotoSansKR-Regular.ttf`·`NotoSansKR-Bold.ttf`로 **덮어쓴다**.

- [ ] **Step 2: 커버리지 검증** — 덮어쓴 폰트가 실제로 CJK를 커버하는지 확인(이 검증 없이 진행 금지):

```bash
node -e "
const fs=require('fs');
for (const f of ['public/fonts/NotoSansKR-Regular.ttf','public/fonts/NotoSansKR-Bold.ttf']) {
  const b=fs.readFileSync(f);
  const n=b.readUInt16BE(4); let off=null;
  for(let i=0;i<n;i++){const o=12+i*16; if(b.toString('ascii',o,o+4)==='cmap') off=b.readUInt32BE(o+8);}
  const ns=b.readUInt16BE(off+2); let best=null;
  for(let i=0;i<ns;i++){const o=off+4+i*8;const pid=b.readUInt16BE(o),eid=b.readUInt16BE(o+2),so=b.readUInt32BE(o+4);
    const fmt=b.readUInt16BE(off+so); if((pid===3&&(eid===1||eid===10))||pid===0){ if(!best||fmt===12) best={off:off+so,fmt}; }}
  const has=(cp)=>{const{off:o,fmt}=best;
    if(fmt===4){const sx=b.readUInt16BE(o+6),sg=sx/2,eO=o+14,sO=eO+sx+2,dO=sO+sx,rO=dO+sx;
      for(let s=0;s<sg;s++){const e=b.readUInt16BE(eO+s*2); if(cp>e)continue; const st=b.readUInt16BE(sO+s*2); if(cp<st)return false;
        const ro=b.readUInt16BE(rO+s*2); if(ro===0)return ((b.readInt16BE(dO+s*2)+cp)&0xffff)!==0;
        return b.readUInt16BE(rO+s*2+ro+(cp-st)*2)!==0;} return false;}
    if(fmt===12){const c=b.readUInt32BE(o+12);for(let g=0;g<c;g++){const q=o+16+g*12;if(cp>=b.readUInt32BE(q)&&cp<=b.readUInt32BE(q+4))return true;}return false;}
    return false;};
  const t={'가':0xAC00,'あ':0x3042,'ア':0x30A2,'漢':0x6F22,'峠':0x5CE0,'₩':0x20A9,'A':0x41};
  const bad=Object.entries(t).filter(([k,v])=>!has(v)).map(([k])=>k);
  console.log(f, bad.length? 'MISSING: '+bad.join(',') : 'OK(전부 포함)');
}"
```

Expected: 두 파일 모두 `OK(전부 포함)`.

- [ ] **Step 3: 의존성 전환**

```bash
npm install --save pdfkit
npm uninstall @resvg/resvg-js pdf-lib @pdf-lib/fontkit
node -e "require('pdfkit'); console.log('pdfkit OK')"
```

⚠️ `@resvg/resvg-js`는 `optionalDependencies`에 있을 수 있다 — `package.json`에서 잔재를 직접 확인해 제거한다.

- [ ] **Step 4: 폰트 재생성 절차 문서화** — `docs/fonts-README.md` 신규:

```markdown
# PDF 번들 폰트

`public/fonts/NotoSansKR-{Regular,Bold}.ttf` — 거래명세서 PDF(PDFKit)가 임베드하는 폰트.

## 왜 이 폰트인가
한글·라틴만 담긴 옛 서브셋은 **일본어 가나·한자 글리프가 없어** PDF에서 그 글자가 통째로 사라졌다(2026-07-28 수정).
지금 파일은 Noto Sans KR Variable에서 뽑은 static 인스턴스로 한글·가나·CJK 한자·₩를 모두 커버한다.
PDFKit이 문서에 실제로 쓰인 글자만 서브셋해 임베드하므로 **폰트 파일이 커도 PDF는 10KB 안팎**이다.

## 재생성 절차(1회성 개발 작업 — 런타임 의존성 아님)
```bash
python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
curl -sL -o /tmp/NotoSansKR-VF.ttf "https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/Subset/NotoSansKR-VF.ttf"
/tmp/fontvenv/bin/fonttools varLib.instancer /tmp/NotoSansKR-VF.ttf wght=400 -o public/fonts/NotoSansKR-Regular.ttf
/tmp/fontvenv/bin/fonttools varLib.instancer /tmp/NotoSansKR-VF.ttf wght=700 -o public/fonts/NotoSansKR-Bold.ttf
```
라이선스: SIL Open Font License 1.1 (임베드 자유).
```

- [ ] **Step 5: 커밋**

```bash
git add public/fonts package.json package-lock.json docs/fonts-README.md
git commit -m "chore: PDF 폰트를 CJK 커버 버전으로 교체 + pdfkit 도입(resvg·pdf-lib 제거)"
```

---

### Task 2: invoice-pdf.js를 PDFKit 그리기로 재작성

**Files:**
- Rewrite: `src/invoice-pdf.js`
- Test: `test/invoice-pdf.test.js`(신규)

**Interfaces:**
- Consumes: Task 1의 `pdfkit`·폰트 파일.
- Produces: `renderInvoicePdf(data) → Promise<Buffer>`(시그니처 불변). `buildSvg`·`buildSvgPages`·`loadResvg`·`bundledFontFiles`·`svgEsc`는 제거(소비처 0 확인됨 — `buildSvg`는 export돼 있으나 저장소 전체에서 호출 0).

- [ ] **Step 1: 실패하는 테스트 작성** — `test/invoice-pdf.test.js` 신규:

```js
"use strict";

process.env.NODE_ENV = "test";
const { tempDbPath, cleanupDb } = require("./helpers");
process.env.DB_PATH = tempDbPath();

const test = require("node:test");
const assert = require("node:assert");
const { db, init } = require("../src/db");
init();
test.after(() => cleanupDb(process.env.DB_PATH, db()));

const { renderInvoicePdf } = require("../src/invoice-pdf");

const STUDIO = { studio_biz_name: "오엠지 스튜디오", studio_address: "서울시 용산구", studio_tel: "02-000-0000", studio_biz_no: "123-45-67890", studio_owner_name: "조형우" };
const INV = { invoice_number: "OMG-202607-001", amount: 1100000, tax_amount: 100000, discount_amount: 0, issued_date: "2026-07-28" };
const ITEMS = [{ description: "7월 20일 · 루나 · 보컬녹음", amount: 500000 }, { description: "믹싱", amount: 500000 }];

test("renderInvoicePdf: PDF 버퍼 생성(벡터 텍스트) — %PDF 매직·폰트 임베드", async () => {
  const buf = await renderInvoicePdf({ studio: STUDIO, client: { name: "주식회사 뮤직팜" }, invoice: INV, items: ITEMS, logo: null, docType: "거래명세서" });
  assert.ok(Buffer.isBuffer(buf), "Buffer 반환");
  assert.equal(buf.slice(0, 5).toString("latin1"), "%PDF-", "PDF 매직");
  const s = buf.toString("latin1");
  assert.match(s, /\/Subtype\s*\/(TrueType|Type0)/, "임베드 폰트 존재(벡터 텍스트 — 이미지 전용 PDF가 아님)");
  assert.doesNotMatch(s, /\/Subtype\s*\/Image/, "본문이 이미지로 들어가지 않음(로고 없는 문서)");
});

test("renderInvoicePdf: 일본어·한자·₩가 텍스트로 실제 포함된다(옛 폰트에선 통째로 사라지던 회귀)", async () => {
  const buf = await renderInvoicePdf({
    studio: STUDIO, client: { name: "株式会社ミュージック" },
    invoice: INV, items: [{ description: "録音 · こんにちは · 漢字", amount: 1000000 }], logo: null, docType: "거래명세서",
  });
  const s = buf.toString("latin1");
  // PDFKit은 ToUnicode CMap을 넣는다 — 원문 코드포인트가 매핑 테이블에 나타나야 한다.
  const cps = ["ミ", "こ", "漢", "₩", "명"].map((c) => c.codePointAt(0).toString(16).padStart(4, "0").toUpperCase());
  for (const cp of cps) assert.match(s, new RegExp("<" + cp + ">"), `ToUnicode에 U+${cp} 매핑 존재`);
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/invoice-pdf.test.js 2>&1 | tail -15`
Expected: FAIL(아직 PDFKit 미적용 — 이미지 PDF라 폰트·ToUnicode 단언이 깨진다).

- [ ] **Step 3: 재작성** — `src/invoice-pdf.js`. 핵심 골격(레이아웃 본문은 **기존 `buildSvgPages` 코드를 그대로 옮기고** 헬퍼 호출만 바꾼다):

```js
"use strict";

/**
 * 발행 인보이스 → 한국식 거래명세서 A4 PDF.
 * 파이프라인: PDFKit 직접 그리기(**벡터 텍스트**) — 2026-07-28 전환.
 * 옛 파이프라인(SVG → resvg PNG → pdf-lib 이미지 삽입)은 ①글자가 150dpi 비트맵이라 번지고
 * ②번들 폰트에 가나·한자 글리프가 없어 일본어가 통째로 사라졌다. 둘 다 이 전환으로 해소.
 * - 좌표계: PDFKit은 SVG와 같다(원점 좌상단·y 아래로 증가) → 옛 1240×1754 좌표를 그대로 쓰고
 *   페이지에 scale(A4폭/1240)만 걸어 A4로 축소한다. **레이아웃 수치는 옛 코드와 동일**.
 * - 폰트: public/fonts의 Noto Sans KR static(한글·가나·한자·₩ 커버). PDFKit이 쓰인 글자만 서브셋.
 * - 모든 사용자 데이터는 그대로 그린다(SVG 이스케이프 불필요 — 문자열 결합이 아니라 API 호출).
 */

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { docNumberWithType } = require("./config");

const FONT_DIR = path.join(__dirname, "../public/fonts");
const FONT_REGULAR = path.join(FONT_DIR, "NotoSansKR-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "NotoSansKR-Bold.ttf");

const CANVAS_W = 1240;           // 옛 SVG 캔버스(좌표 기준) — 수치를 바꾸지 않으려고 유지
const CANVAS_H = 1754;
const A4 = [595.28, 841.89];
const SCALE = A4[0] / CANVAS_W;  // 1240 좌표 → A4 pt

function commas(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function won(n) { return "₩" + commas(n); }
function truncate(s, n) { const str = String(s == null ? "" : s); return str.length > n ? str.slice(0, n - 1) + "…" : str; }

/** 그리기 헬퍼 묶음 — 옛 text()/line()/rect()와 같은 인자, 반환 대신 doc에 그린다. */
function painter(doc) {
  const font = (weight) => (weight >= 600 ? FONT_BOLD : FONT_REGULAR);
  return {
    text(x, y, s, { size = 22, weight = 400, anchor = "start", color = "#1f1d1b" } = {}) {
      const str = String(s == null ? "" : s);
      doc.font(font(weight)).fontSize(size).fillColor(color);
      const w = doc.widthOfString(str);
      const px = anchor === "end" ? x - w : x;
      // SVG y=베이스라인, PDFKit y=텍스트 상단 → ascender만큼 올린다.
      const ascent = doc._font.ascender / 1000 * size;
      doc.text(str, px, y - ascent, { lineBreak: false });
    },
    line(x1, y1, x2, y2, color = "#cfcabb", w = 1) {
      doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w).strokeColor(color).stroke();
    },
    rect(x, y, w, h, { fill = "none", stroke = "#cfcabb", sw = 1, radius = 0 } = {}) {
      if (radius) doc.roundedRect(x, y, w, h, radius); else doc.rect(x, y, w, h);
      doc.lineWidth(sw);
      if (fill !== "none" && stroke !== "none") doc.fillColor(fill).strokeColor(stroke).fillAndStroke();
      else if (fill !== "none") doc.fillColor(fill).fill();
      else doc.strokeColor(stroke).stroke();
    },
    image(dataUri, x, y, w, h) {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUri || ""));
      if (!m) return;
      try { doc.image(Buffer.from(m[2], "base64"), x, y, { fit: [w, h], align: "right", valign: "top" }); }
      catch (_e) { /* 로고가 깨져도 문서는 나가야 한다 */ }
    },
  };
}
```

그리고 **옛 `buildSvgPages`의 본문을 `drawPages(doc, data)`로 옮긴다**. 옮길 때 규칙:
- `let svg = ""` / `svg += text(...)` → `p.text(...)` 즉시 호출. 단 **페이지 분할 로직은 "그리기를 미루는" 구조여야 하므로**, 각 페이지의 그리기를 **클로저 배열**(`const pageDraws = []; pageDraws.push(() => { ... })`)로 모았다가 마지막에 `doc.addPage()` 후 실행한다(옛 코드가 `pages[].svg` 문자열을 나중에 조립하던 것과 같은 구조).
- `pageHeader(first)`는 `{ draw(p), tableY }`를 반환하도록 바꾼다(옛 `{svg, tableY}`와 대응).
- 로고: 옛 `<image href=... x={right-280} y=78 width=280 height=130 preserveAspectRatio="xMaxYMin meet">` → `p.image(logo, right - 280, 78, 280, 130)`(fit+align:right+valign:top이 같은 의미).
- 청구처 박스의 `rx="10"` → `p.rect(..., { radius: 10 })`.
- 표 머리 배경 `fill="#f4f3ee"`, 배경 흰 사각형은 PDFKit 기본 흰 배경이라 **생략 가능**(옛 `<rect width height fill=#ffffff>`).

렌더 진입점:

```js
/** 거래명세서 PDF 버퍼 생성(메모리, 디스크 임시파일 없음 — PII 최소화). */
function renderInvoicePdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: A4, margin: 0, autoFirstPage: false, info: { Title: data && data.docType ? String(data.docType) : "거래명세서" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      doc.registerFont(FONT_REGULAR, FONT_REGULAR);
      doc.registerFont(FONT_BOLD, FONT_BOLD);
      drawPages(doc, data);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { renderInvoicePdf };
```

⚠️ 각 페이지에서 `doc.addPage()` 직후 `doc.scale(SCALE)`을 걸어 1240 좌표계를 쓴다(`doc.save()`/`restore()`로 감싸도 된다). 페이지 번호·푸터도 같은 좌표계 안에서 그린다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/invoice-pdf.test.js 2>&1 | tail -15`
Expected: 5개 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/invoice-pdf.js test/invoice-pdf.test.js
git commit -m "feat: 거래명세서 PDF를 벡터 텍스트로 전환(PDFKit) — 번짐 해소·일본어/한자 렌더"
```

---

### Task 3: 라우트 정리 + 육안 검증 + 문서

**Files:**
- Modify: `src/routes/projects.routes.js:722-728`, `src/routes/invoices.routes.js:249-255`(PDF_RENDERER_UNAVAILABLE 분기)
- Modify: `test/guardrails-ui.test.js`(인라인 style 예외에서 `invoice-pdf` 제거 검토)
- Modify: `CLAUDE.md`

- [ ] **Step 1: PDF_RENDERER_UNAVAILABLE 분기 제거** — resvg(네이티브 모듈)가 사라져 이 오류가 발생할 경로가 없다. 두 라우트에서 해당 `if (e && e.message === "PDF_RENDERER_UNAVAILABLE") {...}` 블록을 제거하고, 남은 catch가 기존대로 동작하는지 확인한다(에러를 삼키지 말 것 — 기존 처리 방식 유지).

- [ ] **Step 2: 가드 예외 정리** — `test/guardrails-ui.test.js`의 `EXEMPT = /(mailer|invoice-pdf)\.js$/`에서 `invoice-pdf`를 빼고 테스트를 돌린다. 통과하면 유지(더 이상 SVG·인라인 style을 만들지 않으므로), 실패하면 원복하고 이유를 보고서에 적는다.

- [ ] **Step 3: 전체 테스트**

Run: `npm test 2>&1 | tail -5`
Expected: 전부 PASS.

- [ ] **Step 4: 육안 검증(필수)** — 기계 검증으로는 배치가 깨진 걸 못 잡는다. 임시 DB로 실서버를 띄우고(`pkill -f "src/server.js"` 먼저 — 함정 #5) 청구서를 만들어 **3종 PDF를 실제로 받아** macOS Quick Look으로 이미지화해 확인한다:

```bash
qlmanage -t -s 1400 -o /tmp/pdfcheck <파일>.pdf
```

확인 항목: ①제목·공급자·로고 위치 ②청구처 박스 ③표 행·금액 우측 정렬 ④합계 블록(소계/VAT/합계) ⑤납부하실금액 강조 ⑥푸터·페이지 번호 ⑦**항목 40개로 다중 페이지**. 옛 PDF와 배치가 같아야 한다. ⚠️크롬 PDF 뷰어는 스크린샷에 안 잡히므로 쓰지 말 것(기록된 함정).

- [ ] **Step 5: CLAUDE.md 현행화** — Read → Edit(부분 수정, 전체 재작성 금지):
  - '거래명세서 PDF' 항목: 파이프라인을 **PDFKit 벡터 텍스트**로 갱신(옛 resvg+pdf-lib 서술 제거), 번들 폰트가 **CJK 커버**로 바뀐 사실, PDF가 10KB 안팎이고 텍스트 복사·검색이 된다는 점.
  - 스택 표의 PDF 관련 의존성 갱신(+pdfkit, −resvg/pdf-lib). **네이티브 모듈(resvg) 관련 배포 리스크 서술이 있으면 제거**.
  - ⚠️함정 한 줄: **PDF 폰트에 글리프가 없으면 그 글자는 오류 없이 조용히 사라진다**(2026-07-28 일본어 사고) — 폰트 교체 시 커버리지를 반드시 확인.

- [ ] **Step 6: 커밋 + push**

```bash
git add -A
git commit -m "docs: PDF 벡터 전환 현행화 + 죽은 렌더러 분기 제거"
git push -u origin <현재 브랜치>
```

(배포는 하지 않는다.)
