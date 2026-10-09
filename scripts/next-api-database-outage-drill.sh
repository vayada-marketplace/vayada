#!/usr/bin/env bash
# VAY-2084 drill: next-api must ride out a PostgreSQL outage without restarting.
#
# Starts next-api from source against TARGET_DATABASE_URL (an already migrated local or
# disposable database, never production), stops the database for OUTAGE_SECONDS, starts it
# again, and checks that the same process recovers:
#   - /health answers 200 before the outage, 503 during it and 200 again afterwards;
#   - the API process stays alive throughout (same PID, no restart).
#
# Usage (from the repo root, after `npm --workspace vayada-api run build:backend-packages`):
#   TARGET_DATABASE_URL=postgresql://... \
#   DRILL_STOP_DATABASE='docker stop vayada-postgres' \
#   DRILL_START_DATABASE='docker start vayada-postgres' \
#   scripts/next-api-database-outage-drill.sh
# With a native cluster use `pg_ctl -D <dir> -m fast stop` and `pg_ctl -D <dir> -w start`.
# Optional: OUTAGE_SECONDS (60), RECOVERY_SECONDS (60), PORT (18003).
#
# The server inherits this shell's environment. Run it under `env -i PATH="$PATH" HOME="$HOME" ...`
# with only local settings, so it never picks up real WorkOS keys or an AWS profile. API_RUNTIME=next
# also needs PUBLIC_HOTEL_PROFILE_SOURCE, PMS_OPERATIONS_SOURCE and FINANCE_SOURCE set to target,
# plus the three FINANCE_FOLIO_RECIPIENT_KMS_* ARNs (syntactically valid placeholders are enough).
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${DRILL_STOP_DATABASE:?DRILL_STOP_DATABASE is required}"
: "${DRILL_START_DATABASE:?DRILL_START_DATABASE is required}"
outage_seconds="${OUTAGE_SECONDS:-60}"
recovery_seconds="${RECOVERY_SECONDS:-60}"
port="${PORT:-18003}"
health="http://127.0.0.1:${port}/health"
log="$(mktemp -t next-api-drill.XXXXXX)"

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$health" || true; }
alive() { kill -0 "$api_pid" 2>/dev/null; }
fail() {
  echo "DRILL FAILED: $*" >&2
  echo "--- last next-api log lines ---" >&2
  tail -n 40 "$log" >&2
  exit 1
}
cleanup() {
  if [ -n "${api_pid:-}" ] && alive; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
  rm -f "$log"
}
trap cleanup EXIT

(cd apps/api && HOST=127.0.0.1 PORT="$port" exec node --import tsx src/server.ts) >"$log" 2>&1 &
api_pid=$!

for _ in $(seq 1 90); do
  [ "$(status)" = "200" ] && break
  alive || fail "next-api exited during startup"
  sleep 1
done
[ "$(status)" = "200" ] || fail "next-api did not become healthy"
echo "next-api healthy (pid ${api_pid}); stopping the database for ${outage_seconds}s"

sh -c "$DRILL_STOP_DATABASE"
saw_unavailable=false
end=$((SECONDS + outage_seconds))
while [ "$SECONDS" -lt "$end" ]; do
  alive || fail "next-api exited while the database was down"
  [ "$(status)" = "503" ] && saw_unavailable=true
  sleep 5
done
[ "$saw_unavailable" = true ] || fail "/health never reported 503 while the database was down"
echo "database outage over; /health reported 503 and next-api stayed up"

sh -c "$DRILL_START_DATABASE"
recovered=false
for _ in $(seq 1 "$recovery_seconds"); do
  alive || fail "next-api exited after the database came back"
  if [ "$(status)" = "200" ]; then recovered=true; break; fi
  sleep 1
done
[ "$recovered" = true ] || fail "/health did not recover within ${recovery_seconds}s"
alive || fail "next-api exited"
echo "DRILL PASSED: the same next-api process (pid ${api_pid}) recovered without a restart"
