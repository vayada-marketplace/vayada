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
