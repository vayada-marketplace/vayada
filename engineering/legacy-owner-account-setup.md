# Missing legacy owner account setup

VAY-2017 prerequisite design, following the [diagnostic planner](legacy-owner-bootstrap-planner.md),
[identity architecture](workos-identity-architecture.md) and
[ownership restoration](legacy-pms-ownership-restoration.md). Proposed technical
contract; not an approved write manifest, implemented executor or cutover GO.

## Why a separate path

The authorized September 14 source/target readback confirmed eight historical
owner/hotel associations and no live Next users under those IDs or snapshot
emails. Different-ID/different-email accounts remain possible. Earlier WorkOS
reads are separate observations, not fresh provider evidence for an apply.

The broad `workosBackfill` cannot seed missing internal users. The identity
migration writer uses timestamp-based upserts, not exact expected-absence
guards. Neither is an approved eight-owner repair command.

Account preparation does not establish current ownership or grant hotel access.
Keep the existing authenticated-owner requirement for ownership restoration.
Creating a provider identity is not proof that its eventual operator owns the
historical hotel, even if they verify the historical email address.

## Smallest first write boundary

The first future writer prepares **internal identity rows only**. For an
independently approved subset of the fixed eight-owner cohort, insert only
`identity.users` with the exact legacy UUID, reviewed contact fields, and an
explicit `status = 'pending'`. Do not rely on the schema's `active` default or
generate a replacement UUID. Missing names may remain null; do not invent them.

Create no organization, membership, resource link, entitlement, hotel or provider
identity in this step. Record required organization/membership dependencies as
unresolved prerequisites using the existing canonical IDs; do not satisfy them
with fabricated or globally activated rows. Preserve both protected QA hotels.

The whole approved subset commits atomically with its restricted receipt/audit.
A conflicted owner is excluded only by a newly reviewed subset, never silently
dropped by the executor. Existing users are not updated, even when pending.
An exact prior success is replayed from its receipt, not inferred from row shape.

## Evidence and approval before any write

- Bind command version/ID, environment and independently verified database
  identity, exact owner IDs, intended row values, source run/ledger/row hashes,
  fresh current ownership/restriction evidence, expected target absence and
  expiry to one canonical payload hash. Contact evidence belongs in protected
  storage; public reports contain neither emails nor reversible payloads.
- Use distinct immutable migration/security authority records under VAY-1320's
  sole-human dual-authority policy, with controlled signer/executor separation.
  The ownership-restoration approval does not authorize this new operation.
  General chat permission and a passed readback are not signed write evidence.
- Recheck exact-ID, normalized-email and external-identity conflicts under the
  write transaction. Unknown normalization, ambiguous matches, missing current
  source evidence, newer restrictions, revoked/expired approval or target drift
  block. Snapshot freshness must not be relabeled as current ownership.
- Serialize duplicate command IDs and overlapping owner/email keys. Application
  advisory locks alone cannot exclude ordinary signup writers. The storage
  design must prove a database-enforced collision boundary shared with signup,
  or a separately authorized write fence. Until that exists, the writer remains
  non-executable; do not assume an email uniqueness constraint is present.
- Verify authority before replay lookup. Same command with different bytes
  rejects. Successful exact replay returns only its immutable receipt and grants
  nothing; revoked or stale evidence cannot authorize another write.

This design does not add a registry migration. The next storage PR must specify
receipt uniqueness, append-only privileges, audit atomicity and approval locking
before a consumer can use it. No invented principal or synthetic signature may
authorize a real operation.

### Separate setup signature boundary

The setup envelope uses `contractVersion = legacy-owner-internal-setup.v1` with
exact fields `commandId`, `environment`, `issuedAt`, `expiresAt`, `commandSha256`,
`migrationApprovalRecordId`, `securityApprovalRecordId` and `signingKeyId`.
Require canonical JSON, distinct authority record IDs, a valid current time
window and an allowlisted Ed25519 public key. Signature bytes use the fixed
prefix `vayada:legacy-owner-internal-setup:v1\0envelope\0`; never accept the
ownership-restoration signature domain or a caller-selected operation domain.

The signature checker compares `commandSha256` against an independently supplied
expected digest for the complete protected command described above. It does not
define or validate that command's row/evidence schema, authenticate its contents,
read approval records, establish signer/executor separation or permit writes.
The future consumer must derive the expected digest from the reviewed complete
command, not echo the envelope field. A successful signature check returns only
`signature_matches_requires_registry` and `executable: false`.

