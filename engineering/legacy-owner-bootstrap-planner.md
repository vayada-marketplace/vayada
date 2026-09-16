# Missing-owner diagnostic planner (VAY-2017)

Prerequisite diagnostic for [ownership restoration](legacy-pms-ownership-restoration.md),
following [stable internal identity rules](workos-identity-architecture.md).
It does not relax the existing authenticated-owner requirement.

`planLegacyOwnerBootstrap` evaluates sanitized observations for an independently
selected cohort of exactly eight owner UUIDs. It accepts no emails, passwords,
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
All eight rows must be present once, with no extra IDs. A per-owner blocker
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
The current broad WorkOS backfill must not be run as an eight-owner repair.

## Scoped target reader

`readLegacyOwnerBootstrapTargets` is the first adapter. It accepts exactly eight
independently authorized, source-bound ID/email pairs, copies them before I/O,
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

`readLegacyOwnerBootstrapSources` reads only the eight approved owner/hotel pairs
from a completed immutable source run. The independently approved request must
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
table visibility. Sixteen exact source rows are
required; the query caps at seventeen to detect duplicate/extra matches. The
result includes sensitive email only for in-memory downstream comparison, not
reporting. It proves a historical association, not current source ownership or
production readiness. Protected QA hotel IDs are rejected. No writes occur.
