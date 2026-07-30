---
version: 1
name: OMG Studios ERP — Design System
description: >
  녹음/믹싱 스튜디오 내부 ERP의 디자인 시스템. 흰 캔버스 + 블루 액센트의
  각진 모던 톤(2026-07-30 — 옛 크림·클레이 톤과 팔레트 5종 선택을 폐지하고 단일 테마로
  확정한 뒤, 같은 날 전수 대비 점검으로 색을 AA 통과선까지 짙게 조정).
  **모든 색은 `test/color-contrast.test.js`가 계산으로 잠근다** — 눈이 아니라 수치가 기준이다.
  서버 렌더 HTML + Tailwind 빌드, CSP 인라인 스크립트 0,
  Pretendard 한글 본문. 마케팅 페이지가 아니라 밀도 높은 사내 CRUD(리스트·폼·
  탭·배지·카드) 도구다. 색 토큰은 R G B 채널로 정의(`public/css/src.css`),
  Tailwind가 이름만 연결(`tailwind.config.js`).

# 라이트가 기본 정체성. 다크는 토글(html[data-theme]) 또는 OS 추종. 팔레트 선택 축은 없다(단일 테마).
colors-light:            # 괄호 값 = 최저 대비(페이지·카드·elevated·배지 12% 틴트 중 최소). 전부 AA 4.5 이상.
  bg: "#FFFFFF"        # 흰 캔버스(사용자 결정 — 회색 캔버스 시도 후 되돌림, 아래 Overview 참조)
  surface: "#FFFFFF"   # 카드·표 = 페이지와 같은 흰색. 경계는 보더가, hover는 전경색 오버레이가 만든다
  elevated: "#F0F1F2"  # 펼침·드로어·설정 분류 헤더 — surface와 반드시 달라야 한다
  border: "#D8D9DB"    # 장식 경계(카드·구분선)
  border-strong: "#949596"  # 폼 컨트롤 경계 전용(.input) — WCAG 1.4.11 비텍스트 3.00:1
  muted: "#6B6B6B"     # 본문 보조 (4.55) — 하한, 더 밝히지 말 것
  fg: "#111111"        # near-black 본문 (14.58)
  primary: "#0066CC"   # 블루 — 주요 CTA·브랜드 액센트 전용 (4.68)
  primary-fg: "#FFFFFF"     # 흰 글자 on primary = 5.57
  success: "#0F7034"   # 완료·긍정 상태 (5.20)
  warning: "#8F6200"   # 경고·예약됨 (4.56)
  danger: "#C62828"    # 레드 — 미수·삭제·오류 (4.64). 액센트를 파랑으로 바꿔도 위험은 빨강
  info: "#00648F"      # 정보/중립 강조 (5.42)
  chart-revenue: "#0066CC"  # 매출 막대(비텍스트 3:1 — 5.23)
  chart-profit: "#0F7034"   # 순이익 막대 (5.83)

colors-dark:            # 🔒 media(prefers-color-scheme)와 html[data-theme="dark"] **두 곳에 복제** — 함께 고칠 것
  bg: "#111111"
  surface: "#1E1E1E"
  elevated: "#2A2A2A"
  border: "#383838"
  border-strong: "#6E6E6E"  # 폼 컨트롤 경계 (3.27)
  muted: "#B0B0B0"     # (6.09)
  fg: "#F5F5F5"        # (10.76)
  primary: "#3D9BFF"   # (4.88) — 옛 #0A84FF는 배지 4.00·elevated 3.94 미달
  primary-fg: "#111111"     # ⚠️밝은 파랑 채움 위에서 4.5를 넘는 글자는 어두운 쪽뿐(#111 6.59 / 흰색 3.18)
  success: "#4CB782"   # (5.49)
  warning: "#F2C94C"   # (7.97)
  danger: "#F27272"    # (4.96) — 옛 #EB5757은 배지 4.15 미달
  info: "#64BEFF"      # (6.55)
  chart-revenue: "#4DA3FF"  # (7.19)
  chart-profit: "#4CB782"   # (7.56)

