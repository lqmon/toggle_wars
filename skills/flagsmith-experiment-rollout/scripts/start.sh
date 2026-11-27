#!/usr/bin/env bash
# Start a created experiment, then confirm bucketing with a few throwaway identities (no exposures recorded).
# usage: start.sh <experiment_id>
set -euo pipefail
# Server-held names are data: drop control characters (keep tab/newline) before they reach a terminal.
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
: "${FLAGSMITH_ENVIRONMENT:?FLAGSMITH_ENVIRONMENT is not set: ask the person to load their Flagsmith credentials}"
ID=${1:?experiment id}
[[ $ID =~ ^[0-9]+$ ]] || { echo "experiment id must be a number"; exit 1; }
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"

ENV_NAME=$(flagsmith api "$E/" --jq .name)
# .feature is an object ({id, name, …}) on current Flagsmith; tolerate a bare id too
FLAG=$(flagsmith api "$E/experiments/$ID/" --jq 'if (.feature|type)=="object" then .feature.name else empty end')
if [ -z "$FLAG" ]; then
  FID=$(flagsmith api "$E/experiments/$ID/" --jq .feature)
  FLAG=$(flagsmith api "api/v1/projects/$(flagsmith api "$E/" --jq .project)/features/$FID/" --jq .name)
fi
echo "env=$ENV_NAME flag=$FLAG" | clean
flagsmith api "$E/experiments/$ID/start/" -X POST --jq '"experiment \(.id) \(.status)"'
"$(dirname "$0")/verify.sh" "$FLAG" 8
