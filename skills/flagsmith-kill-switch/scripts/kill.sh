#!/usr/bin/env bash
# Turn a flag off for everyone in this environment, then prove it. Run only after the person approved.
# A running experiment on the flag is ended with Flagsmith's own "disable" decision (the flag is locked while it runs).
# usage: kill.sh <flag>
set -euo pipefail
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
: "${FLAGSMITH_ENVIRONMENT:?FLAGSMITH_ENVIRONMENT is not set}"
FLAG=${1:?flag}; [[ $FLAG =~ ^[a-z0-9][a-z0-9_-]{0,99}$ ]] || { echo "invalid flag name"; exit 1; }
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"
exp=$(flagsmith api "$E/experiments/" 2>/dev/null | jq -r --arg f "$FLAG" '[(if type=="array" then . else .results end)[] | select(.status=="running") | select((if (.feature|type)=="object" then .feature.name else .feature end)==$f) | .id] | first // empty' || true)
if [ -n "$exp" ]; then
  echo '{"rollout_decision":"disable"}' | flagsmith api "$E/experiments/$exp/complete/" -X POST --input - --yes --jq '"experiment \(.id) \(.status) (disabled)"' | clean
fi
flagsmith flag disable "$FLAG" --yes >/dev/null 2>&1 || true
flagsmith flag get "$FLAG" --jq '"default: enabled=\(.enabled)"' | clean
off=0; for i in 1 2 3 4 5; do
  if [ "$(flagsmith eval "$FLAG" --identity "killcheck-$RANDOM$i" --jq '.enabled')" = "false" ]; then off=$((off+1)); fi
done
echo "eval: $off/5 fresh users get it OFF"
[ "$off" = 5 ] || { echo "NOT FULLY OFF: check segment or identity overrides (flagsmith flag get $FLAG)"; exit 3; }
