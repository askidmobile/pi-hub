#!/usr/bin/env bash
# Rejects commits / PR texts that credit an AI tool as author or co-author.
# Usage:
#   scripts/check-attribution.sh                 # check commits in BASE..HEAD (BASE defaults to origin/main)
#   scripts/check-attribution.sh --text FILE     # check an arbitrary text (e.g. PR body)
set -euo pipefail

PATTERN='(co-authored-by:.*(noreply@anthropic\.com|openai\.com|claude|codex|copilot|gemini|cursor|deepseek|chatgpt))|(generated (with|by) .*(claude|codex|copilot|chatgpt|gemini|cursor|ai))|🤖 generated'

if [[ "${1:-}" == "--text" ]]; then
  if grep -Eiq "$PATTERN" "${2:?file required}"; then
    echo "error: AI attribution found in ${2}" >&2
    grep -Ein "$PATTERN" "$2" >&2
    exit 1
  fi
  exit 0
fi

BASE="${BASE:-origin/main}"
RANGE="${BASE}..HEAD"
git rev-parse --verify -q "$BASE" >/dev/null || RANGE="HEAD"

bad=0
while read -r sha; do
  [[ -z "$sha" ]] && continue
  if git log -1 --format=%B "$sha" | grep -Eiq "$PATTERN"; then
    echo "error: commit $sha contains AI attribution" >&2
    bad=1
  fi
done < <(git rev-list "$RANGE" 2>/dev/null || true)
exit "$bad"
