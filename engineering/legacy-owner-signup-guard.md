# Prepared-owner signup guard

VAY-2017 deny-only application slice, following
[account setup](legacy-owner-account-setup.md) and
[identity architecture](workos-identity-architecture.md). Wires the caller
paths below; no grants, account preparation, deployment or production authorization.

## Reuse the receipt, do not add another registry

Presence of an internal user UUID in
`platform.legacy_owner_bootstrap_receipts.owner_user_ids` is sufficient to **deny**
ordinary account linking or mutation. It is not sufficient to approve a mapping,
activate an account or grant access. Check regardless of user status, receipt
environment, timestamp or expiry: questionable evidence must not remove a denial.
There is no release in this slice. Never delete the receipt to unlock an owner.

The shared app helper takes the caller's transaction client and exact
resolved internal UUID, returning normally only for an explicit false result:

```sql
SELECT EXISTS (
  SELECT 1
  FROM platform.legacy_owner_bootstrap_receipts
  WHERE $1::uuid = ANY(owner_user_ids)
) AS protected;
```

True, malformed results, missing table/schema, permission failure and other query
errors deny with a sanitized error. Never fall back to email linking or treat
unavailable storage as an empty registry. Do not log email, input payload or raw
database errors. No hardcoded owner list, environment flag, cache, timestamp
comparison, new registry or signature verification belongs in this deny helper.

## Exact first callers

In `apps/api/src/platform/identityLifecycle.ts:createIdentityUser`, retain BEGIN
and provider locking. Check immediately after resolving an existing internal ID
by provider, and separately after resolving it by email, before either branch
can insert/update an external identity or call `grantIdentityAccessWithClient`.
Denial rolls back the entire transaction; it is not an idempotent success.
Even an exact provider match does not bypass the prepared-owner hold.

In `apps/api/src/platform/workosWebhooks.ts:upsertWorkosUser`, retain BEGIN and
provider locking. Check immediately after resolving the provider's internal ID,
before updating either users or external identities. Deny the whole upsert for
a held owner, including an apparently harmless profile or email update. Existing
code protects suspended/deleted users from active input but can activate pending
users; relying on that CASE expression would therefore lose the preparation hold.
Webhook failure must remain visible/recoverable, not acknowledged as applied.

No existing ID means normal creation remains unchanged, subject to the separately
installed scoped unique index. A uniqueness error must roll back, never trigger
email-based recovery or a replacement-ID retry. This guard does not stop provider
side effects that an upstream signup flow already dispatched.

## Direct lifecycle email and status changes

`updateIdentityUserEmail` and `updateIdentityUserStatus` first lock the exact user
with SELECT FOR UPDATE in their transaction. If absent, preserve accepted no-op
without later updates: a prepared user inserted after the lookup must not become
an unguarded update target. For a present user, check its receipt before any email
change or status update to active/pending. Same-value requests are not exceptions.
Both local email caches commit together; failure of either update rolls back both.

Explicit suspended/deleted status updates remain available without a receipt
read, including during receipt-store outages. Existing suspend, delete and revoke
commands remain unchanged. These exceptions only retain their existing restrictive
behavior; no receipt removal or access release is introduced. Lifecycle profile
updates are not covered by this slice and cannot be cited as immutable identity
evidence without a fresh check.

## Transaction and deployment prerequisites

The future bootstrap writer must insert previously absent users and their receipt
in **one transaction**. Under READ COMMITTED, a later lookup cannot see that
committed user without its receipt. If signup misses an uncommitted prepared user,
the scoped unique index must arbitrate its INSERT race. No writer may append a
receipt to an independently existing user as a substitute for atomic preparation.
Test both commit orders; do not infer race safety from query-double tests.

Deploy receipt schema first. The real application role needs schema USAGE and
only `SELECT (owner_user_ids)` on the receipt table, with no receipt write or
authority-column privileges added. Resolve the role from reviewed deployment
configuration; do not invent or broaden a principal. Verify this exact read under
that role before deploying callers. Missing privileges fail closed, which can
interrupt ordinary existing-user flows too; readiness and rollout must expose
that failure before traffic reaches the new callers.

Schema/read privileges are prerequisites to rollout, not blockers to local helper
implementation. Deploy and drain old app workers/transactions before preparation;
old callers are not protected. Verify the exact valid scoped index and all shared
mutation guards before any owner insertion. Retain guards across app rollback;
once prepared rows exist, rolling back to unguarded app code is unsafe.

## Preparation remains blocked after the first callers

Receipt lookup alone does not police every identity mutation. Before enabling
preparation, separately cover access/resource-link grants, webhook membership
reconciliation, session reconciliation and other
identity writers. Inventory their direct SQL and transaction boundaries. Do not
block legitimate suspension/deletion by blindly placing a blanket guard ahead of
all lifecycle commands; restrictive actions need their own reviewed behavior.

A future approved provider adapter must establish exact external/internal mapping
from durable evidence, not from email. Provider completion and eventual access
release require their own contract; this receipt has no such checkpoint. A
prepared owner cannot become usable just because these first guards are deployed.

## Focused acceptance tests

| Case                                                                | Required observation                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| UUID absent from receipts                                           | Explicit false; existing ordinary caller behavior unchanged.                     |
| UUID in any receipt, pending/active/suspended/deleted               | Deny; no status-based escape.                                                    |
| Malformed result or table/read privilege missing                    | Sanitized denial; transaction rolled back.                                       |
| Email match with new provider, with or without organization payload | No external identity, membership, organization or access write.                  |
| Existing provider maps to held UUID                                 | No replay grant; webhook cannot activate or change identity fields.              |
| Unrelated user / unrelated duplicate email                          | Existing behavior unchanged when schema/read readiness passes.                   |
| Bootstrap commits before signup lookup                              | User and receipt visible together; linking denied.                               |
| Signup races bootstrap insert, in either commit order               | Unique index selects at most one row; loser rolls back without email-link retry. |
| Receipt insert fails                                                | No prepared user remains; no contact/provider calls.                             |
| Scoped app reader role                                              | Boolean read works; receipt write and authority-column reads denied.             |

Run real synthetic PostgreSQL16/17 transaction and privilege fixtures as well as
focused caller tests. An unwired helper test is not a deployed signup test and
does not satisfy the remaining mutation, provider or access-release gates.
