/* 테마 조기 적용(FOUC 방지) — <head>에서 CSS보다 먼저 동기 실행(defer 아님).
   저장된 data-theme(light/dark)를 <html>에 즉시 세팅 → 스타일시트가 그 속성 기준으로 렌더돼
   새로고침 시 깜빡임 없음. CSP script-src 'self' 준수(외부 파일).
   ⚠️ 팔레트(시각 스타일 선택) 축은 2026-07-30 폐지 — 테마가 하나(라이트/다크 축만)라 여기서 다룰 게 없다. */
(function () {
  try {
    // 테마(라이트/다크)는 OS 설정 추종(2026-07-18 사용자 요청) — 저장값 있으면 그대로, 없으면 로드 시점 OS 설정을 스냅샷해 data-theme로 세팅.
    // (다크 토큰이 [data-theme="dark"] 속성으로도 게이트돼 있어, 속성을 안 걸면 media 다크가 라이트 강제 블록에 밀릴 수 있다 — 2026-07-19 전수 점검 수정.)
    var t = localStorage.getItem("theme");
    if (t !== "dark" && t !== "light") {
      try { t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e) { t = null; }
    }
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    // 쿠키에 기록 → **다음 페이지부터 서버가 <html>에 첫 페인트로 렌더**(FOUC 방지). 기존 localStorage 사용자도 쿠키 없이 들어와 여기서 맞춰진다.
    // theme 쿠키는 명시 선택(또는 OS 스냅샷) t가 있을 때만. path=/ · 1년 · lax.
    try {
      if (t === "dark" || t === "light") document.cookie = "theme=" + t + "; path=/; max-age=31536000; samesite=lax";
    } catch (e) {}
  } catch (e) {}
})();
