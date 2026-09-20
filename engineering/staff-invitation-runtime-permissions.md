# Staff invitation runtime permissions (VAY-2038)

## Decision

The `vayada_next_api_runtime` role must be able to create and accept staff
invitations without becoming an unrestricted writer of identity state. WorkOS
delivers the invitation; the identity domain owns the local invitation,
membership, property assignment, and audit changes. The current runtime
preflight intentionally rejects all identity writes and all callable
`SECURITY DEFINER` functions. That policy must change deliberately, with an
exact allowlist, before the invitation flow can work on the hosted stack.

A direct `INSERT` grant on `organization_memberships` is **not acceptable**:
the role could insert an active `hotel_manager` membership for an arbitrary
user and organization. Column-limited `UPDATE` is also insufficient because
changing `role_key`, `status`, or `permission_overrides` can elevate or revoke
access across tenants. The first PostgreSQL
fixture proved that such grants make the existing-user flow work, but the
adversarial review rejected them as an authorization boundary. Do not deploy
that prototype.

Do **not** grant table-wide `UPDATE` on `identity.users`,
`identity.organizations`, `identity.external_identities`,
`identity.organization_roles`, `identity.organization_resource_links`, or
`hotel_catalog.properties` just to satisfy `SELECT ... FOR UPDATE/SHARE`.
PostgreSQL requires `UPDATE` privilege on at least one column for these locks;
even a column-level grant permits a real write to that column. Locking through
an audited, narrowly scoped `SECURITY DEFINER` function is preferable.

## Required operations

| Stage | Current SQL operations | Runtime authority to add |
| --- | --- | --- |
| Create | Lock active hotel organization, active inviter membership and user; lock any existing invitation and selected custom role; insert or supersede invitation and property assignments | Restricted lock functions plus a guarded create transition; no direct invitation or assignment write grant until its scope is proven safe |
| Deliver | Claim invitation, call WorkOS, record provider invitation ID or uncertain delivery | A guarded pending-invitation delivery transition; no provider credential in database |
| Accept | Lock organization, invitation, provider identity and user, manager, invitation assignments and active property links; upsert membership; replace property assignments; mark invitation accepted; append audit; enqueue inbox reconciliation | Restricted lock functions; a guarded identity-owned acceptance transition that enforces provider binding, recipient, inviter, staff role, property scope, and protected-membership checks; existing audit `INSERT` |
| New user | WorkOS callback resolves or creates the internal user and provider mapping before acceptance | A separate guarded identity-owned WorkOS user-provisioning transition; never grant unrestricted `users`/`external_identities` writes merely to make the callback work |
| Worker | Consume the fixed PMS inbox reconciliation job | A reviewed worker role/privilege boundary for `platform.jobs`, `platform.job_attempts`, and terminal dead-letter events; enqueue success alone is not end-to-end completion |

The invitation endpoint must not send a WorkOS invitation until local
`persist()` commits. The accepted-invitation webhook remains the only path that
activates the local membership. Denied, expired, conflicting, and replayed
events must retain their existing behavior.

## Rollout gates

1. Add specific lock functions in the identity-owned schema, each with fixed
   schema-qualified SQL, `search_path = pg_catalog`, no dynamic SQL, no
   provider secrets, and revoked `PUBLIC` execution. Verify they hold locks
   for the caller's transaction and cannot mutate rows.
2. Implement guarded transitions for invitation creation/delivery/acceptance
   and new-user provisioning. The acceptance transition must take values from
   a pending, delivered, unexpired invitation and verified provider identity,
   not accept arbitrary role, organization, or job arguments from the caller.
   Test that direct runtime creation of a manager membership and cross-tenant
   updates fail.
3. Add only the resulting function-execution and unavoidable append-only
   privileges to the platform grant runner and restricted-runtime preflight.
   Require ownership and negative privilege checks. Keep receipt/evidence
   tables, role escalation, arbitrary functions, schema creation, and
   unrelated writes forbidden.
4. Deploy the schema before granting execution. Grant and run the hosted
   preflight before switching the app to the lock functions. Fail closed if
   any stage is absent. Review each PR independently; no ad-hoc live grant.
5. Run PostgreSQL 16 and 17 restricted-role tests for create, delivery,
   acceptance, replay, invalid scope, and cross-organization denial. Then
   verify the exact deployed image and coordinate a single real hosted
   invitation using the reusable QA users and property. Do not create new
   accounts or retry an unchanged hosted 500.

The existing VAY-2038 ticket remains In Progress until the real hosted
invite → WorkOS callback → accepted webhook → local membership → PMS login
flow is demonstrated and accepted by a human.
