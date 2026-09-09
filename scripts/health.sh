#!/bin/sh
# Ask each service what it thinks of itself, from outside its container and
# over the published port, so a pass here also proves the port mapping works.
#
# Exits non-zero if any service is unreachable or reports unhealthy, which is
# what makes `make up` fail loudly rather than printing a wall of green.
set -eu

cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

fail=0

check_json() {
  name=$1
  port=$2
  if body=$(curl -fsS --max-time 10 "http://localhost:${port}/health" 2>/dev/null); then
    printf '%-9s %s\n' "$name" "$body"
  else
    printf '%-9s no healthy answer on port %s\n' "$name" "$port"
    fail=1
  fi
}

check_json prover "${PROVER_PORT:-3003}"
check_json indexer "${INDEXER_PORT:-3010}"
check_json keeper "${KEEPER_PORT:-3011}"

# The application is a static bundle behind a file server; it has no /health to
# report, so serving its entry document is the whole of the check.
app_port=${APP_PORT:-3000}
code=$(curl -o /dev/null -s -w '%{http_code}' --max-time 10 "http://localhost:${app_port}/" || echo 000)
if [ "$code" = "200" ]; then
  printf '%-9s HTTP %s\n' app "$code"
else
  printf '%-9s HTTP %s on port %s\n' app "$code" "$app_port"
  fail=1
fi

exit "$fail"
