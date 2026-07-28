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
