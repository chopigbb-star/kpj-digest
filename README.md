# KPJ Digest — 대한약사저널 핵심 요약 피드

사이트: https://chopigbb-star.github.io/kpj-digest/

## 동작 방식
- 맥미니 launchd(`~/Library/LaunchAgents/com.kpjdigest.update.plist`)가 4시간마다 `scripts/run-mac.sh` 실행 → 결과를 커밋·푸시하면 GitHub Pages에 반영.
- `scripts/update.mjs`
  1. 약사공론 PDF 서비스의 월별 학술지 목록(`/pdf/ylist.html?category=hagsul&syear=YYYY&smonth=MM`, 월은 두 자리)에서 호수를 찾는다. 2025-03 호부터.
  2. 사이트의 '해당 호 전체보기'(`/pdf/php/check.php`)로 PDF를 받아 Gemini에 통째로 넘긴다.
  3. Gemini가 이번 호 주제(표지), 기사별 지면·코너·제목·부제·저자·소속·요약(4~6항목)·태그를 만든다. 광고·표지·안내면은 제외.
  4. `data/articles.json`(기사), `data/issues.json`(호별 처리 상태)에 저장. '원문 보기'는 공식 PDF의 해당 면으로 연결(원문 텍스트는 저장하지 않음).
- 맥미니: Antigravity CLI(`agy`, 구글 계정 로그인)로 Gemini 3.8 Flash 사용. 설정 `scripts/mac.env`, 로그 `~/Library/Logs/kpj-digest.log`.
- `.github/workflows/update.yml`: 예비용(수동 실행, Secret `GEMINI_API_KEY` 사용).

## 사이트 기능
- 주별(호별)·월별 묶음 보기, 코너 필터, 검색, 읽음 체크·레벨·배지
- ⭐ 즐겨찾기, 📝 기사별 메모, 즐겨찾기·메모 모아보기 (브라우저에 저장 — 기기마다 따로)

## 수동 실행
```
scripts/run-mac.sh                                    # 맥미니에서 한 번 실행
GEMINI_BACKEND=cli node scripts/update.mjs --only 5480  # 특정 호만 다시
```
