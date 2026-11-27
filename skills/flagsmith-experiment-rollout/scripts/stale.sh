#!/usr/bin/env bash
# Find flag debt in the current environment: flags whose experiment is finished, or whose rollout is decided
# (one variant at 100%), with how many tracked files still reference them. Read-only.
# usage: stale.sh
set -euo pipefail
: "${FLAGSMITH_ENVIRONMENT:?FLAGSMITH_ENVIRONMENT is not set: ask the person to load their Flagsmith credentials}"
E="api/v1/environments/$FLAGSMITH_ENVIRONMENT"

done_exps=$(flagsmith api "$E/experiments/" --jq '(if type=="array" then . else .results end)[]
  | select(.status=="completed") | "\(if (.feature|type)=="object" then .feature.name else .feature end)\texperiment #\(.id) completed"')
decided=$(flagsmith feature list --json | jq -r '.[] | select(.type=="multivariate")
  | . as $f | ([.variants[]? | select(.weight >= 100)] | first) as $w
  | select($w != null) | "\($f.name)\t\($w.key // $w.value) at 100%"')
stage=$(flagsmith flag list --json | jq -r '.[] | select(.lifecycle_stage=="stale") | "\(.feature)\tmarked stale in Flagsmith"')

rows=$(printf '%s\n%s\n%s\n' "$done_exps" "$decided" "$stage" | grep -v '^$' | sort -u -t$'\t' -k1,1 || true)
[ -n "$rows" ] || { echo "no flag debt found"; exit 0; }
echo -e "flag\treason\tcode_refs"
while IFS=$'\t' read -r flag reason; do
  refs=$( (git grep -l -w -- "$flag" 2>/dev/null || true) | grep -vc '^\.claude/' || true)
  echo -e "$flag\t$reason\t$refs"
done <<<"$rows"
echo "next: remove dead code where code_refs>0 (Gate 5), archive only flags with code_refs=0: flagsmith feature update <flag> --archive"