typography:
  sans: 'Pretendard, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif'   # 본문·UI·제목 전부(한글 최적)
  serif: "없음 — var(--font-sans) 별칭(2026-07-30 세리프 톤 폐지). Tailwind font-serif 호환용."
  scale: "Tailwind text-* 유틸 사용(고정 스케일 미문서화 — Known Gaps 참조). 금액·시간은 .tabular(tabular-nums)."
  weight: "본문 400, 라벨·강조 500. .font-display 제목은 700(unlayered 규칙이 유틸리티보다 우선)."

radius:  # 각지게(2026-07-29 tailwind 스케일 + 2026-07-30 --radius-* 토큰까지) — render.com 톤
  md: "0.1875rem # rounded-md — 배지"
  lg: "0.25rem   # rounded-lg — 버튼·입력"
  xl: "0.375rem  # rounded-xl — 카드·리스트 카드"
  full: "유지     # 초성 레일·아바타 등 의도적 원형"

spacing:
  scale: "Tailwind 기본 스케일(4px 기반). 카드 간격 space-y-2, 폼 필드 gap-2~3."
  container: "max-w-3xl(기본) / layout({full:true})=전폭. 콘텐츠 패딩 px-4 py-6 sm:px-6."
  full-bleed: "-mx-4 sm:-mx-6 로 콘텐츠 패딩 상쇄(캘린더 등 화면 끝까지)."

components:
  btn: ".btn 베이스 + .btn-primary(블루 채움) / .btn-ghost(테두리+surface). 크기 .btn-sm / .btn-xs(≥36px)."
  input: ".input / .label / .label-sm. 모바일 16px(iOS 자동확대 방지)."
  card: ".card(rounded-xl border bg-surface p-5 + 은은한 그림자)."
  list-card: "리스트 항목 카드 = rounded-xl border-border/60 bg-surface + .row-link, 카드 간 space-y-2."
  badge: ".badge(whitespace-nowrap shrink-0) + 변형 neutral/primary/success/warning/danger/info(bg-*/12 tint + text-*)."
  row-link: ".row-link — 클릭 가능한 행/카드(hover:bg-elevated/60 active:bg-elevated). 터치엔 hover 없어 active: 필수."
  helpers-js: "src/views.js: listGroup·listRow·emptyState·tabBar·searchBox(typeahead)·explain(접기)·pageHeader."
---

# OMG Studios ERP — Design System

> AI 에이전트/개발자가 UI를 만들 때 읽는 단일 명세. 색·정체성은 **현행 그대로**(위 프론트매터가 진실원천). 이 파일은 흩어진 규칙을 한 장으로 증류한 것. 토큰/클래스 변경 시 이 파일도 갱신.

## Overview

**흰 캔버스(`#FFFFFF`) + 블루 액센트(`#0066CC`)** 의 각진 모던 톤. 파랑은 **주요 CTA와 브랜드 액센트에만** 아껴 쓴다.

> 🎨 **바탕은 흰색이다 — 회색 캔버스는 하루 시도한 뒤 되돌렸다**(2026-07-30 사용자 판단 '바탕은 흰색이 깔끔하다'). 회색 페이지는 카드를 떠 보이게 했지만, **`bg-bg`(페이지색)를 카드 안쪽 채움으로 쓰는 관용구**(설정 화면의 분류 헤더·항목 행 등)와 겹쳐 화면이 얼룩덜룩해졌다. 그래서 **깊이는 톤이 아니라 보더 + hover 오버레이**가 만든다:
> - 목록 행 hover = `.row-link`의 **전경색 6% 오버레이**(`hover:bg-surface`는 흰 위에 흰이라 무효 — 새로 쓰지 말 것. `color-contrast.test.js`가 막는다)
> - 회색 톤(`elevated`)은 **한 겹만**, 구조가 꼭 필요한 자리에만(펼침 바닥·모바일 드로어·설정 분류 헤더). 겹쳐 쓰면 그 얼룩이 돌아온다. 상태색(성공=그린, 경고=앰버, 위험=레드, 정보=시안블루)은 브랜드 파랑과 **명확히 분리**한다 — 특히 **위험은 파랑으로 바꾸지 않는다**(삭제·경고 신호가 죽는다).

