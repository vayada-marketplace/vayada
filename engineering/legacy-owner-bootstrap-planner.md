# Missing-owner diagnostic planner (VAY-2017)

Prerequisite diagnostic for [ownership restoration](legacy-pms-ownership-restoration.md),
following [stable internal identity rules](workos-identity-architecture.md).
It does not relax the existing authenticated-owner requirement.

`planLegacyOwnerBootstrap` evaluates sanitized observations for the owners of an
independently approved migration cohort: one owner UUID per cohort PMS hotel (VAY-1362 P19;
wave 1 has three; the original preparation used eight). It accepts no emails, passwords,
provider secrets or write client. Missing or conflicting evidence blocks; an
unblocked row proposes only the next engineering/verification step.

The caller must separately verify and bind the completed immutable source run,
source hotel/owner checksums, target environment and complete exact-ID/email
lookups to those owners. `complete` and `matched` are reader attestations, not
proofs verified by the planner. Never expose this helper as an HTTP authority
or feed untrusted summaries to an executor. Existing live readback reports are
insufficient: they do not establish current source ownership or full target
conflict evidence. Synthetic tests are not a production readiness result.

Observations have an at-most 15-minute validity window and must match the
independently expected run/environment. The source snapshot's date is separate
from observation freshness; rereading an old snapshot does not prove current
legacy state. Any execution must refresh restrictions/ownership independently.
Every cohort owner's row must be present once, with no extra IDs. A per-owner blocker
blocks the aggregate plan but retains the other owners' diagnostic next steps.

Absent target/provider identities propose missing-identity preparation, not
creation. An exact target without provider identity proposes provider setup.
Exact target/provider identities propose authenticated identity verification.
Provider-only identities require reconciliation, and email-only matches cannot
authorize linking. Unknown or genuinely restricted statuses block. No account
activation, email verification, membership, entitlement, hotel or Channex state
is planned or written. Both protected QA properties remain outside this helper.

This slice is pure diagnostic logic only: no production adapter, database read,
SQL allowlist enforcement, cryptographic approval, organization/membership
dependency planning, provisioning, user contact or apply command. Those remain
separate reviewed slices with exact scope, conflict/recovery tests and approval.
The current broad WorkOS backfill must not be run as a cohort-owner repair.

## Scoped target reader

`readLegacyOwnerBootstrapTargets` is the first adapter. It accepts the cohort's
independently authorized, source-bound ID/email pairs (at least one, distinct), copies them before I/O,
and requires a read-only session/transaction. One parameterized SELECT matches
only those IDs or normalized emails in target users, plus associated WorkOS
identity conflicts. Results contain owner IDs, target classifications and, for
one target binding, a format-bounded provider ID plus email-match boolean;
malformed provider IDs are redacted. Database errors are replaced with a fixed
code to avoid parameter disclosure.
This adapter accepts only ASCII email addresses and uses PostgreSQL `C` collation
for database-side case folding so JavaScript and PostgreSQL cannot disagree;
any internationalized address fails closed for a separately reviewed path.

Deleted/suspended/unknown target statuses block, as do different-ID email
candidates, mismatched emails on an exact ID, duplicate linked WorkOS identities,
and WorkOS email mappings belonging to another user. Missing or duplicate result
rows fail the read. An exact pending user is not activated or granted access.

Caller must independently verify the DB environment and full table visibility
(including RLS), supply scoped source values, and manage connection/transaction
lifetime. This helper does not prove source ownership or provider state and does
not set planner completeness. No production runner is wired; provider reads,
source verification and organization/membership dependency checks remain pending.

## Bounded source prerequisite

`readLegacyOwnerBootstrapSources` reads only the approved owner/hotel pairs (one per
cohort PMS hotel, each owner and hotel distinct) from a completed immutable source run. The independently approved request must
bind ledger SHA256 and each row's ID, ordinal and checksum. The reader rehashes
the selected PostgreSQL JSON in SQL and checks snapshot-identifier provenance;
it does not replace full extraction/parity validation with a partial table scan.
Ledger hash approval must follow that full validation. Unrelated row payloads
are never returned; metadata for the run is read to verify the ledger hash.
The reader also revalidates the exact four-source/table inventory, fingerprint
parity and aggregate counts/checksums; a signed but incomplete ledger is denied.

Requires a caller-owned REPEATABLE READ or SERIALIZABLE read-only transaction
and verifies one PostgreSQL transaction ID spans every read, so matching session
defaults without `BEGIN` are denied. It also requires verified environment/full
table visibility. Exactly two source rows per pair
are required; the query caps at one more to detect duplicate/extra matches. The
result includes sensitive email only for in-memory downstream comparison, not
reporting. It proves a historical association, not current source ownership or
production readiness. Protected QA hotel IDs are rejected. No writes occur.

## Combined diagnostic assessment

`assessLegacyOwnerBootstrap` composes the scoped source reader, scoped target
reader and WorkOS exact external-ID/email GET lookups. Each database read uses
its own REPEATABLE READ, READ ONLY transaction, rolled back and released before
provider calls. Cleanup failure blocks and discards the connection. The provider
client exposes only read methods. A pinned organization control checks provider
configuration, not hotel ownership. Lookup pagination/errors/filter mismatch
fail closed; 404 is absence only for exact external-ID lookup. An email-only
candidate never authorizes a link. Known source/target blockers skip user lookups.
For an existing target user, its single sanitized WorkOS provider-user binding
and email-match flag must agree with the live external-ID lookup. Missing,
different, malformed or cohort-reused bindings fail closed as identity conflicts.

The result contains only the non-executable planner diagnosis, with no emails,
provider responses or database errors. Freshness covers the entire assessment,
not just its last request. This is not an atomic snapshot across systems and
does not prove current source ownership: source evidence remains historical.
Before any read it requires the run's cohort (`ProductionMigrationCohort`): the file must be
self-consistent (its checksum re-derives from its ID sets), bind the same source run, and its PMS
hotels must be exactly the requested pairs' hotels, with distinct owners; otherwise it returns
`cohort_mismatch`. This does not prove the cohort's approval, which the caller checks
(`approvalProofSha256`); the stored cohort row is written only at import, after this diagnostic.
Every helper caps the owners at eight, the limit of migration 0224's receipts. A wave in
which one owner holds two cohort hotels therefore blocks (the pairs stay one-to-one).
The caller must verify environments and source approvals; no production runner,
approval validator, identity writer, membership planner or user contact is wired.
