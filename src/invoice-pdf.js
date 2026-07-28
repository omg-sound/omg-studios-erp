"use strict";

/**
 * 발행 인보이스 → 한국식 거래명세서 A4 PDF.
 * 파이프라인: PDFKit 직접 그리기(**벡터 텍스트**) — 2026-07-28 전환.
 * 옛 파이프라인(SVG → resvg PNG → pdf-lib 이미지 삽입)은 ①글자가 150dpi 비트맵이라 번지고
 * ②번들 폰트에 가나·한자 글리프가 없어 일본어가 통째로 사라졌다. 둘 다 이 전환으로 해소.
 * - 좌표계: PDFKit은 SVG와 같다(원점 좌상단·y 아래로 증가) → 옛 1240×1754 좌표를 그대로 쓰고
 *   페이지에 scale(A4폭/1240)만 걸어 A4로 축소한다. **레이아웃 수치는 옛 코드와 동일**.
 * - 폰트: public/fonts의 Noto Sans CJK KR static(한글·가나·CJK 한자 전체·₩ 커버 — pan-CJK 전체 빌드,
 *   docs/fonts-README.md 참조). PDFKit이 쓰인 글자만 서브셋해 임베드.
 * - 모든 사용자 데이터는 그대로 그린다(SVG 이스케이프 불필요 — 문자열 결합이 아니라 API 호출).
 */

const path = require("path");
const PDFDocument = require("pdfkit");
const { docNumberWithType } = require("./config"); // 문서 유형별 번호(견적서=OMG-EST-…·내역서=OMG-L-…·거래명세서=OMG-…)

const FONT_DIR = path.join(__dirname, "../public/fonts");
const FONT_REGULAR = path.join(FONT_DIR, "NotoSansKR-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "NotoSansKR-Bold.ttf");

const CANVAS_W = 1240; // 옛 SVG 캔버스(좌표 기준) — 수치를 바꾸지 않으려고 유지
const CANVAS_H = 1754;
const A4 = [595.28, 841.89];
const SCALE = A4[0] / CANVAS_W; // 1240 좌표 → A4 pt

/** 정수 → "1,234,000"(로케일 비의존). */
function commas(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function won(n) {
  return "₩" + commas(n);
}

/** 과도하게 긴 값은 말줄임해 컬럼 밖 오버플로를 막는다. */
function truncate(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

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
      const ascent = (doc._font.ascender / 1000) * size;
      doc.text(str, px, y - ascent, { lineBreak: false });
    },
    line(x1, y1, x2, y2, color = "#cfcabb", w = 1) {
      doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w).strokeColor(color).stroke();
    },
    rect(x, y, w, h, { fill = "none", stroke = "#cfcabb", sw = 1, radius = 0 } = {}) {
      if (radius) doc.roundedRect(x, y, w, h, radius);
      else doc.rect(x, y, w, h);
      doc.lineWidth(sw);
      if (fill !== "none" && stroke !== "none") doc.fillColor(fill).strokeColor(stroke).fillAndStroke();
      else if (fill !== "none") doc.fillColor(fill).fill();
      else doc.strokeColor(stroke).stroke();
    },
    image(dataUri, x, y, w, h) {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUri || ""));
      if (!m) return;
      try {
        doc.image(Buffer.from(m[2], "base64"), x, y, { fit: [w, h], align: "right", valign: "top" });
      } catch (_e) {
        /* 로고가 깨져도 문서는 나가야 한다 */
      }
    },
  };
}

/**
 * 내역서(거래명세서) 페이지들을 doc에 직접 그린다(1240×1754 좌표계, scale로 A4에 맞춤).
 * 항목이 한 페이지를 넘으면 여러 페이지로 나눈다(2026-07-10 스케일 점검 — 이전 'MAX_ROWS=22 + 외 N건' 클램프는
 * 실제 페이지 용량(~11행)을 넘어서 12항목부터 합계·납부금액이 페이지 밖으로 잘리고 푸터와 겹치던 잠복 결함).
 * 1페이지 = 타이틀·공급자·로고·청구처 박스 + 표. 이후 페이지 = 축약 헤더 + 표 이어서. 합계·납부금액 = 마지막 페이지(공간 없으면 전용 페이지).
 */
