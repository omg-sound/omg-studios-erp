"use strict";

// ── 색 대비 회귀 잠금(2026-07-30, 설계=docs/superpowers/specs/2026-07-30-color-system-accessibility-design.md) ──
// 팔레트가 폐지돼 색 축이 하나가 되면서 **전수 계산이 가능해졌다**. 그래서 톤을 조정할 때마다 사람이 다시
// 재는 대신, src.css의 토큰을 파싱해 대비를 직접 계산하고 기준 미달을 여기서 막는다.
//
// 🔒 이 파일이 지키는 세 가지:
//   ① 텍스트 색 7종이 **네 자리 전부**(페이지·카드·elevated·배지 틴트)에서 AA 4.5 이상 — 라이트·다크 양쪽
//   ② 폼 컨트롤 경계(--color-border-strong)가 WCAG 1.4.11의 3:1 이상
//   ③ 다크 토큰 **두 벌**(@media 추종 / [data-theme="dark"] 강제)이 정확히 일치 — 한쪽만 고치면 OS 다크
//      사용자에게 옛 색이 남는데, 그건 눈으로는 잡히지 않는 종류의 결함이다.
//
// ⚠️ 배지가 언제나 최저값이다: `bg-*/12` 틴트 위에 **같은 색 글자**를 얹는 구조라 틴트가 색상을 품어
//    글자와의 거리가 줄지 않는다(알파를 낮춰도 안 살아난다 — 글자색을 짙게 하는 것이 유일한 해법).
//    그래서 새 색을 고를 때는 '배지에서 4.5를 넘는가'만 보면 나머지는 자동으로 통과한다.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC_CSS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "src.css"), "utf8");

const BADGE_ALPHA = 0.12; // .badge-* 변형이 쓰는 bg-*/12
const AA_TEXT = 4.5; // WCAG 1.4.3 본문
const NON_TEXT = 3.0; // WCAG 1.4.11 UI 컴포넌트 경계

/** `--color-x: R G B;` 선언을 블록 문자열에서 뽑아 {name: [r,g,b]}로. */
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--(color-[a-z-]+|chart-[a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

/** 여는 중괄호 위치에서 시작해 짝이 맞는 닫는 중괄호까지(중첩 @media 대응). */
function blockAt(css, fromIndex) {
  const open = css.indexOf("{", fromIndex);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("닫히지 않은 블록");
}

function relLuminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 알파 합성(틴트) — 배지 배경 계산용. */
function composite(fg, bg, alpha) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

// :root(라이트) = 파일 첫 `:root {` 블록. 다크 두 벌은 각자의 선택자로.
const LIGHT = tokens(blockAt(SRC_CSS, SRC_CSS.indexOf(":root {")));
const DARK_MEDIA = tokens(blockAt(SRC_CSS, SRC_CSS.indexOf(":root:not([data-theme]) {")));
const DARK_FORCED = tokens(blockAt(SRC_CSS, SRC_CSS.indexOf(':root[data-theme="dark"] {')));

const TEXT_ROLES = ["color-fg", "color-muted", "color-primary", "color-success", "color-warning", "color-danger", "color-info"];
const SURFACES = ["color-bg", "color-surface", "color-elevated"];

for (const [label, T] of [["라이트", LIGHT], ["다크", DARK_FORCED]]) {
  test(`${label}: 텍스트 7색 × (페이지·카드·elevated·배지) 전부 AA ${AA_TEXT} 이상`, () => {
    for (const role of TEXT_ROLES) {
      assert.ok(T[role], `${label} ${role} 토큰 존재`);
      for (const surf of SURFACES) {
        const v = contrast(T[role], T[surf]);
        assert.ok(v >= AA_TEXT, `${label} ${role} on ${surf}: ${v.toFixed(2)} < ${AA_TEXT}`);
      }
      // 배지: 같은 색 12% 틴트를 카드 표면 위에 합성한 배경 + 같은 색 글자(최저값 자리).
      const tint = composite(T[role], T["color-surface"], BADGE_ALPHA);
      const badge = contrast(T[role], tint);
      assert.ok(badge >= AA_TEXT, `${label} badge(${role}): ${badge.toFixed(2)} < ${AA_TEXT} — 색을 더 짙게(라이트)/밝게(다크)`);
    }
  });

  test(`${label}: 주요 버튼 채움(primary-fg on primary) AA ${AA_TEXT} 이상`, () => {
    const v = contrast(T["color-primary-fg"], T["color-primary"]);
    assert.ok(v >= AA_TEXT, `${label} 버튼 글자: ${v.toFixed(2)} < ${AA_TEXT}`);
  });

  test(`${label}: 폼 컨트롤 경계(border-strong) 비텍스트 ${NON_TEXT} 이상`, () => {
    const onCard = contrast(T["color-border-strong"], T["color-surface"]);
    assert.ok(onCard >= NON_TEXT, `${label} border-strong on surface: ${onCard.toFixed(2)} < ${NON_TEXT}`);
  });

  test(`${label}: 페이지와 카드 표면이 서로 다르다(깊이가 보더·그림자에만 의존하지 않게)`, () => {
    assert.notDeepEqual(T["color-bg"], T["color-surface"], `${label} bg와 surface가 같은 값 — 카드 경계가 보더 한 줄에만 걸린다`);
  });

  test(`${label}: 차트 두 막대가 서로 구분되고 배경 위에서 보인다(비텍스트 ${NON_TEXT})`, () => {
    for (const k of ["chart-revenue", "chart-profit"]) {
      const v = contrast(T[k], T["color-bg"]);
      assert.ok(v >= NON_TEXT, `${label} ${k} on bg: ${v.toFixed(2)} < ${NON_TEXT}`);
    }
    // 두 막대가 같은 색으로 수렴하면 매출↔순이익을 구분할 수 없다(2026-07-19 결정의 알맹이).
    assert.notDeepEqual(T["chart-revenue"], T["chart-profit"], `${label} 매출·순이익 막대가 같은 색`);
  });
}

test("🔒 다크 토큰 두 벌(OS 추종 @media / 강제 [data-theme=dark])이 정확히 일치", () => {
  // 복제된 블록이라 한쪽만 고치면 OS 다크 사용자에게 옛 색이 남는다(사람 눈으로 안 잡힘).
  assert.deepEqual(DARK_MEDIA, DARK_FORCED, "다크 토큰 두 블록의 값이 어긋났다 — 양쪽을 함께 고칠 것");
});

test("역할 토큰이 라이트·다크에서 같은 집합(한쪽에만 있는 토큰 없음)", () => {
  const l = Object.keys(LIGHT).sort();
  const d = Object.keys(DARK_FORCED).sort();
  // 라이트에만 있어야 하는 것은 없다 — 다크가 색 토큰을 전부 덮어써야 한다(안 덮으면 라이트 값이 새어 나온다).
  assert.deepEqual(
    l.filter((k) => !d.includes(k)),
    [],
    "다크에서 덮지 않은 색 토큰이 있다(라이트 값이 다크로 새어 나온다)",
  );
});
