"use strict";

// ── 테마 서버 렌더(FOUC 방지) 회귀 잠금(2026-07-21) ──
// 다크 사용자가 페이지 이동 시 라이트로 첫 페인트됐다 다크로 바뀌는 깜빡임을 없애려고,
// 쿠키를 요청 컨텍스트(AsyncLocalStorage)로 흘려 layout()이 <html>에 첫 페인트로 렌더한다.
// 이 계약이 깨지면(속성 누락·잘못된 기본값) 깜빡임이 조용히 되살아난다.
// 팔레트(data-palette) 축은 2026-07-30 폐지 — theme 하나만 흘린다.
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert");
const { runWithTheme, currentThemeAttrs } = require("../src/lib/request-theme");
const { layout } = require("../src/views");

test("컨텍스트 없음(테스트·정적) = 테마 미설정(OS 추종을 CSS에 위임)", () => {
  assert.deepEqual(currentThemeAttrs(), { theme: null });
});

test("쿠키 값 반영: theme", () => {
  runWithTheme({ theme: "dark" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: "dark" });
  });
  runWithTheme({ theme: "light" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: "light" });
  });
});

test("모르는 값 방어: 테마는 무시(null)", () => {
  runWithTheme({ theme: "weird" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: null });
  });
});

test("옛 palette 쿠키가 남아 있어도 무시(속성 렌더 없음)", () => {
  runWithTheme({ theme: "dark", palette: "spotify" }, () => {
    assert.deepEqual(currentThemeAttrs(), { theme: "dark" });
    const html = layout({ title: "T", user: null, body: "" });
    assert.ok(!/data-palette/.test(html), "<html>에 팔레트 속성 없음");
  });
});

test("layout(): 컨텍스트 밖은 속성 없음(<html lang=\"ko\">)", () => {
  const html = layout({ title: "T", user: null, body: "" });
  assert.match(html, /<html lang="ko">/);
});

test("layout(): 다크 쿠키면 <html>에 data-theme=dark 렌더(첫 페인트 다크)", () => {
  runWithTheme({ theme: "dark" }, () => {
    const html = layout({ title: "T", user: null, body: "" });
    assert.match(html, /<html lang="ko" data-theme="dark">/);
  });
});
