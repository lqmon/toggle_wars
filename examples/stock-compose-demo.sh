#!/usr/bin/env bash
# Reproduce the "obvious" self-hosted setup that flagkit doctor catches, for demos.
# Boots the UNMODIFIED upstream docker-compose.yml on port 8100, configured the way the API suggests.
# Everything runs locally under compose project "stock"; remove with: examples/stock-compose-demo.sh down
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/.stock"
mkdir -p "$DIR"
if [ "${1:-}" = "down" ]; then docker compose -p stock -f "$DIR/docker-compose.yml" down -v; exit; fi

curl -fsSL https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml |
  sed -e 's/- 8000:8000/- 8100:8000/' -e 's/- 8001:8000/- 8101:8000/' -e 's/container_name: flagsmith_postgres/container_name: stock_postgres/' \
  > "$DIR/docker-compose.yml"
docker compose -p stock -f "$DIR/docker-compose.yml" up -d
until curl -fs localhost:8100/health >/dev/null; do sleep 3; done

api() { curl -fsS -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Token $TOKEN"} "$@"; }
B=http://localhost:8100/api/v1
TOKEN=$(api -X POST $B/auth/users/ -d '{"email":"demo@example.test","password":"Demo-pass-12345!","first_name":"D","last_name":"U","superuser":true}' | jq -r .key)
ORG=$(api -X POST $B/organisations/ -d '{"name":"Acme"}' | jq .id)
PROJ=$(api -X POST $B/projects/ -d "{\"name\":\"Web\",\"organisation\":$ORG}" | jq .id)
ENV=$(api -X POST $B/environments/ -d "{\"name\":\"Production\",\"project\":$PROJ}" | jq -r .api_key)
api -X POST "$B/environments/$ENV/warehouse-connections/" -d '{"warehouse_type":"flagsmith","name":"Flagsmith"}' >/dev/null
KEY=$(api -X POST "$B/organisations/$ORG/master-api-keys/" -d '{"name":"ci","is_admin":true}' | jq -r .key)

cat <<EOF
Stock Flagsmith on http://localhost:8100, set up the obvious way. Now run:

  FLAGSMITH_API_KEY=$KEY FLAGSMITH_ADMIN_KEY=$KEY FLAGSMITH_SDK_API_URL=http://localhost:8100/api/v1/ \\
    node bin/flagkit.js doctor --api-url http://localhost:8100 --env-key $ENV

  # then add --fix --yes, and run doctor again
Tear down: examples/stock-compose-demo.sh down
EOF
