#!/usr/bin/env bash
# Compact results table for an experiment. usage: results.sh <experiment_id> [--no-refresh]
set -euo pipefail
# Server-held names are data: drop control characters (keep tab/newline) before they reach a terminal.
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
ID=${1:?experiment id}
[[ $ID =~ ^[0-9]+$ ]] || { echo "experiment id must be a number"; exit 1; }
: "${FLAGSMITH_ENVIRONMENT:?source flagsmith.env or set FLAGSMITH_ENVIRONMENT}"
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT/experiments/$ID"
NOTE=""
if [ "${2:-}" != "--no-refresh" ]; then
  # Flagsmith allows one recompute per 5 min. Say so instead of silently showing a stale snapshot.
  since=$(date -u +%Y-%m-%dT%H:%M:%S)
  out=$(flagsmith api "$E/results/refresh/" -X POST 2>&1 || true)
  if [[ $out == *"Try again later"* ]]; then
    NOTE="note: refresh rate-limited (next in $(grep -o 'in [0-9]* seconds' <<<"$out" | head -1 | tr -dc 0-9)s); showing results as of as_of above"
  else
    for _ in $(seq 1 15); do   # wait (≤30s) until results are newer than our request
      asof=$(flagsmith api "$E/results/" --jq '.results.as_of // ""')
      [[ -n "$asof" && ! "$asof" < "$since" ]] && break
      sleep 2
    done
  fi
fi
flagsmith api "$E/" --jq '"#\(.id) \(.status): \(.name)"' | clean
flagsmith api "$E/results/" --jq '
  .results as $r | ($r.payload.metrics[0] // null) as $m |
  if $m == null then "collecting data (no results yet)" else
    ("arm\tusers\tconv\trate\tlift\tP(win)"),
    ($m.variants | to_entries | sort_by(.key != "control")[] | . as $v | ($m.inference[$v.key] // null) as $i |
      "\($v.key)\t\($v.value.n)\t\($v.value.sum)\t\(((1000*$v.value.sum/([$v.value.n,1]|max))|floor)/10)%\t" +
      (if $v.key == "control" then "base\t-" elif $i then "\((100*$i.lift)|round)%\t\((100*$i.chance_to_win)|round)%" else "-\t(needs conversions)" end)),
    "as_of=\($r.as_of)" + (if ($r.payload.srm_p_value // 1) < 0.01 then " SRM=YES(do not trust)" else "" end)
  end' | clean
[ -z "$NOTE" ] || echo "$NOTE"