Keep the existing ownership-restoration verifier unchanged and unable to accept
setup envelopes. Admission of setup approvals to existing immutable storage,
revocation serialization and full command validation remain separate required
implementation steps; migration 0193 currently accepts only ownership evidence.

## Provider preparation is a later, separate operation

Only after an approved internal-row receipt and a fresh source/target/provider
assessment may a reviewed provider adapter create an absent WorkOS identity
with `external_id` equal to that same internal UUID. No email-only linking,
legacy password import, automatic email verification or existing-user update.
Do not change ordinary signup or session reconciliation to force this mapping.

Before dispatch, commit a durable intent bound to the exact command, owner,
contact evidence and provider environment. A provider request must not run while
a database transaction is held open. On success, record the exact provider ID
and link it only after fresh identity checks and conditional local persistence.

| Observed outcome                             | Required recovery                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Proven no request was dispatched             | Fresh approval/checks before dispatch.                                                                       |
| Provider succeeded, local persistence failed | Recover the exact provider ID from durable evidence and verified external-ID lookup; never recreate blindly. |
| Timeout or unknown dispatch/result           | Retain unresolved intent; no automatic create retry based on a temporary 404.                                |
| Existing identity or email collision         | Stop for independent reconciliation; neither overwrite nor link by email.                                    |

The implementation must demonstrate provider-supported uniqueness/idempotency
and visibility semantics before allowing automatic recovery. Until then,
uncertain outcomes stay blocked. Do not assume a distributed transaction exists.
Prove creation causes no automatic notifications before any no-contact rehearsal.
Invitations, verification/reset mail and other user contact need separate scope.

## Cancellation and access remain separate

Cancellation blocks further dispatch and appends a receipt; it does not delete
the user or provider identity. A later cleanup would require exact before-state,
no-newer-use/dependency checks and separate authorization. Preserve evidence of
partial completion, and never erase a conflict to make a rerun pass.

Pending identity preparation must remain denied by existing product gates.
Do not globally activate a user, organization or membership for a smoke test.
Finish the scoped PMS session/organization/authorization/resource chain and
independently verify the current owner before enabling access to existing hotels.
Marketplace approval, Channex activation and legacy shutdown remain unchanged.

## Required tests and next implementation

First specify the shared collision guard and receipt storage, then build the
internal-only writer with synthetic PostgreSQL16/17 fixtures. Cover explicit
pending status, exact UUID preservation, extra IDs, email collisions, concurrent
ordinary signup, duplicate commands, payload drift, revoked/expired approval,
audit failure, rollback and preserved protected fixtures. Assert zero provider
calls and no organization/membership/resource/entitlement changes.

Provider intent/adapter/recovery tests come afterward: dispatch failure, timeout,
duplicate dispatch, provider-success/local-failure, external-ID mismatch, email
collision, newer local restrictions and no user notifications. Test product
denials after preparation; login or health alone is not an access test.

No existing read approval authorizes either writer. Real isolated rehearsals and
production execution require their own exact write/recovery approval. This
document and its review do not complete VAY-2017.

## Internal receipt storage (0194)

`platform.legacy_owner_bootstrap_receipts` records one immutable success per
command ID, with the operation version, environment, canonical sorted unique
subset of one to eight owner UUIDs, source run and evidence hashes, target
before/after hashes, approval-envelope hash and executor-principal hash. It
contains no contact fields or provider credentials. The checkpoint is restricted
to `internal_users_prepared`; it cannot represent provider or access completion.

The table rejects UPDATE, DELETE and TRUNCATE and grants no PUBLIC access or
executor privilege. Owner UUIDs are historical evidence, not foreign keys that
prevent later legitimate account deletion. A future controlled writer must
insert pending users and the receipt in the same transaction, after approval
locking and all collision checks; receipt insertion failure rolls back both.
Storage does not verify signatures, prove the owners were prepared or implement
replay. Its hashes must be revalidated by the consumer, never treated as approval.

The [prepared-owner signup guard](legacy-owner-signup-guard.md) denies receipt-marked
existing-user reuse in lifecycle creation/webhook upserts, lifecycle email changes
and active/pending status changes, plus the shared subject access-grant helper. New-UUID
inserts still need the scoped index. Preparation remains blocked until the
applicable identity writers, session denial and collision boundary are verified
together; separate stacked PRs are not an integrated release.

## Organization changes are not owner restoration

This contract inserts only previously absent pending users and their receipts;
it creates no memberships. A membership's user foreign key prevents an existing
membership from referencing an absent user. Consequently, changing an existing
organization's resource links or product entitlements alone cannot grant the
newly prepared owner access. This conclusion depends on the strict absent-user
contract and the guarded membership writers; it does not apply to preparing an
existing account or appending a receipt afterward.

