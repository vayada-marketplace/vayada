#!/usr/bin/env sh

set -eu

: "${APPLICATION_RELEASE:?APPLICATION_RELEASE is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

migration_database_url="${TARGET_DATABASE_MIGRATION_URL:-$TARGET_DATABASE_URL}"

TARGET_DATABASE_URL="$migration_database_url" \
  npm --workspace @vayada/backend-migration run target:migrate:dist -- \
  --env production \
  --git-sha "$APPLICATION_RELEASE" \
  --wait-for-database-seconds "${NEXT_API_DATABASE_WAIT_SECONDS:-120}"

# Never expose the owner credential to the long-running API process.
unset TARGET_DATABASE_MIGRATION_URL migration_database_url
cd apps/api
exec node dist/server.js
