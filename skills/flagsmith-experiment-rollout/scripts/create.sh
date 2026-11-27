#!/usr/bin/env bash
# Idempotently create: multivariate flag + keyed variants, metric, experiment (not started).
# usage: create.sh <flag> <control_value> <event> <metric_name> <experiment_name> <hypothesis> <rollout_pct> <variant_key[,variant_key...]>
set -euo pipefail
[ $# -eq 8 ] || { sed -n 3p "$0"; exit 1; }
FLAG=$1 CONTROL=$2 EVENT=$3 METRIC=$4 NAME=$5 HYP=$6 ROLLOUT=$7
IFS=, read -ra KEYS <<<"$8"
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"

# 1. flag
if ! flagsmith feature get "$FLAG" --jq .id >/dev/null 2>&1; then
  flagsmith feature create "$FLAG" --value "$CONTROL" --enabled --description "Experiment: $NAME" --jq '"flag created id=\(.id)"'
fi
FID=$(flagsmith feature get "$FLAG" --jq .id)

# 2. keyed variants (variant value = key)
have=$(flagsmith feature variant list "$FLAG" --jq '[.[].key] | join(",")' 2>/dev/null || echo "")
for k in "${KEYS[@]}"; do
  [[ ",$have," == *",$k,"* ]] || flagsmith feature variant add "$FLAG" --key "$k" --value "$k" --weight 0 --jq '"variant \(.key) id=\(.id)"'
done
OPTS=$(flagsmith feature variant list "$FLAG" --json)

# 3. metric
MID=$(flagsmith api "$E/experiment-metrics/" --jq "(if type==\"array\" then . else .results end)[] | select(.name==\"$METRIC\") | .id" | head -1)
if [ -z "$MID" ]; then
  MID=$(jq -n --arg n "$METRIC" --arg e "$EVENT" '{name:$n, aggregation:"occurrence", direction:"up", definition:{version:1, event:$e}}' |
    flagsmith api "$E/experiment-metrics/" -X POST --input - --jq .id)
  echo "metric created id=$MID event=$EVENT"
fi

# 4. experiment (control gets the remainder of the split)
EID=$(flagsmith api "$E/experiments/" --jq "(if type==\"array\" then . else .results end)[] | select(.name==\"$NAME\") | .id" | head -1)
if [ -z "$EID" ]; then
  SHARE=$(jq -n --argjson n "${#KEYS[@]}" '100 / ($n + 1)')
  KEYS_JSON=$(printf '%s\n' "${KEYS[@]}" | jq -R . | jq -s .)
  EID=$(jq -n --argjson f "$FID" --arg n "$NAME" --arg h "$HYP" --arg m "$MID" --arg c "$CONTROL" \
      --argjson r "$ROLLOUT" --argjson s "$SHARE" --argjson keys "$KEYS_JSON" --argjson opts "$OPTS" '
    {feature:$f, name:$n, hypothesis:$h,
     metrics:[{metric:$m, expected_direction:"increase"}],
     experiment_rollout:{enabled:true, rollout_percentage:$r,
       feature_state_value:{type:"string", value:$c},
       multivariate_feature_state_values:[ $opts[] | select(.key as $k | $keys | index($k)) |
         {multivariate_feature_option:.id, percentage_allocation:$s} ]}}' |
    flagsmith api "$E/experiments/" -X POST --input - --jq .id)
fi
flagsmith api "$E/experiments/$EID/" --jq '"experiment_id=\(.id) status=\(.status)"'
