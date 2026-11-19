#!/bin/sh
# Starts one service from the shared app image, chosen by $APP.
#
# Used where each service cannot be given its own command (Railway). Compose
# sets each service's command directly and does not use this script.
#
#   APP                        which service to run (see the list below)
#   RUN_MIGRATIONS=true        apply database migrations first
#   RUN_DEMO_SEED=true         after the service is up, seed the demo workspace
#                              (ingest only: it registers the demo manifests through itself)
#   GITHUB_APP_PRIVATE_KEY_BASE64
#                              the GitHub App key, base64-encoded; written to a file
#                              for services that read GITHUB_APP_PRIVATE_KEY_FILE
set -eu

case "${APP:-}" in
  query-api | ingest | platform | slack | alerts | web | review)
    entry="apps/$APP/src/main.ts" ;;
  slack-fake) entry=apps/slack/src/fake/server.ts ;;
  stripe-fake) entry=apps/web/src/fake/stripe.ts ;;
  github-fake) entry=apps/review/src/fake/github.ts ;;
  *)
    echo "APP must name a service: query-api, ingest, platform, slack, alerts, web, review," >&2
    echo "(the agent has its own image: infra/docker/agent.Dockerfile)" >&2
    echo "slack-fake, stripe-fake or github-fake. Got: '${APP:-}'" >&2
    exit 64 ;;
esac

if [ -n "${GITHUB_APP_PRIVATE_KEY_BASE64:-}" ]; then
  key_file=/tmp/github-app.pem
  printf '%s' "$GITHUB_APP_PRIVATE_KEY_BASE64" | base64 -d > "$key_file"
  chmod 600 "$key_file"
  export GITHUB_APP_PRIVATE_KEY_FILE="$key_file"
fi

if [ "${RUN_MIGRATIONS:-}" = true ]; then
  node --import tsx packages/db/src/cli/migrate.ts
fi

if [ "${RUN_DEMO_SEED:-}" != true ]; then
  exec node --import tsx "$entry"
fi

# Start the service, wait until it answers, seed through it, then stay attached.
node --import tsx "$entry" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
port="${PORT:-8080}"
tries=0
until wget -qO- "http://127.0.0.1:$port/healthz" > /dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "The service did not come up; skipping the demo seed." >&2
    break
  fi
  sleep 1
done
INGEST_URL="http://127.0.0.1:$port" node --import tsx scripts/seed-dev.ts ||
  echo "The demo seed failed; the service keeps running." >&2
wait "$pid"
