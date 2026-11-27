#!/usr/bin/env bash
# Compact results table for an experiment. usage: results.sh <experiment_id> [--no-refresh]
set -euo pipefail
ID=${1:?experiment id}
[[ $ID =~ ^[0-9]+$ ]] || { echo "experiment id must be a number"; exit 1; }
: "${FLAGSMITH_ENVIRONMENT:?source flagsmith.env or set FLAGSMITH_ENVIRONMENT}"
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT/experiments/$ID"
[ "${2:-}" = "--no-refresh" ] || flagsmith api "$E/results/refresh/" -X POST >/dev/null 2>&1 || true  # ≤ once / 5 min
flagsmith api "$E/" --jq '"#\(.id) \(.status): \(.name)"'
flagsmith api "$E/results/" --jq '
  .results as $r | ($r.payload.metrics[0] // null) as $m |
  if $m == null then "collecting data (no results yet)" else
    ("arm\tusers\tconv\trate\tlift\tP(win)"),
    ($m.variants | to_entries[] | . as $v | ($m.inference[$v.key] // null) as $i |
      "\($v.key)\t\($v.value.n)\t\($v.value.sum)\t\(((1000*$v.value.sum/([$v.value.n,1]|max))|floor)/10)%\t" +
      (if $i then "\((100*$i.lift)|round)%\t\((100*$i.chance_to_win)|round)%" else "base\t-" end)),
    "as_of=\($r.as_of)" + (if ($r.payload.srm_p_value // 1) < 0.01 then " SRM=YES(do not trust)" else "" end)
  end'
