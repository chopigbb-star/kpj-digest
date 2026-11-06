# KPJ Digest — 대한약사저널 핵심 요약 피드

사이트: https://chopigbb-star.github.io/kpj-digest/

## 동작 방식
- `.github/workflows/update.yml`이 4시간마다 `scripts/update.mjs`를 실행한다.
  1. **수집**: 약사공론 공식 RSS에서 새 기사를 찾고, 기사 페이지의 섹션이 '대한약사저널'인 것만 담는다.
  2. **과거 기사 리서치**: Gemini(Google 검색)로 2025년 3월부터 월별 기사 URL 후보를 찾고, 실제 기사 페이지에서 섹션·날짜를 확인한 것만 담는다. 한 번에 4개월씩, 달마다 최대 2번 시도.
  3. **요약**: 요약이 없는 기사를 Gemini로 3~4줄 요약한다 (한 번에 최대 30건, 무료 한도 도달 시 다음 실행으로 넘김).
- 결과는 `data/articles.json`에 저장되고, 커밋되면 GitHub Pages에 자동 반영된다.

## 설정
- 저장소 Settings → Secrets and variables → Actions
  - Secret `GEMINI_API_KEY`: Google AI Studio에서 발급한 키 (필수)
  - Variable `GEMINI_MODEL`: 쓸 모델 이름 (선택, 기본 `gemini-flash-latest`)
- 수동 실행: Actions 탭 → "기사 수집·요약" → Run workflow

## 로컬 실행
```
node scripts/update.mjs --no-summarize   # 수집만 (키 불필요)
GEMINI_API_KEY=... node scripts/update.mjs
```
