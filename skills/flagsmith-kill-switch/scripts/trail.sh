#!/usr/bin/env bash
# Leave a trail for the follow-up: an incident note (and a GitHub issue when gh is available).
# usage: trail.sh <flag> "<symptom>" "<rollback command>"
set -euo pipefail
clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }
FLAG=${1:?flag}; SYMPTOM=${2:?symptom}; ROLLBACK=${3:?rollback command}
[[ $FLAG =~ ^[a-z0-9][a-z0-9_-]{0,99}$ ]] || { echo "invalid flag name"; exit 1; }
[[ $ROLLBACK == "flagsmith flag update "* ]] || { echo "rollback must be the ROLLBACK line from snapshot.sh"; exit 1; }
SYMPTOM=$(printf '%s' "$SYMPTOM" | clean | head -c 300)
envname=$(flagsmith api "api/v1/environments/${FLAGSMITH_ENVIRONMENT:?}/" --jq '.name' | clean)
when=$(date -u +%Y-%m-%dT%H:%MZ); who=$(git config user.name 2>/dev/null || whoami)
mkdir -p incidents; note="incidents/$(date -u +%Y%m%d-%H%M)-$FLAG.md"
cat > "$note" <<MD
# Incident: \`$FLAG\` turned off in $envname

- **When:** $when
- **Symptom:** $SYMPTOM
- **Action:** \`$FLAG\` disabled for everyone in $envname (approved by $who), verified with 5 fresh evaluations.
- **Undo** (only once the cause is fixed):
  \`\`\`
  $ROLLBACK
  \`\`\`

## Follow-up
- [ ] Find the root cause in the code behind \`$FLAG\`: $( (git grep -l -w -- "$FLAG" 2>/dev/null | grep -v -e '^skills/' -e '^incidents/' | head -5 | sed 's/.*/`&`/' | paste -sd ' ' -) || true)
- [ ] Add a test that reproduces it
- [ ] Re-enable (undo command above), ideally to a small percentage first
MD
echo "note=$note"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh issue create --title "Incident: $FLAG turned off in $envname" --body-file "$note" --label incident 2>/dev/null \
    || gh issue create --title "Incident: $FLAG turned off in $envname" --body-file "$note" | tail -1
else
  echo "gh not available: commit the note, or paste it into your tracker"
fi
