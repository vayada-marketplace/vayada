# Identity runtime boundary for staff invitations (VAY-2038)

## Decision

Keep `vayada_next_api_runtime` as the restricted credential for general
product repositories. Use a separate, non-owner `vayada_next_identity_runtime`
credential for the identity-owned repositories already wired through
`AUTH_DATABASE_URL`. Never give either long-lived role the target database
migration-owner credential.

The identity role may write only the reviewed identity lifecycle tables.
Shared platform webhook, job, dead-letter, and audit writes require a separate
provider- or queue-scoped database boundary; ordinary table grants are not
enough, because those tables also hold non-identity work. It must not own
tables or functions, create schemas or temporary tables, inherit a more
powerful role, write migration/evidence/legacy-owner receipt tables, or write
booking, PMS, marketplace, or finance product data. The general API role must
remain unable to insert or update organization memberships, users, provider
identities, or staff invitations.

`apps/api` already supplies `config.auth.databaseUrl` to staff invitation,
WorkOS identity, lifecycle, and auth-session repositories. Two product
consumers currently use it as well: PMS module activation and the booking-web
attribution sink. Route those through `TARGET_DATABASE_URL` before changing the
deployed mapping. Verify the general role can read
`identity.product_entitlements` and can insert/select `platform.domain_events`
and insert `platform.product_audit_events`; the current preflight does not
establish the `domain_events` privileges. Keep attribution disabled until a
reviewed product-role grant and real-role test pass. Audit all other
`config.auth.databaseUrl` consumers,
including platform audit/outbox and workers, against the privilege matrix;
the split is a credential boundary, not permission for cross-domain calls.

## Auth connection inventory before granting

`apps/api/src/server.ts` currently constructs these consumers from
`config.auth.databaseUrl`. This is a connection inventory, **not** approval to
grant every SQL operation used by each consumer:

| Consumer | Database surface to review |
| --- | --- |
| Sign-in identity repository and lifecycle command bus | `identity.users`, `external_identities`, `organizations`, `organization_memberships`, `organization_resource_links`, `role_permission_grants`, `auth_reconciliation_events` |
| Authorization entitlement repository | Read `identity.product_entitlements` for product-access decisions |
| Session handoff | `identity.auth_session_handoffs` |
| Staff invitation create, delivery, acceptance, roles, and removal | `identity.staff_invitations`, `staff_invitation_property_assignments`, `organization_memberships`, `membership_property_assignments`, `membership_delegations`, `organization_roles`, plus identity reads and shared idempotency, audit, and jobs |
| WorkOS webhook receipt and reconciliation | `platform.external_webhook_events`, `dead_letter_events`, `jobs`, plus identity users, provider mappings, organizations, memberships, and invitations |
| Account-admin transfer and role worker | Identity transfer proofs/guards, memberships, provider mappings, and the identity-admin-transfer job queue |
| Privacy and platform identity-user administration | Identity consent and GDPR tables, users, provider mappings, organizations, memberships, and reconciliation events |
| Product audit sink | `platform.product_audit_events` with `product = 'identity'` only |

The PMS inbox assignment worker itself uses `TARGET_DATABASE_URL`, not the auth
connection. The booking-web attribution sink and PMS module activation are
routed to `TARGET_DATABASE_URL` in this preparatory PR. A grant runner must now
derive exact operations and any column restrictions from these call sites,
including row-lock `UPDATE` requirements; it must not use `ALL TABLES IN SCHEMA`
or a generic identity-schema write grant. Shared-table row restrictions are a
separate prerequisite before any identity role can write those tables.

## Why the alternatives are unsafe

- Granting membership `INSERT` or role/status `UPDATE` to the general runtime
  role permits manager access changes across tenants. PostgreSQL also requires
  `UPDATE` privilege to run `SELECT ... FOR UPDATE/SHARE` on a table; a
  column-level grant still permits a real write to that column.
- A callable `SECURITY DEFINER` transition cannot itself prove that a claimed
  WorkOS user or webhook was authenticated. If the same general runtime role
  can call it with arbitrary parameters, it can forge the context unless an
  additional verifiable command-proof system is built. That is more complex
  than isolating the existing identity connection.
- Mapping `AUTH_DATABASE_URL` to the migration-owner URL would bypass the
  runtime split and expose schema, receipt, and evidence authority to the API.

The identity role is not a substitute for route authorization, WorkOS event
verification, tenant checks, parameterized SQL, audit, or protected-account
guards. A SQL injection in an identity endpoint would still be dangerous;
the new boundary limits unrelated product queries from becoming identity
writers. It must be independently security-reviewed before deployment.

## Scope and rollout

1. Inventory every identity-owned query reached by WorkOS JIT, invitation
   create/delivery/acceptance, role editing, removal, and inbox reconciliation.
   Define an explicit table/column privilege matrix. The identity role must
   cover new-user creation and provider mapping as well as existing users.
   Handle shared `platform.external_webhook_events` row locks,
   `platform.dead_letter_events` updates, and `platform.jobs` claim/updates
   with provider- or queue-scoped transitions or equivalent database-enforced
   isolation. Application `WHERE` clauses alone are not a privilege boundary.
   Negative fixtures must prove the identity credential cannot modify Stripe,
   Channex, booking, or other product rows/jobs.
2. Add a separate role-creation/grant mechanism with a dedicated secret and
   PostgreSQL 16/17 preflight. The role and secret are provisioned without
   printing a password; the grant runner requires table ownership and refuses
   unreviewed effective privileges. The general-runtime preflight must still
   reject identity writes. No ad-hoc production grant.
3. Deploy the grants and preflight first. Canary-check that both *deployed*
   `AUTH_DATABASE_URL` and `TARGET_DATABASE_URL` resolve to the intended
   distinct roles on the same target database; checking a separately supplied
   URL is insufficient. Then change only the long-lived
   `AUTH_DATABASE_URL` secret mapping to the identity role; keep
   `TARGET_DATABASE_URL` on the general role and
   `TARGET_DATABASE_MIGRATION_URL` child-process-only. Roll back to the healthy
   task definition *after* the migration-owner split but before the identity
   split; do not roll back to an owner URL.
4. Exercise restricted-role integration tests for existing and new users,
   invitation creation, at-most-once WorkOS delivery, accepted-webhook
   membership, replay/failure, and multi-organization denial. Verify the
   exact deployed task revision and coordinate one hosted QA invitation using
   reusable users/property. Do not create accounts or retry the unchanged 500.

`platform.jobs` consumption is a separate shared worker permission problem:
the invitation path can enqueue a PMS inbox reconciliation job, but the worker
currently lacks its own required write privileges. Coordinate its reviewed
fix; do not describe enqueue alone as a complete invitation smoke.

VAY-2038 stays In Progress until the hosted invite → WorkOS callback →
accepted webhook → local membership → PMS login path and required failure
case pass, followed by explicit human acceptance.
