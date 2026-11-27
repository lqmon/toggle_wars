#!/usr/bin/env bash
# Show how N fresh identities are bucketed for a flag (flagsmith eval records no exposures).
# usage: verify.sh <flag> [n=8]
set -euo pipefail
# Server-held names are data: drop control characters (keep tab/newline) before they reach a terminal.
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
FLAG=${1:?flag}; N=${2:-8}
[[ $FLAG =~ ^[a-z0-9][a-z0-9_-]{0,99}$ && $N =~ ^[0-9]+$ ]] || { echo "usage: verify.sh <flag> [n]"; exit 1; }
for i in $(seq 1 "$N"); do flagsmith eval "$FLAG" --identity "verify-$RANDOM-$i" --jq '.variant // .value'; done | clean |
  sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":"bucketing: "), $2, $1} END {print ""}'
