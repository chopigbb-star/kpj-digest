# KPJ Digest — 대한약사저널 핵심 요약 피드

사이트: https://chopigbb-star.github.io/kpj-digest/

## 동작 방식
- 맥미니의 launchd(`~/Library/LaunchAgents/com.kpjdigest.update.plist`)가 4시간마다 `scripts/run-mac.sh`를 실행한다.
  - Antigravity CLI(`agy`, 구글 계정 로그인)로 요약은 Gemini 3.8 Flash, 검토는 Gemini 4 Argon (`scripts/mac.env`에서 변경)
  - 로그: `~/Library/Logs/kpj-digest.log`
- `.github/workflows/update.yml`은 예비용(수동 실행, 무료 API 키). `scripts/update.mjs` 단계:
  1. **수집**: 약사공론 공식 RSS에서 새 기사를 찾고, 기사 페이지의 섹션이 '대한약사저널'인 것만 담는다.
  2. **과거 기사**: `data/manual-urls.txt`에 붙여넣은 주소(또는 idxno)를 확인해 2025년 3월 이후 대한약사저널 기사만 담는다. (Gemini 검색 리서치는 무료 키 한도 때문에 기본 꺼짐: `--max-research N`으로 켬)
  3. **요약 + 검토**: Gemini로 4~6항목 요약 후, 원문과 대조해 한 번 더 교정한다. 본문이 이미지뿐인 기사는 이미지를 잘라 읽힌다. 한 번에 최대 30건.
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
