#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: test-identity-runtime-row-scope.sh <16|17>}"
[[ "${version}" == "16" || "${version}" == "17" ]] || exit 2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_container="vayada-identity-rls-${RANDOM}${RANDOM}"
trap 'docker rm -f "${database_container}" >/dev/null 2>&1 || true' EXIT

docker run --detach --rm --name "${database_container}" \
  --env POSTGRES_PASSWORD=postgres "postgres:${version}" >/dev/null
for _ in {1..30}; do
  docker exec "${database_container}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${database_container}" pg_isready -U postgres >/dev/null

docker exec -i "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE ROLE vayada_next_api_runtime LOGIN PASSWORD 'runtime' NOBYPASSRLS;
CREATE ROLE vayada_next_identity_runtime LOGIN PASSWORD 'identity' NOBYPASSRLS;
CREATE SCHEMA platform;
GRANT USAGE ON SCHEMA platform TO vayada_next_api_runtime, vayada_next_identity_runtime;
CREATE TABLE platform.external_webhook_events (id integer PRIMARY KEY, provider text NOT NULL, delivery_status text);
CREATE TABLE platform.idempotency_keys (id integer PRIMARY KEY, operation_scope text NOT NULL, status text);
CREATE TABLE platform.jobs (id integer PRIMARY KEY, queue_name text NOT NULL, job_type text NOT NULL,
  resource_product text NOT NULL, resource_type text, status text);
CREATE TABLE platform.product_audit_events (id integer PRIMARY KEY, product text NOT NULL);
CREATE TABLE platform.dead_letter_events (id integer PRIMARY KEY, source_kind text NOT NULL,
  resource_product text NOT NULL, resource_type text NOT NULL,
  webhook_event_id integer REFERENCES platform.external_webhook_events(id));
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform
  TO vayada_next_api_runtime, vayada_next_identity_runtime;
SQL
docker exec -i "${database_container}" psql -U postgres -v ON_ERROR_STOP=1 \
  < "${root}/packages/backend-migration/migrations/0327_identity_runtime_shared_row_scope.sql" >/dev/null

as_role() {
  local role="$1" password="$2" query="$3"
  docker exec -e "PGPASSWORD=${password}" "${database_container}" \
    psql -h localhost -U "${role}" -d postgres -v ON_ERROR_STOP=1 -At -c "${query}"
}
identity() { as_role vayada_next_identity_runtime identity "$1"; }
general() { as_role vayada_next_api_runtime runtime "$1"; }
denied() {
  if identity "$1" >/dev/null 2>&1; then
    echo "identity role unexpectedly changed a foreign row" >&2
    exit 1
  fi
}

general "INSERT INTO platform.external_webhook_events VALUES (1, 'stripe', 'received')" >/dev/null
identity "INSERT INTO platform.external_webhook_events VALUES (2, 'workos', 'received')" >/dev/null
denied "INSERT INTO platform.external_webhook_events VALUES (3, 'stripe', 'received')"
[[ "$(identity 'SELECT count(*) FROM platform.external_webhook_events')" == 1 ]]
[[ "$(identity "UPDATE platform.external_webhook_events SET delivery_status='ignored' WHERE id=1 RETURNING id")" == "UPDATE 0" ]]
general "UPDATE platform.external_webhook_events SET delivery_status='ignored' WHERE id=1" >/dev/null

general "INSERT INTO platform.idempotency_keys VALUES (1, 'booking', 'in_progress')" >/dev/null
identity "INSERT INTO platform.idempotency_keys VALUES (2, 'identity', 'in_progress')" >/dev/null
denied "INSERT INTO platform.idempotency_keys VALUES (3, 'booking', 'in_progress')"
[[ "$(identity 'SELECT count(*) FROM platform.idempotency_keys')" == 1 ]]
[[ "$(identity "UPDATE platform.idempotency_keys SET status='failed' WHERE id=1 RETURNING id")" == "UPDATE 0" ]]

general "INSERT INTO platform.jobs VALUES (1, 'booking', 'booking.confirm', 'booking', 'booking', 'pending')" >/dev/null
identity "INSERT INTO platform.jobs VALUES (2, 'identity.webhooks', 'identity.workos_webhook.reconcile', 'identity', 'workos_webhook', 'pending')" >/dev/null
identity "INSERT INTO platform.jobs VALUES (3, 'identity-provider', 'workos.organization-membership.delete', 'identity', 'organization_membership', 'pending')" >/dev/null
identity "INSERT INTO platform.jobs VALUES (4, 'pms-inbox', 'pms.inbox.assignment.reconcile', 'pms', 'inbox_assignment', 'pending')" >/dev/null
identity "INSERT INTO platform.jobs VALUES (7, 'identity-admin-transfer', 'identity.membership_role.reconcile', 'identity', 'organization_membership', 'pending')" >/dev/null
denied "INSERT INTO platform.jobs VALUES (5, 'booking', 'booking.confirm', 'booking', 'booking', 'pending')"
denied "INSERT INTO platform.jobs VALUES (6, 'pms-inbox', 'pms.reservation.cancel', 'pms', 'inbox_assignment', 'pending')"
[[ "$(identity 'SELECT count(*) FROM platform.jobs')" == 4 ]]
[[ "$(identity "UPDATE platform.jobs SET status='failed' WHERE id=1 RETURNING id")" == "UPDATE 0" ]]

general "INSERT INTO platform.product_audit_events VALUES (1, 'finance')" >/dev/null
identity "INSERT INTO platform.product_audit_events VALUES (2, 'identity')" >/dev/null
denied "INSERT INTO platform.product_audit_events VALUES (3, 'finance')"
[[ "$(identity 'SELECT count(*) FROM platform.product_audit_events')" == 1 ]]
[[ "$(identity "UPDATE platform.product_audit_events SET product='identity' WHERE id=1 RETURNING id")" == "UPDATE 0" ]]

general "INSERT INTO platform.dead_letter_events VALUES (1, 'webhook', 'finance', 'stripe_webhook', 1)" >/dev/null
identity "INSERT INTO platform.dead_letter_events VALUES (2, 'webhook', 'identity', 'workos_webhook', 2)" >/dev/null
denied "INSERT INTO platform.dead_letter_events VALUES (3, 'webhook', 'identity', 'workos_webhook', 1)"
[[ "$(identity 'SELECT count(*) FROM platform.dead_letter_events')" == 1 ]]
[[ "$(identity "UPDATE platform.dead_letter_events SET resource_type='other' WHERE id=1 RETURNING id")" == "UPDATE 0" ]]
identity "UPDATE platform.dead_letter_events SET resource_type='workos_webhook' WHERE id=2" >/dev/null
[[ "$(general 'SELECT count(*) FROM platform.dead_letter_events')" == 2 ]]

echo "PostgreSQL ${version} identity row scope passed"
