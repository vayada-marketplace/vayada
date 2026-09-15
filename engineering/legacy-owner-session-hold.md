# Legacy owner session-resolution hold

VAY-2017 adds a deny-only boundary to the production Postgres identity
repository's `findUserByProviderUserId`. The provider identity, internal user,
and receipt membership are read in one SQL statement/snapshot. Any matching
`platform.legacy_owner_bootstrap_receipts.owner_user_ids` entry holds the user,
including an already-active user. Receipt environment, expiry, or other
metadata cannot release this hold.

Only an explicit SQL boolean `false` permits returning an existing identity.
A protected or malformed result throws sanitized
`AuthError(USER_RECONCILIATION_REQUIRED)`. Missing storage, missing privileges,
and other query failures throw a sanitized infrastructure error. These cases
never return `null`, which session callers can interpret as permission to enter
JIT identity creation or their lifecycle-result fallback. A successful query
with no matching user still returns `null`; ordinary identity fields and status
are unchanged. The hold neither fabricates a suspended status nor writes data.

## Shared boundary and limits

Both production repository instances in `apps/api/src/server.ts` use this
factory: auth-session flows and authenticated request-context resolution.
Consequently login/callback/refresh and existing bearer-session paths that
resolve an internal identity through this repository encounter the hold.
Request-context resolution stops before organization/membership/resource reads.
No route-specific bypass, configuration flag, or release mechanism is added.

This is a target application read guard, not a provider-session revocation.
It does not undo upstream provider calls made before identity resolution,
invalidate tokens independently consumed by legacy systems, establish current
identity or ownership, or guarantee behavior of custom/test repositories.
It does not enable preparation, linking, approval, or product access. Mutating
writers still need their own transaction-safe guards.

## Rollout prerequisites and verification

Migration `0212_legacy_owner_bootstrap_receipts.sql` must exist before this
repository is used. The runtime database principal needs schema `USAGE` and
receipt `SELECT(owner_user_ids)` (or equivalent broader existing SELECT), with
complete row visibility. This change installs no grants and does not establish
the actual deployed role or its RLS configuration. Unavailable receipt storage
or privileges fail closed for ordinary lookups too: rollout verification is a
hard prerequisite, not a reason to add a missing-table bypass.

Focused mocked-query tests cover protected active/pending users, explicit-false
handling, unchanged ordinary statuses/profile fields, missing/denied/broken
storage sanitization, genuine absence, and existing-session short-circuiting.
The opt-in `LEGACY_OWNER_SESSION_TEST_DATABASE_URL` integration suite executes
the real repository SQL against a dedicated disposable local PostgreSQL database.
It verifies ordinary/absent identities, active/pending holds, column-only receipt
SELECT, and missing privileges/storage. Its fixture client owns a rollback-only
transaction, including temporary role grants and table renaming; use no shared
or deployed database. These checks are not real provider, deployed-role, or
production-session evidence.

## Commit-runner integration

The reviewed session implementation from PR #2216 is included unchanged in the
owner commit-runner integration after #2334; only this migration-number reference
and integration note change. The guard must be deployed and its runtime receipt
visibility verified before pending-owner preparation. Passing isolated package
tests does not prove the deployed runtime role or permit production execution.
Keep this guard on rollback after preparation; do not roll back to a release that
can resolve prepared owners without checking their immutable receipts.