> **테마는 하나다**(2026-07-30 사용자 결정). 옛 팔레트 선택 5종(Linear/Apple/Spotify/Pinterest/Claude)과 크림·클레이 정체성은 폐지됐고, 남은 시각 축은 **라이트/다크뿐**이다. 되살릴 후보가 아니다 — 새 색·모서리 톤은 `:root` 한 곳에서 조정한다.

이 앱은 **마케팅 페이지가 아니다.** 히어로·풀블리드 밴드·64px 세리프 헤드라인 같은 랜딩 어휘는 쓰지 않는다. 실제 화면은 리스트·폼·탭·배지·카드로 이뤄진 밀도 높은 업무 도구다.

## Colors

- **역할 토큰**(`--color-*`, R G B 채널) → Tailwind 이름(`bg`/`surface`/`elevated`/`border`/`muted`/`fg`/`primary`/`primary-fg`/`success`/`warning`/`danger`/`info`).
- **뷰 코드에 hex 인라인 금지** — 항상 토큰 이름(`bg-surface`, `text-muted`, `bg-primary`, `text-success`…). **유일 예외**: `<meta name="theme-color">`(CSS 변수 불가라 hex가 유일한 방법, 라이트 `#f7f8f8`·다크 `#111111`).
- **라이트가 기본 정체성.** 다크는 `html[data-theme]`(수동 토글) 또는 `[data-theme]` 없을 때 OS 추종. OS가 다크여도 `data-theme="light"`로 라이트 유지 가능.
- 🔒 **새 색은 '배지에서 4.5를 넘는가'로 고른다.** 배지(`badge-*`)는 12% 틴트 위에 **같은 색 글자**를 얹어 대비가 가장 낮은 자리이고, 틴트가 색상을 품어 **알파를 낮춰도 살아나지 않는다**(12%→6%에서도 3.4~4.05). 그 지점을 넘기면 페이지·카드·elevated는 자동으로 통과한다.
- `muted`는 **AA 하한** 이다. 더 밝히지 말 것.
- **폼 컨트롤 경계만 `border-strong`**(3:1, WCAG 1.4.11) — 카드·구분선의 장식 경계는 `border`를 쓴다(전부 짙게 하면 화면이 선으로 뒤덮인다).
- **차트 막대는 전용 토큰**(`--chart-*`)이다. `primary`/`success`를 직접 참조하지 말 것 — 액센트를 조정할 때 두 막대가 같은 색으로 수렴해 매출↔순이익 구분이 죽는다.
- ⚠️ **CSS 주석 안에 Tailwind 불투명도 표기(별표+슬래시+숫자)를 쓰지 말 것** — 그 두 글자가 주석을 조기 종료해 `build:css`가 깨진다(2026-07-30 실제로 겪음).
- 배지 색 변형은 `bg-*/12` 불투명도를 쓰므로 `tailwind.config.js`의 `opacity.12`가 반드시 있어야 함(없으면 빌드에서 클래스 제거됨).

## Typography

- **한 벌의 산세리프(Pretendard)** 가 본문·UI·제목 전부. 한글 렌더가 핵심이라 Pretendard 우선, Helvetica/Arial/system-ui 폴백.
- **세리프는 폐지**(2026-07-30) — `.font-display`도 sans에 굵기 700·자간 -0.01em으로 제목 신호를 준다. 구글 폰트 링크(Inter·Source Serif 4)도 함께 제거했다(렌더 차단 요청 감소).
- 금액·시간 등 자리 맞춤이 필요한 숫자는 `.tabular`(tabular-nums).
- 한글은 CJK 기본 줄바꿈이 글자 사이 아무데서나 끊어 단어를 찌그러뜨린다 → 줄바꿈되는 텍스트 청크에 **`break-keep`(word-break:keep-all)** 을 붙여 공백에서만 접히게 한다.

## Layout

- 콘텐츠 폭: 기본 `max-w-3xl`, 필요 시 `layout({full:true})`로 전폭. 패딩 `px-4 py-6 sm:px-6`.
- 화면 끝까지(full-bleed) 필요 시 `-mx-4 sm:-mx-6`로 콘텐츠 패딩 상쇄(캘린더 그리드 등).
- 사이드바는 `elevated` 표면 + 운영/청구/관리 그룹, 좌측 레일 활성표시.

## Elevation & Shapes

