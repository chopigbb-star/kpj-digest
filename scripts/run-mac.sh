#!/bin/bash
# 맥미니에서 4시간마다 실행: 수집 → Antigravity CLI(agy, 구글 계정 로그인·Pro 구독 한도)로 학술지 PDF 요약 → GitHub에 올림
# 설정: scripts/mac.env (SUMMARY_MODEL, UPDATE_ARGS)
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."

LOCK=/tmp/kpj-digest.lock
# 강제 종료로 남은 잠금(3시간 넘음)은 지운다
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180)" ]; then
  rmdir "$LOCK"
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "이미 실행 중 — 건너뜀"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 시작 ==="
[ -f scripts/mac.env ] && source scripts/mac.env

git pull -q --rebase
GEMINI_BACKEND=cli SUMMARY_MODEL="${SUMMARY_MODEL:-}" \
  node scripts/update.mjs ${UPDATE_ARGS:-}

git add data/
if git diff --cached --quiet; then
  echo "변경 없음"
else
  git -c user.name="kpj-digest-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -qm "기사 데이터 자동 갱신 (맥미니 $(date '+%Y-%m-%d %H:%M'))"
  git pull -q --rebase
  git push -q
  echo "GitHub에 올림"
fi
echo "=== $(date '+%H:%M:%S') 끝 ==="
