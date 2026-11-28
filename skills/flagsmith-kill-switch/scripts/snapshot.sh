#!/usr/bin/env bash
# Everything to know before killing a flag: its state here and in every environment, a running experiment,
# code references, and the exact rollback command. Read-only.
# usage: snapshot.sh <flag>
set -euo pipefail
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
: "${FLAGSMITH_ENVIRONMENT:?FLAGSMITH_ENVIRONMENT is not set: ask the person to load their Flagsmith credentials}"
FLAG=${1:?flag}; [[ $FLAG =~ ^[a-z0-9][a-z0-9_-]{0,99}$ ]] || { echo "invalid flag name"; exit 1; }
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"
envname=$(flagsmith api "$E/" --jq '.name' | clean)
BEFORE=$(flagsmith flag get "$FLAG" --jq '"\(.enabled) \(.value) \([.variants[]? | "\(.key)=\(.weight)"] | join(","))"' | clean)
read -r EN VAL W <<<"$BEFORE"
echo "env=$envname flag=$FLAG enabled=$EN value=$VAL${W:+ weights=$W}"
exp=$(flagsmith api "$E/experiments/" 2>/dev/null | jq -r --arg f "$FLAG" '[(if type=="array" then . else .results end)[] | select(.status=="running") | select((if (.feature|type)=="object" then .feature.name else .feature end)==$f) | .id] | first // empty' || true)
if [ -n "$exp" ]; then echo "experiment=$exp running (kill ends it: rollout_decision=disable)"; fi
refs=$( (git grep -l -w -- "$FLAG" 2>/dev/null | grep -v -e '^\.claude/' -e '^skills/' | head -5 | tr '\n' ' ') || true)
echo "code_refs=${refs:-none}"
if [[ $envname =~ [Pp]rod ]]; then echo "PRODUCTION: real users. Gate 2 approval required."; fi
printf 'ROLLBACK: flagsmith flag update %q --yes %s --value %q%s\n' "$FLAG" "$([ "$EN" = true ] && echo --enable || echo --disable)" "$VAL" "${W:+ --weight $(printf %q "$W")}"
