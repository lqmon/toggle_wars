#!/usr/bin/env bash
# End the experiment and let Flagsmith roll the decision out to the whole environment.
# Run only after human approval.
# usage: rollout.sh <experiment_id> <flag> <winner_variant_key | control | disable>
set -euo pipefail
: "${FLAGSMITH_ENVIRONMENT:?source flagsmith.env or set FLAGSMITH_ENVIRONMENT}"
ID=${1:?experiment id} FLAG=${2:?flag} WIN=${3:?winner key, control or disable}
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"
# snapshot for rollback: enabled, value, variant weights
BEFORE=$(flagsmith flag get "$FLAG" --jq '"\(.enabled) \(.value) \([.variants[]? | "\(.key)=\(.weight)"] | join(","))"')

case "$WIN" in
  control|disable) BODY=$(jq -n --arg d "$WIN" '{rollout_decision:$d}') ;;
  *) [[ $WIN =~ ^[a-z0-9][a-z0-9_-]{0,99}$ ]] || { echo "invalid variant key"; exit 1; }
     OPT=$(flagsmith feature variant list "$FLAG" --json | jq -r --arg k "$WIN" '.[] | select(.key==$k) | .id')
     [ -n "$OPT" ] || { echo "no variant with key '$WIN' on $FLAG"; exit 1; }
     BODY=$(jq -n --argjson o "$OPT" '{rollout_decision:"variant", rollout_variant:$o}') ;;
esac
echo "$BODY" | flagsmith api "$E/experiments/$ID/complete/" -X POST --input - --jq '"experiment \(.id) \(.status)"'

# verify with fresh identities: everyone should now get the same value
for i in 1 2 3 4 5; do flagsmith eval "$FLAG" --identity "verify-$RANDOM$i" --jq '.value'; done | sort | uniq -c | awk '{print "eval: "$1"/5 -> "$2}'
read -r EN VAL W <<<"$BEFORE"
# shell-quoted, so a hostile flag value can't turn the copy-pasted rollback into a different command
printf 'ROLLBACK: flagsmith flag update %q --yes %s --value %q%s\n' "$FLAG" "$([ "$EN" = true ] && echo --enable || echo --disable)" "$VAL" "${W:+ --weight $(printf %q "$W")}"