function drawPages(doc, { studio, client, invoice, items, logo, docType }) {
  const W = CANVAS_W;
  const H = CANVAS_H;
  const M = 80;
  const right = W - M;
  const title = docType || "거래명세서";
  const isQuote = title === "견적서";
  const payLabel = isQuote ? "견적 금액" : "납부하실금액";
  const footerText = isQuote
    ? "본 견적서는 참고용이며, 실제 청구 시 금액이 변동될 수 있습니다."
    : `본 ${title}는 참고용이며, 세금계산서는 별도(국세청 홈택스)로 발행됩니다.`;

  // discount_amount > 0이면: 소계(=라인 합산 공급가) → 할인 → 과세표준 → VAT → 합계.
  // discount_amount = 0이면: 기존 소계/VAT/합계 3줄 레이아웃 유지.
  const discountAmt = Math.max(0, invoice.discount_amount || 0);
  const tax = invoice.tax_amount || 0;
  const grand = invoice.amount || 0;
  // 소계(공급가): discount 있으면 라인 합산, 없으면 역산(amount-tax)과 동일. 라인이 없는 수동 인보이스는 역산 기준.
  const lineTotal = items.reduce((s, it) => s + (it.amount || 0), 0);
  const supply = discountAmt > 0 && lineTotal > 0
    ? lineTotal // 할인 있음: 라인 합산(과세표준 = lineTotal - discountAmt)
    : Math.max(0, (invoice.amount || 0) - tax); // 할인 없음: 역산(기존 동작 유지)

  const ROW_H = 60;
  const HEAD_H = 50;
  const footerY = H - 64;
  const rowsEnd = footerY - 40; // 행이 침범하면 안 되는 하한(푸터 위 여유)
  const number = docNumberWithType(invoice.invoice_number, docType) || "—";

  // 표 머리(품목|금액) — 페이지마다 반복.
  const tableHead = (p, y) => {
    p.rect(M, y, W - 2 * M, HEAD_H, { fill: "#f4f3ee", stroke: "none" });
    p.text(M + 18, y + 33, "품목", { size: 18, weight: 700 });
    p.text(right - 18, y + 33, "금액", { size: 18, weight: 700, anchor: "end" });
  };

  // 페이지 헤더: 1페이지=풀 헤더(타이틀·공급자·로고·청구처 박스), 이후=축약(타이틀 소 + 번호).
  function pageHeader(first) {
    if (!first) {
      return {
        draw(p) {
          p.text(M, 100, title, { size: 30, weight: 700 });
          p.text(right, 100, `${number} · 이어서`, { size: 17, color: "#8a8678", anchor: "end" });
        },
        tableY: 150,
      };
    }
    return {
      draw(p) {
        p.text(M, 132, title, { size: 52, weight: 700 });
        p.text(M, 210, studio.studio_biz_name || "공급자", { size: 27, weight: 700 });
        let hy = 250;
        const supplierLines = [
          studio.studio_address,
          studio.studio_tel,
          studio.studio_biz_no ? `사업자등록번호 : ${studio.studio_biz_no}` : "",
          studio.studio_owner_name ? `대표 : ${studio.studio_owner_name}` : "",
        ].filter(Boolean);
        for (const ln of supplierLines) {
          p.text(M, hy, truncate(ln, 54), { size: 18, color: "#6b6b6b" });
          hy += 30;
        }
        if (logo) {
          // 로고를 타이틀(거래명세서)과 같은 높이로 — 우측 상단, 타이틀 상단선에 맞춰 정렬(YMin 앵커).
          p.image(logo, right - 280, 78, 280, 130);
        }
        // 청구처 / 번호·발행일 박스
        const boxY = 440;
        const boxH = 130;
        p.rect(M, boxY, W - 2 * M, boxH, { stroke: "#e2e0d8", sw: 1.5, radius: 10 });
        p.text(M + 26, boxY + 42, "청구처", { size: 17, color: "#8a8678" });
        p.text(M + 26, boxY + 88, truncate(client.name || "—", 28), { size: 26, weight: 700 });
        const metaLabelX = right - 320;
        p.text(metaLabelX, boxY + 42, `${title} 번호`, { size: 17, color: "#8a8678" });
        p.text(right - 26, boxY + 42, number, { size: 19, weight: 600, anchor: "end" });
        p.text(metaLabelX, boxY + 90, "발행됨", { size: 17, color: "#8a8678" });
        p.text(right - 26, boxY + 90, invoice.issued_date || "—", { size: 19, weight: 500, anchor: "end" });
      },
      tableY: 440 + 130 + 60,
    };
  }

  // 합계 블록에 필요한 높이(마지막 페이지에서 확보): 여백 + 합계행들 + 납부하실금액.
  const sumRowsCount = discountAmt > 0 && lineTotal > 0 ? (tax > 0 ? 5 : 4) : (tax > 0 ? 3 : 2);
  const totalsNeed = 56 + sumRowsCount * 44 + 24 + 60;

  // ① 행을 페이지별로 채운다(페이지 용량 = rowsEnd까지). 각 페이지 그리기는 클로저로 모아 마지막에 실행한다.
  const pages = [];
  let idx = 0;
  do {
    const { draw: headDraw, tableY } = pageHeader(pages.length === 0);
    const rowsStart = tableY + HEAD_H;
    let ry = rowsStart;
    const rows = [];
    while (idx < items.length && ry + ROW_H <= rowsEnd) {
      const it = items[idx];
      const label = it.description || [it.track_title, it.task_type].filter(Boolean).join(" - ") || "작업";
      rows.push({ label, amount: it.amount, ry });
      ry += ROW_H;
      idx++;
    }
    pages.push({
      draw(p) {
        headDraw(p);
        tableHead(p, tableY);
        for (const r of rows) {
          p.text(M + 18, r.ry + 38, truncate(r.label, 44), { size: 19, weight: 600 });
          p.text(right - 18, r.ry + 38, won(r.amount), { size: 19, weight: 600, anchor: "end" });
          const lineY = r.ry + ROW_H;
          p.line(M, lineY, right, lineY, "#ece9df");
        }
      },
      ry,
    });
  } while (idx < items.length);

  // ② 합계·납부는 마지막 페이지에 — 남은 공간이 부족하면 전용 페이지 추가.
  let last = pages[pages.length - 1];
  if (last.ry + totalsNeed > rowsEnd) {
    const { draw: headDraw, tableY } = pageHeader(false);
    last = { draw: headDraw, ry: tableY };
    pages.push(last);
  }
  {
    const sumLabelX = right - 360;
    let sy = last.ry + 56;
    const sumRows = [];
    const sumRow = (label, value, bold, color) => {
      sumRows.push({ label, value, bold, color, sy });
      sy += 44;
    };
    if (discountAmt > 0 && lineTotal > 0) {
      // 라인아이템이 있는 청구(from-tasks)에서만 할인 레이아웃 — 수동 인보이스(lineTotal=0, 할인은 표시용)는 소계/VAT/합계로 폴백해 과세표준·VAT·합계 불일치 방지.
      const taxable = supply - discountAmt;
      sumRow("소계(공급가)", won(supply));
      sumRow("할인", "- " + won(discountAmt), false, "#16a34a");
      sumRow("과세표준", won(taxable));
      if (tax > 0) sumRow("VAT (10%)", won(tax)); // 현금(VAT 0)이면 줄 생략
      sumRow("합계", won(grand));
    } else {
      sumRow("소계", won(supply));
      if (tax > 0) sumRow("VAT (10%)", won(tax)); // 현금(VAT 0)이면 줄 생략
      sumRow("합계", won(grand));
    }
    sy += 24;
    const payLineY = sy - 34;
    const paySy = sy;
    const prevDraw = last.draw;
    last.draw = (p) => {
      if (prevDraw) prevDraw(p);
      for (const r of sumRows) {
        const c = r.color || (r.bold ? "#1f1d1b" : "#6b6b6b");
        p.text(sumLabelX, r.sy, r.label, { size: 18, color: c, weight: r.bold ? 700 : 400 });
        p.text(right - 18, r.sy, r.value, { size: 19, weight: r.bold ? 700 : 500, anchor: "end", color: c });
      }
      // 납부하실금액(강조)
      p.line(sumLabelX, payLineY, right, payLineY, "#cfcabb", 1.5);
      p.text(sumLabelX, paySy + 14, payLabel, { size: 27, weight: 700 });
      p.text(right - 18, paySy + 14, won(grand), { size: 31, weight: 700, anchor: "end" });
    };
  }

  // ③ 각 페이지를 실제로 그린다: 페이지 추가 → scale → 본문 → 푸터·페이지 번호.
  pages.forEach((p, i) => {
    doc.addPage({ size: A4, margin: 0 });
    doc.save();
    doc.scale(SCALE);
    const painterObj = painter(doc);
    p.draw(painterObj);
    painterObj.text(M, H - 64, footerText, { size: 15, color: "#9c9688" });
    if (pages.length > 1) painterObj.text(right, H - 64, `${i + 1} / ${pages.length}`, { size: 15, color: "#9c9688", anchor: "end" });
    doc.restore();
  });
}

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
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderInvoicePdf };
