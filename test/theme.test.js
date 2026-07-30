"use strict";

// 테마 소스 계약 검사 — **단일 테마**(2026-07-30 사용자 결정: 팔레트 5종 폐지, Pinterest 라이트만 남기고
// 액센트를 애플 블루로·모서리를 각지게). 잠그는 것은 ①토큰이 CSS 변수로 추출돼 컴포넌트가 참조한다 ②팔레트
// 축(data-palette·스와치)이 되살아나지 않는다 ③라이트/다크 축과 FOUC 배선은 그대로 산다 — 세 가지다.
// app.css는 빌드 산출물(gitignore)이라 소스(src.css/views.js/app.js/theme-init.js)를 검사한다.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SRC_CSS = R("public/css/src.css");
const VIEWS = R("src/views.js");
const APP = R("public/js/app.js");

// 색의 **역할**만 잠근다 — 정확한 수치·대비는 `color-contrast.test.js`가 계산으로 검사한다.
// (톤 조정마다 이 파일이 깨지지 않게: 2026-07-30 색상 점검에서 값이 한 단 짙어지며 실제로 깨졌다.)
test("단일 테마: 액센트는 파랑 계열, danger는 빨강 계열(역할 유지)", () => {
  const rgb = (name) => {
    const m = new RegExp(`--color-${name}:\\s*(\\d+) (\\d+) (\\d+)`).exec(SRC_CSS);
    assert.ok(m, `--color-${name} 정의`);
    return m.slice(1).map(Number);
  };
  const [pr, pg, pb] = rgb("primary");
  assert.ok(pb > pr && pb > pg, `액센트가 파랑 계열이어야 한다(현재 ${pr} ${pg} ${pb})`);
  const [dr, dg, db] = rgb("danger");
  assert.ok(dr > dg && dr > db, `danger는 빨강이어야 한다 — 액센트를 파랑으로 바꿔도 위험 신호는 빨강(현재 ${dr} ${dg} ${db})`);
  // 옛 팔레트 액센트가 되살아나지 않았는지: Pinterest 레드·Claude 클레이.
  assert.ok(!/--color-primary:\s*230 0 35/.test(SRC_CSS), "Pinterest 레드 액센트 제거");
  assert.ok(!/--color-primary:\s*200 121 91/.test(SRC_CSS), "Claude 클레이 액센트 제거");
});

test("요구사항1: 폰트·radius·shadow가 CSS 변수로 추출됨", () => {
  assert.match(SRC_CSS, /--font-sans:\s*"Pretendard"/, "--font-sans 추출");
  // 값 자체는 톤 조정마다 바뀐다(2026-07-29 각지게, 2026-07-30 단일 테마) — 이 테스트가 잠그는 건
  // **변수로 추출돼 있고 컴포넌트가 참조한다**는 구조지 특정 수치가 아니다.
  assert.match(SRC_CSS, /--radius-card:\s*[\d.]+rem/, "--radius-card 정의");
  assert.match(SRC_CSS, /--radius-btn:\s*[\d.]+rem/, "--radius-btn 정의");
  assert.match(SRC_CSS, /--shadow-card:/, "--shadow-card 추출");
  // 컴포넌트가 변수를 참조
  assert.match(SRC_CSS, /border-radius:\s*var\(--radius-card\)/, ".card가 변수 참조");
  assert.match(SRC_CSS, /box-shadow:\s*var\(--shadow-card\)/, ".card 그림자가 변수 참조");
  assert.match(SRC_CSS, /border-radius:\s*var\(--radius-btn\)/, ".btn이 변수 참조");
});

test("각진 모서리: pill(624rem)·16px 카드가 되살아나지 않음", () => {
  // 옛 Pinterest·Spotify는 --radius-btn을 pill(624.9375rem)로, 카드를 1rem으로 줬다.
  assert.ok(!/--radius-btn:\s*624/.test(SRC_CSS), "pill 버튼 radius 제거");
  const btn = /--radius-btn:\s*([\d.]+)rem/.exec(SRC_CSS);
  const card = /--radius-card:\s*([\d.]+)rem/.exec(SRC_CSS);
  assert.ok(btn && parseFloat(btn[1]) <= 0.25, `버튼 radius 각짐(현재 ${btn && btn[1]}rem)`);
  assert.ok(card && parseFloat(card[1]) <= 0.375, `카드 radius 각짐(현재 ${card && card[1]}rem)`);
});

test("팔레트 축 폐지: data-palette·스와치가 CSS·뷰·app.js·theme-init·서버 배관 어디에도 없음", () => {
  // ⚠️ 폐지 주석에 마커 이름(data-palette·theme-swatch)을 적으면 이 검사에 걸린다 — 경위는 이름 없이 서술할 것.
  for (const [name, src] of [
    ["src.css", SRC_CSS],
    ["views.js", VIEWS],
    ["app.js", APP],
    ["theme-init.js", R("public/js/theme-init.js")],
    ["request-theme.js", R("src/lib/request-theme.js")],
  ]) {
    assert.ok(!/data-palette/.test(src), `${name}: data-palette 제거`);
    assert.ok(!/theme-swatch/.test(src), `${name}: 스와치 제거`);
    assert.ok(!/localStorage\.(get|set)Item\("palette"/.test(src), `${name}: palette 저장 제거`);
  }
});

test("라이트/다크 축은 유지 + FOUC 스크립트 배선(views.js)", () => {
  // 다크 토큰은 두 경로(OS 추종 media + 강제 [data-theme="dark"]) 모두 살아 있어야 한다.
  assert.match(SRC_CSS, /:root:not\(\[data-theme\]\)\s*{/, "OS 추종 다크 블록");
  assert.match(SRC_CSS, /:root\[data-theme="dark"\]\s*{/, "강제 다크 블록");
  assert.match(VIEWS, /data-theme-toggle/, "사이드바 라이트/다크 토글");
  // theme-init.js를 CSS보다 먼저 동기 로드(FOUC 방지, CSP-safe 외부 파일)
  assert.match(VIEWS, /theme-init\.js/, "theme-init 스크립트 로드");
  const initIdx = VIEWS.indexOf('src="/js/theme-init.js');
  const cssIdx = VIEWS.indexOf('rel="stylesheet" href="/css/app.css'); // 실제 head <link>(주석·경로 문자열 제외)
  assert.ok(initIdx > 0 && initIdx < cssIdx, "theme-init가 app.css <link>보다 앞(FOUC 방지)");
});

test("app.js: 라이트/다크 토글 배선(localStorage + 쿠키)", () => {
  assert.match(APP, /data-theme-toggle/, "토글 클릭 처리");
  assert.match(APP, /localStorage\.setItem\("theme"/, "theme 저장");
  assert.match(APP, /setPref\("theme"/, "쿠키 기록(서버 첫 페인트 렌더용)");
});

test("theme-init.js: data-theme 조기 적용(FOUC 방지) + OS 추종", () => {
  const init = R("public/js/theme-init.js");
  assert.match(init, /localStorage\.getItem\("theme"\)/, "저장 theme 읽기");
  assert.match(init, /setAttribute\("data-theme"/, "data-theme 적용");
  // 테마(라이트/다크)는 OS 추종 — 저장값 없으면 로드 시점 OS 설정을 matchMedia로 스냅샷해 data-theme 세팅.
  assert.match(init, /if \(t === "dark" \|\| t === "light"\) document\.documentElement\.setAttribute\("data-theme"/, "저장·스냅샷 theme를 data-theme로 적용");
  assert.match(init, /matchMedia\("\(prefers-color-scheme: dark\)"\)/, "저장값 없으면 OS 설정 스냅샷");
});

test("구글 폰트 링크 제거(단일 테마로 세리프·Inter가 미사용) — Pretendard만 로드", () => {
  assert.ok(!/fonts\.googleapis\.com\/css2/.test(VIEWS), "구글 폰트 스타일시트 링크 없음");
  assert.match(VIEWS, /pretendard-dynamic-subset\.min\.css/, "Pretendard는 유지");
  assert.match(SRC_CSS, /--font-display:\s*var\(--font-sans\)/, "제목 글꼴 = sans");
});
