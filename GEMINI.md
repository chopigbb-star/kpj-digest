# KPJ Digest — 편집 지침 (Gemini용)

이 저장소는 GitHub Pages로 배포되는 단일 정적 페이지다. `main` 브랜치에 푸시하면 1~2분 뒤 사이트에 반영된다.

## 구조
- `index.html` 하나에 HTML·스타일(Tailwind CDN)·스크립트가 모두 들어 있다. 빌드 과정 없음.
- 기사 데이터는 `index.html` 안의 `const INITIAL_ARTICLES = [ ... ];` 배열이다.

## 기사 추가·수정 규칙
- 새 기사는 `INITIAL_ARTICLES` 배열 **맨 앞**에 추가한다.
- `id`는 `kpj-NN` 형식으로, 기존 최대 번호 + 1을 쓴다. 기존 `id`는 절대 바꾸지 않는다(사용자의 '다 읽음' 기록이 id에 묶여 있음).
- `kpj-user-`로 시작하는 id는 쓰지 않는다(사용자가 직접 추가한 글용).
- 필드:
  - `title`: 원문 제목 (예: `"[약대약] A vs B"`)
  - `category`: 다음 중 하나만 — `약대약`, `전문의약품(ETC)`, `일반의약품(OTC)`, `임상·복약노트`, `질환별 가이드`
  - `author`, `date`(`YYYY.MM.DD`), `url`(약사공론 원문 링크)
  - `summaryPoints`: 3~4개 문장 배열 (기전/특징, 복약지도 포인트, 주의사항)
  - `tags`: 3~4개, `completed: false`
- 요약은 원문 내용에 근거해서만 쓴다. 원문을 확인하지 못했으면 추측으로 채우지 말고 그렇다고 알린다.
- 카테고리를 새로 만들면 상단 필터 버튼(`cat-pill`), 추가 모달의 `<select>`, `getCategoryBadge()` 세 곳을 함께 고친다.

## 하지 말 것
- `STORAGE_KEY` 값 변경, `loadArticles()` 병합 로직 삭제 (사용자 읽음 기록이 사라짐)
- 빌드 도구·프레임워크·외부 의존성 추가
- 수정 후 JS 문법 오류가 없는지 확인한다 (배열 끝 쉼표, 따옴표 짝).
