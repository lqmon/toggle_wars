#!/usr/bin/env bash
# Which flag is behind a broken feature? Ranks flags by code evidence. Read-only.
# usage: suspects.sh "<symptom keyword>" [more keywords…]      e.g. suspects.sh checkout payment
set -euo pipefail
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
: "${FLAGSMITH_ENVIRONMENT:?FLAGSMITH_ENVIRONMENT is not set: ask the person to load their Flagsmith credentials}"
[ $# -ge 1 ] || { echo "usage: suspects.sh <keyword> [keyword…]"; exit 1; }
for k in "$@"; do [[ $k =~ ^[A-Za-z0-9_.-]{2,40}$ ]] || { echo "keywords: letters, digits, _ . - only"; exit 1; }; done
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"
running=$(flagsmith api "$E/experiments/" --jq '[(if type=="array" then . else .results end)[] | select(.status=="running") | if (.feature|type)=="object" then .feature.name else .feature end] | join(" ")')
pat=$(IFS='|'; echo "$*")
printf 'flag\tstate\tscore\tevidence\n'
flagsmith flag list --json | jq -r '.[] | "\(.feature)\t\(if .enabled then "on" else "off" end):\(.value)"' | clean |
while IFS=$'\t' read -r flag state; do
  [[ $flag =~ ^[A-Za-z0-9_.-]+$ ]] || continue
  files=$(git grep -l -w -- "$flag" 2>/dev/null | grep -v -e '^\.claude/' -e '^skills/' || true)
  [ -n "$files" ] || continue
  hits=$(printf '%s\n' "$files" | xargs grep -l -i -E -- "$pat" 2>/dev/null | head -3 | tr '\n' ',' || true)
  score=0
  if [ -n "$hits" ]; then score=$((score+2)); fi
  if grep -q -i -E -- "$pat" <<<"$flag"; then score=$((score+3)); fi
  if [[ " $running " == *" $flag "* ]]; then state="$state(experiment)"; fi
  if [ "$score" -gt 0 ]; then printf '%s\t%s\t%s\t%s\n' "$flag" "$state" "$score" "${hits%,}"; fi
done | sort -t$'\t' -k3,3nr | head -5