- 그림자는 **거의 쓰지 않는다.** `.card`만 2겹 그림자(`0 1px 3px /.06`, `0 8px 24px /.08` — `--shadow-card`). 페이지와 카드가 같은 흰색이라 카드 경계는 **보더 + 이 그림자**가 만든다(사용자가 톤 대신 이 조합을 택했다 — Overview 참조).
- 라운드 스케일: 배지 `rounded-md`, 버튼·입력 `rounded-lg`, 카드·리스트 카드 `rounded-xl`. **값은 2026-07-29에 한 단계씩 각지게 낮췄다**(render.com 톤) — 클래스 이름은 그대로고 `tailwind.config.js`의 `borderRadius` 스케일만 바꿨다(마크업의 `rounded-lg` 126곳을 건드리지 않으려고). **2026-07-30에 `:root`의 `--radius-*` 토큰까지 같은 톤으로 낮춰**(버튼 4px·카드 6px·배지 3px) 팔레트 잔재였던 pill 버튼·16px 카드를 없앴다.
- **모바일 edge-to-edge**(<640px): `.card`·`.inv-table-wrap`이 페이지 좌우 패딩(1rem)을 음수 마진으로 상쇄해 **화면 폭을 꽉 채우고** 좌우 보더·모서리를 없앤다(위아래 선만). ⚠️제외 3종 — 중첩 카드, 마스터-디테일 왼쪽 목록, **모바일에서도 다열인 그리드**(`grid-cols-2/3/4`, 안 빼면 셀이 넘쳐 카드끼리 겹친다).

## Components

