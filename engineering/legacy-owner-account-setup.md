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
An internal pending row therefore remains non-authoritative: it cannot advance
to provider creation or ownership restoration until a reviewed current-principal
resolution binds an authenticated existing principal or independently proves
absence. Inability to rule out another current principal blocks reconciliation.

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
  current-principal resolution disposition, observation start/end/source
  horizon and expiry to one canonical payload hash. Every observation used for
  a mutation must remain within the diagnostic contract's maximum fifteen-minute
  window; approval expiry alone is not evidence freshness. Contact and principal
  evidence belongs in protected storage; public reports contain neither emails
  nor reversible payloads.
- Use distinct immutable migration/security authority records under VAY-1320's
  sole-human dual-authority policy, with controlled signer/executor separation.
  The ownership-restoration approval does not authorize this new operation.
  General chat permission and a passed readback are not signed write evidence.
- Recheck exact-ID, normalized-email and external-identity conflicts under the
  serialized write transaction, together with current ownership, restrictions,
  target absence and contact/principal disposition. Unknown normalization,
  ambiguous matches, missing current source evidence, newer restrictions,
  revoked/expired approval, a different-ID/different-email candidate, inability
  to prove principal absence or target drift block. Snapshot freshness must not
  be relabeled as current ownership.
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

## Provider preparation is a later, separate operation

Only after an approved internal-row receipt and a fresh source/target/provider
assessment may a reviewed provider adapter create an absent WorkOS identity
with `external_id` equal to that same internal UUID. No email-only linking,
legacy password import, automatic email verification or existing-user update.
Do not change ordinary signup or session reconciliation to force this mapping.

Provider creation additionally requires the approval-bound current-principal
resolution to prove absence within the same maximum fifteen-minute observation
window. If it instead binds an authenticated current principal, or another
principal cannot be ruled out, stop for separately reviewed identity
reconciliation; never create a second principal for the legacy UUID.

The create adapter must close the absence-check-to-create race with ordinary
signup. It must use a provider-supported idempotency key bound to the immutable
intent and prove atomic uniqueness/conflict behavior for both `external_id` and
normalized email. A preflight lookup alone is not a collision boundary. If the
provider cannot supply those guarantees, a separately authorized reservation
shared with signup is required and the adapter remains non-executable until it
exists. Any collision returns to independent reconciliation; it never selects,
updates or links the colliding principal automatically.

Before dispatch, commit a durable intent bound to the exact command, owner,
contact evidence and provider environment. A provider request must not run while
a database transaction is held open. Immediately before dispatch, repeat the
current target/provider/ownership/restriction/contact checks and reject if their
observation window has expired or drifted. In that same serialized transaction,
atomically claim exactly one `pending` intent as `dispatching` before releasing
the transaction. A canceled or already claimed intent rejects dispatch. A
cancellation may atomically change only `pending` to `canceled`; once claimed,
it cannot claim that dispatch was prevented and must instead preserve the
uncertain outcome for recovery. Recovery of `dispatching` never issues another
create: it resolves only through the original idempotency key and verified
provider evidence. A later attempt requires a new command and intent. On
success, record the exact provider ID and link it only after fresh identity
checks and conditional local persistence.

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

Cancellation of a still-pending intent blocks further dispatch and appends a
receipt; cancellation of a claimed intent is rejected and reported as an
uncertain operation. Neither case deletes the user or provider identity. A later
cleanup would require exact before-state, no-newer-use/dependency checks and
separate authorization. Preserve evidence of partial completion, and never
erase a conflict to make a rerun pass.

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
authenticated-existing-principal and different-ID/different-email candidates,
unprovable absence, future/malformed or older-than-fifteen-minute observations,
audit failure, rollback and preserved protected fixtures. Assert zero provider
calls and no organization/membership/resource/entitlement changes.

Provider intent/adapter/recovery tests come afterward: dispatch failure, timeout,
duplicate dispatch, concurrent ordinary signup during initial create, atomic
external-ID/email collision handling, pending-versus-dispatching cancellation,
provider-success/local-failure, external-ID mismatch, email collision,
pre-dispatch principal/contact drift, newer local restrictions and no user
notifications. Test product denials after preparation; login or health alone is
not an access test.

No existing read approval authorizes either writer. Real isolated rehearsals and
production execution require their own exact write/recovery approval. This
document and its review do not complete VAY-2017.

## Internal receipt storage (0224)

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
and active/pending status changes. New-UUID
inserts still need the scoped index; other identity mutation paths remain
unguarded. Do not enable preparation until the entire shared boundary is covered.

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
expression. The expression pins case folding to PostgreSQL's `C` collation;
unknown normalization correspondence blocks. It uses immutable native functions
for UTF8 text bytes; tests compare it against `convert_to(...,'UTF8')`, including
backslashes and Unicode. Do not substitute a
different normalization or treat JS lowercase as universally equivalent.

Use a separately approved transactional DDL window with bounded lock/statement
timeouts. Index construction scans the user table and blocks writes during the
build, including unrelated signup; this operational cost needs explicit scope.
Do not use IF NOT EXISTS as proof: verify the exact schema, expression, predicate,
uniqueness and valid/ready flags of the installed index before any account write.
Retain the guard after preparation; removal needs separate drift/recovery review.

Uniqueness is not ownership or linking authority. The prepared-owner guard covers
only selected caller paths; the provider path must still bind the exact approved
external/internal identity. Neither this partial protection nor an installed
index enables account preparation.