Do not introduce an organization-wide hold or infer historical ownership from
an email match or current membership enumeration. Other authorized members may
continue legitimate work. Before later restoration, compare current organization,
membership, resource-link and entitlement state with the exact independently
approved before-state. Drift invalidates that restoration attempt; it is not
permission to overwrite current state with legacy values.

Privileged commands that name a target account remain separate review points:
admin track activation (`adminActivation.accountUserId`), property provisioning
(`targetAccountUserId`) and offer creation (`hotelUserId`). Their existence is not
proof of an absent-owner bootstrap bypass, nor are they certified for subsequent
access release by this analysis. Reassess them against that later operation's
contract before restoring memberships or releasing access.

The session hold in PR #2216 is a sibling of the membership/staff guard stack,
not included merely by deploying PR #2232. Integrate and test both with receipt
schema/read privileges and the scoped collision index before preparation.
This scope clarification adds no executor or write authority and waives no
production-readiness or ownership-verification gate.

## Scoped email-index proposal

`planLegacyOwnerEmailIndex` proposes a partial unique index covering exactly eight
independently approved normalized-email SHA256 values. The key and predicate
contain hashes, not plaintext contact data. PostgreSQL uniqueness arbitrates
INSERT/UPDATE races even for writers unaware of migration advisory locks.
Duplicates outside this email cohort remain allowed; existing in-cohort
duplicates prevent index creation and must not be deleted or merged to proceed.

This helper only produces SQL; no migration, CLI or executor runs it. Before an
authorized installation, independently bind the eight hashes to approved source
owners and a UTF8 target database, using the same database normalization and hash
expression. Unknown collation/normalization correspondence blocks. The expression
uses immutable native functions for UTF8 text bytes; tests compare it against
`convert_to(...,'UTF8')`, including backslashes and Unicode. Do not substitute a
different normalization or treat JS lowercase as universally equivalent.

Use a separately approved transactional DDL window with bounded lock/statement
timeouts. Index construction scans the user table and blocks writes during the
build, including unrelated signup; this operational cost needs explicit scope.
Do not use IF NOT EXISTS as proof: verify the exact schema, expression, predicate,
uniqueness and valid/ready flags of the installed index before any account write.
Retain the guard after preparation; removal needs separate drift/recovery review.

`verifyLegacyOwnerEmailIndex` checks a catalog snapshot against the exact scoped
proposal on PostgreSQL 16/17. It requires UTF8, standard-conforming strings and
`search_path = pg_catalog`; callers set these within their controlled transaction.
It compares exact PostgreSQL expression/predicate rendering without stripping
literal whitespace or casts, plus table/schema, btree/text operator class,
default collation, database collation-version consistency, unique/valid/ready/live
flags and single-expression/no-INCLUDE shape. The underlying email column must
also be ordinary non-null text with default collation: its collation controls
`lower`, even when the final encoded hash has default collation. Unknown rendering or metadata
fails closed with a sanitized error; this is deliberately not a general SQL
equivalence checker. No row or DDL writes occur in the check.

A passed snapshot is neither approval nor protection from a later DROP INDEX.
The future writer must acquire an independently authorized DDL-excluding table
lock before this check and retain it through its write transaction. Independently
bind the supplied hashes to the approved owners, database and normalization;
the helper cannot establish those facts or verify historical index build quality.
It returns `executable: false` and does not enable preparation on its own.

Uniqueness is not ownership or linking authority. The prepared-owner guard covers
only selected caller paths; the provider path must still bind the exact approved
external/internal identity. Neither this partial protection nor an installed
index enables account preparation.

## Local collision and atomicity evidence

`legacyOwnerBootstrapRace.integration.test.ts` uses a fresh dedicated loopback
database and the proposed index. It forces a competing insert to block on the
first transaction (observed through PostgreSQL blocking PIDs), then tests both
commit orders. A committed pending user and receipt exclude the competing signup;
a committed signup excludes the pending-user insert without leaving a receipt.
If receipt insertion fails, rolling back preparation permits the waiting signup
and leaves no prepared account. Uncommitted users/receipts are invisible to a
third connection; all resulting users remain without memberships.

These are synthetic SQL storage-contract tests, not an implemented executor or
real signup/API flow. They do not validate installed production index metadata,
signature/approval handling, current ownership, or provider behavior. Those
checks remain prerequisites; no fixture receipt authorizes real preparation.