- **버튼**: `.btn-primary`(블루 채움, 주요 동작·저장), `.btn-ghost`(테두리+surface, 보조). 크기 `.btn-sm`/`.btn-xs`. 블루 채움은 **주요 동작에만** — 완료·상태 토글 등에는 쓰지 않는다(§ Do/Don't).
- **입력/폼**: `.input`, `.label`, `.label-sm`. dirty 저장 패턴(`data-dirty-form`/`data-dirty-save`) + 이탈 가드(미저장 시 저장/저장하지 않음 모달).
- **카드**: `.card`. **두 리스트 스타일이 의도적으로 공존**: (a) **개별 카드** = `rounded-xl border-border/60 bg-surface` + `.row-link`, 카드 간 `space-y-2` — **프로젝트·일정·청구**(항목 하나하나가 독립 개체·상태 처리 접기 등 풍부); (b) **그룹 카드**(`listGroup` = 한 판 + `divide-y`) — **클라이언트·연락처**(이름 위주 얇은 행, 밀도 우선). 새 목록은 항목이 개체성/펼침을 가지면 (a), 단순 명부면 (b).
- **배지**: `.badge` + 변형(neutral/primary/success/warning/danger/info). 공백 라벨이 쪼개지지 않게 `whitespace-nowrap shrink-0`.
- **탭/필터**: `tabBar`(aria-current, 개수 라벨) — 목록 상단 분류(진행중/완료, 발행필요/발행완료 등).
- **검색**: `searchBox`(typeahead — 200ms 디바운스, `/suggest` JSON, ↑↓·엔터, 한글 IME 가드).
- **클릭 어포던스**: 클릭 가능한 행·카드에 `.row-link`. 터치엔 hover가 없으니 반드시 `active:` 눌림 피드백을 함께.
- **예약 슬롯**: 이미 찬 슬롯은 비활성 회색 대신 `.slot-busy`(앰버, 선택 가능·확인 후 등록).

## Do's and Don'ts

### Do
- **완료·긍정 상태 = `success`(그린)** 흐름. 완료 토글은 켜짐=`bg-success/10 text-success border-success/40`, 꺼짐=ghost+`text-success`+`−`, 켜짐=`✓`(세션·청구 상태 공통).
- **`primary`(블루)는 저장·주요 CTA에만** 아껴 쓴다.
- 리스트 행은 좁은 화면 찌그러짐 방지로 **제목 전폭 → 배지 줄(`flex flex-wrap gap-1`) → 메타** 순으로 쌓는다.
- 상태·분류는 알맞은 `badge-*` 색으로(성공/경고/위험/정보 구분).
- 새 색이 필요하면 먼저 **기존 역할 토큰**으로 표현할 수 있는지 본다.

### Don't
- **완료/토글 같은 상태 버튼에 `btn-primary`(블루) 쓰지 말 것** — 너무 강하고 "저장/주요 기능" 신호와 충돌. 완료엔 그린 성공 흐름.
- **위험·삭제를 파랑으로 칠하지 말 것** — 액센트가 파랑이 됐어도 `danger`는 빨강이다.
- 팔레트(`data-palette`)·테마 스와치를 되살리지 말 것. **테마는 하나다.**
- **회색 톤을 겹쳐 쌓지 말 것**(페이지 + 카드 안 채움 + 행 채움) — 얼룩덜룩해진다. 톤은 한 겹만.
- `hover:bg-surface`를 쓰지 말 것 — 흰 바탕에서 무효다. 행 hover는 `.row-link`.
- `muted`를 AA 아래로 밝히지 말 것.
- hover 전용 어포던스를 `active:` 없이 넣지 말 것(터치 미대응).
- 뷰에 hex를 인라인하지 말 것(토큰 이름만).
- 인라인 `<script>`/`<style>` 금지(CSP). JS는 `public/js/app.js`에 위임 방식으로.

## Responsive

- 브레이크포인트: Tailwind `sm=640px`. **모바일=`< 640px`.**
- 모바일 폼 컨트롤 **16px**(iOS 자동확대 방지, `src.css` 미디어쿼리).
- **터치 타깃 ≥44px**(모바일 전용 미디어 — `.btn`·`.row-link`·`[role=listbox]>button`). 데스크톱 밀도는 현행 유지.
- 검증법: 오프스크린 `<iframe width=390>`에 페이지 로드 → `scrollWidth - clientWidth == 0`(가로 오버플로우 0). Chrome 최소창폭(500px)을 우회해 320~430px 실측.
- 모달 열리면 배경 스크롤 잠금(공통 IIFE, MutationObserver).

## Tech Guardrails

- **서버 렌더 HTML**(`src/views*.js`) + 클래식 폼 POST + 최소 JS(`public/js/app.js`).
- **Tailwind CLI 빌드**: `public/css/src.css`(소스) → `app.css`. 컴포넌트 클래스는 `@layer components`. 색·컴포넌트 바꾸면 **`npm run build:css`** 필수.
- **CSP**: 인라인 스크립트 0. 콤보 옵션 등은 `<script type="application/json">` 정적 임베드로 전달.
- 정적 자산 캐시 버스팅 `?v=`(mtime+size).
- 테마: `html[data-theme]` + localStorage·쿠키 토글, 라이트 기본(OS 추종). 서버가 첫 페인트에 `data-theme` 렌더(FOUC 방지). `theme-color` 다크 대응.

## Iteration Guide

1. 색은 **역할 토큰**으로만(`bg`/`surface`/`primary`/`success`…) — hex 인라인 금지.
2. 새 재사용 컴포넌트는 `src.css @layer components`에 `.class` 추가 후 `build:css`.
3. 상태 신호는 **성공=그린 / 주요=블루 / 경고=앰버 / 위험=레드 / 정보=시안블루** 역할을 지킨다.
4. 한글 줄바꿈 청크엔 `break-keep`, 짧은 단위(금액·상태)엔 `whitespace-nowrap`.
5. 목록·탭·빈상태는 공용 헬퍼(`listRow`/`tabBar`/`emptyState`) 재사용 — 새로 만들지 말 것.
6. 토큰/클래스/가드레일이 바뀌면 **이 파일과 `CLAUDE.md`를 함께 갱신**(드리프트 방지).

## Known Gaps

- **고정 타입 스케일 미문서화** — 현재 Tailwind `text-*`를 상황별로 씀(일관성은 리뷰로 보완). 필요 시 명명 스케일 도입 검토.
- **명명된 elevation 스케일 없음** — `.card` 그림자 1종 외에는 border/surface 대비로만.
- 폰트는 CDN 로드(Pretendard jsdelivr, CSP 허용) — 오프라인/서브셋 최적화는 향후.
- 애니메이션·트랜지션 타이밍 시스템은 범위 밖(개별 `transition-colors` 정도).
