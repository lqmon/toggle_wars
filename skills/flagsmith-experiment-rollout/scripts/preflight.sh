#!/usr/bin/env bash
# One line per fact. Exits non-zero if experimentation can't run here.
set -euo pipefail
# Server-held names are data: drop control characters (keep tab/newline) before they reach a terminal.
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
command -v flagsmith >/dev/null || { echo "flagsmith CLI missing: brew install Flagsmith/tap/flagsmith"; exit 1; }
: "${FLAGSMITH_ENVIRONMENT:?set FLAGSMITH_ENVIRONMENT (client-side env key) or source flagsmith.env}"
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"

echo "host=${FLAGSMITH_API_URL:-https://api.flagsmith.com} cli=$(flagsmith --version | awk '{print $3}')"
flagsmith api "$E/" --jq '"env=\(.name) project=\(.project)"' | clean
wh=$(flagsmith api "$E/warehouse-connections/" --jq '(if type=="array" then . else .results end)[0] | "\(.warehouse_type):\(.status)"' 2>/dev/null || echo "none:missing")
echo "warehouse=$wh"
flagsmith api "$E/experiments/" --jq '(if type=="array" then . else .results end)[] | select(.status=="running" or .status=="created") | "experiment=\(.id) \(.status) \(.name)"' 2>/dev/null | clean || true
[[ "$wh" == *":connected" ]] || { echo "BLOCKER: warehouse not connected"; exit 2; }
