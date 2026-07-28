# PDF 번들 폰트

`public/fonts/NotoSansKR-{Regular,Bold}.ttf` — 거래명세서 PDF(PDFKit)가 임베드하는 폰트.
파일명은 레거시(`NotoSansKR-*`)지만 실제 내용은 아래처럼 **Noto Sans CJK KR**(pan-CJK 전체 빌드)이다.

## 왜 이 폰트인가
한글·라틴만 담긴 옛 서브셋은 **일본어 가나·한자 글리프가 없어** PDF에서 그 글자가 통째로 사라졌다(2026-07-28 1차 수정).
처음엔 `Sans/Variable/TTF/Subset/NotoSansKR-VF.ttf`(한글권 상용 한자 위주로 줄인 축소판)로 교체했는데,
이 축소판도 **일본어 전용 상용한자 일부가 빠져 있어**(실측: `録`=U+9332 — 육안 검증 중 발견, 자동 커버리지
검사는 `漢`·`峠` 등 표본만 봐서 못 잡았다) 같은 증상이 재발했다. → **`Sans/Variable/TTF/NotoSansCJKkr-VF.ttf`**
(서브셋 아닌 pan-CJK 전체 빌드, 한중일 통합 한자 전체 + 한글 선호 자형)로 다시 교체(2026-07-28 2차 수정)해
해소했다. 소스 파일이 훨씬 크지만(VF 36MB) PDFKit이 문서에 실제로 쓰인 글자만 서브셋해 임베드하므로
**PDF 자체는 여전히 10~20KB 안팎**이다(용지 크기는 실제 폰트 파일 크기와 무관).

⚠️ **폰트 교체 시 글리프 누락은 오류 없이 조용히 사라진다** — ToUnicode 매핑 자체가 안 생기거나(문자가 통째로
빠짐) `.notdef` 빈 상자로 자리만 차지한다. 표본 몇 글자(`가`·`あ`·`ア`·`漢`·`₩`)만 확인하는 커버리지 검사로는
안심할 수 없다 — 실제 사용할 법한 문자열(고객·거래처 이름에 쓰일 만한 한자 포함)로 PDF를 만들어 **육안으로도**
확인할 것.

## 재생성 절차(1회성 개발 작업 — 런타임 의존성 아님)
```bash
python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
curl -sL -o /tmp/NotoSansCJKkr-VF.ttf "https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/NotoSansCJKkr-VF.ttf"
/tmp/fontvenv/bin/fonttools varLib.instancer --update-name-table /tmp/NotoSansCJKkr-VF.ttf wght=400 -o public/fonts/NotoSansKR-Regular.ttf
/tmp/fontvenv/bin/fonttools varLib.instancer --update-name-table /tmp/NotoSansCJKkr-VF.ttf wght=700 -o public/fonts/NotoSansKR-Bold.ttf
```
⚠️ **`--update-name-table` 필수**: 이게 없으면 variable font instancer가 name 테이블의 PostScript명(nameID 6)에
가변축 기본 인스턴스명(예: `NotoSansKR-Thin`)을 그대로 물려준다 — Family/Subfamily는 맞게 나와 렌더는 정상이지만
PDF의 `/BaseFont`가 이 잘못된 PostScript명을 쓰게 된다(2026-07-28 발견·교정). 재생성 후 PostScript명이
`NotoSansCJKKR-Regular`/`NotoSansCJKKR-Bold`로 나오는지 확인할 것(`fontTools.ttLib.TTFont(f)['name'].getDebugName(6)`).

라이선스: SIL Open Font License 1.1 (임베드 자유).
