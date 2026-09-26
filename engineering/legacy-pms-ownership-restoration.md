# Legacy PMS ownership restoration and historical binding transition

VAY-2017 — PMS-only product intent approved; technical contract under review.
Not authorization to execute a production migration.

## Identity migration provenance (VAY-2017)

Migration `0425` records immutable before/after evidence for PMS-owner identity
chains written by `target:identity:migrate`. Receipts bind the verified extraction
run, deterministic plan checksum, exact table/row ID, existing full-row fingerprint
format, statuses before/after, and the writing transaction's full PostgreSQL XID.
They commit with the identity writes after post-write verification. Dry runs,
rollbacks, unchanged replays, and newer untouched target restrictions produce no
receipt. Existing rows are never retroactively attributed. No runtime grant is added.

This is origin evidence, **not eligibility or access**. Consumers must still verify
proven prior PMS use, current owner/WorkOS control, the exact property chain,
approvals/revocations, and status eligibility. An already-restricted before-state
is not a migration-created restriction merely because another field changed.
Marketplace eligibility remains independent.

After-state fingerprints cannot detect later updates restoring identical values,
including timestamps. A consumer must also match current `xmin` to the low 32 bits
of receipt `transaction_id`, and fail closed unless the current full transaction
ID is at least the recorded ID and less than `2^31` transactions newer. Even benign
later updates invalidate this evidence and require an independently approved
transition, not timestamp/status equality or relabeling the old receipt. Database
restore/rebuild requires fresh evidence. This prerequisite introduces no login
fallback, disposition, provider action, canonical-link transition, or binding activation.

## Evidence and problem

The VAY-1362 September 11 source snapshot retains eight exact PMS hotel/user
associations. Their Auth users are pending, not suspended. Legacy PMS rejects
rejected/suspended accounts but does not reject pending at its account-status
gate (`apps/pms-api/app/dependencies.py`). Marketplace verification is separate.
The target migration derives suspended organization/resource state from pending
users. That is deterministic, but not equivalent to the legacy PMS rule.

Target property authorization requires an active actor, organization and
membership (`packages/backend-authorization/src/index.ts`). Restoring resource
links alone cannot restore interactive access. This decision must not claim
otherwise or silently introduce a pending-user authorization exception.

## Proposed separation

1. **Retain ownership evidence:** a migration-only disposition binds the exact
   source run, source hotel/user checksum, canonical property, organization and
   resource links. Pending is eligible for evaluation, not automatic approval.
2. **Establish current identity:** require an existing authenticated target
   identity matching the retained internal owner. Do not match by email/name,
   create another user, mark email verified, or overwrite newer target state.
3. **Prepare the binding:** only after current eligibility is established may
   a separate signed transition move the exact historical claim to
   `verified_non_active`. Connections remain disconnected with null external ID.
4. **Preserve scoped PMS access:** implement the approved exception below, but
   do not enable it against real owners in this preparation. Provider activation
   is a separate operation. Membership identity, entitlement and cutover gates
   remain; the exact migration-derived pending membership exception is below.

On September 13 Flamur explicitly approved preserving these eight owners'
access to their existing PMS hotels without changing Marketplace approval.
This supersedes the earlier unresolved product-policy question. Pending alone
still grants nothing: an exact, independently verified disposition is required.

## Scoped PMS authorization contract

### Product-access preservation decision (September 14)

Flamur approved preserving proven previous access per product: PMS only,
approved Marketplace only, or both when each is independently established.
This does not mean granting every product to every owner. An existing hotel,
Marketplace profile, email match or social identity alone is not access evidence.
Keep access restricted to the same proven owner and their own hotel resources;
genuine suspensions, revocations and newer restrictions take precedence.

Evaluate Marketplace using its own prior approval and target authorization
requirements. Never use this PMS exception as Marketplace approval, and never
copy an old approval over a newer target denial. Any Marketplace preservation
must have its own product-specific evidence; absence or ambiguity stays denied.

The retained eight-owner snapshot does not establish approved Marketplace
access: four have pending Marketplace profiles and four have no profile in
that snapshot. Therefore this decision does not automatically add Marketplace
access for any of the eight. This is snapshot evidence, not a statement about
their current production status. Current evidence must be checked before any
execution; no production writes or cutover are authorized by this decision.

Test the product matrix explicitly: PMS-only proof cannot authorize Marketplace;
Marketplace-only proof cannot authorize PMS; both require both proofs. Profile
presence or matching contact details cannot substitute for either proof, and a
newer denial overrides stale approval. The scoped PMS mechanism below remains
PMS-only; the common rule is preservation, not a shared all-products bypass.

### PMS exception boundaries

Keep the actual user and organization statuses in the request context. Never
represent a pending actor or migration-suspended organization as globally active.
Use a server-resolved, revocable disposition keyed by internal user, membership,
organization and canonical/PMS property IDs, with immutable migration evidence.
Neither request parameters nor a client token may manufacture this disposition.

The disposition can excuse only the pending-user condition, the exact
migration-derived pending membership and organization/link restrictions proven
to have been derived from that same pending migration row. Retain the actual
membership status; do not activate it globally. The migration's
`membershipStatus` mapping in `productionIdentityOwnershipPolicy.ts` preserves
pending, so a user-only exception would leave these owners denied.
It cannot excuse a true suspension, rejected/deleted owner, absent, inactive,
suspended, revoked or ambiguous membership, missing entitlement, later
restriction, mismatched WorkOS identity or ownership ambiguity. Revalidate
current evidence on authorization; no session-lifetime permission cache may
outlive revocation or a newer denial.

For each resource link, the exception may excuse `suspended` only when the
immutable source link was **active**, the source owner was **pending**, and the
exact target link is proven to be the output of that same migration row and run
through `combinedResourceStatus`. Bind the source link checksum and the target
link ID, product/resource/relationship keys and complete migrated before-state.
Source suspended/archived links, unrelated links, absent provenance, changed
ownership and any later target restriction remain denied. Matching only a status
or timestamp is insufficient. Do not update the stored link to active: both
`resolveEffectivePropertyAccess` and `requirePropertyAccess`, including their SQL
paths, must consume the same scoped disposition or deny. This is not permission
to override all suspended links belonging to the organization.

Resolve the exception only for explicitly classified PMS operations and the
exact existing properties. Default-deny all other operations when using this
exception, including Marketplace, Booking administration, organization/member
administration, new-property creation and Channex enablement. Shared catalog
operations needed by PMS must be explicitly reviewed; a URL prefix alone is
not a product authorization boundary. Collection reads must filter to the
approved property set; individual reads and writes must enforce it again.

Before wiring any entry point, define the shared server-only contract
`legacy-pms-operation-scope.v1` alongside the authorization policy. Its explicit
allowlist maps each reviewed operation identifier to product, action
(collection read, individual read or write), required permission/entitlement and
canonical property-scope enforcement. Start with no permitted identifiers;
implementation adds concrete identifiers only with route/adapter inventory and
denial tests. A method/path prefix or role permission is not an identifier.
Unknown identifiers, contract versions and unclassified operations deny the
exception; no wildcard or caller-supplied classification is allowed.

Policy routes, direct-context routes, shared resource/property adapters and
collection readers must all use that versioned contract, not independent local
allowlists. Collection operations filter to the disposition's exact property set;
individual reads and writes enforce the same set again at the resource boundary.
Marketplace, Booking administration, organization/member administration,
property creation and Channex enablement are outside this contract. A shared
catalog operation requires its own explicit reviewed PMS identifier. Ordinary
active-account authorization remains separate and unchanged.

The implementation must cover the full resolution chain: WorkOS session and
internal identity, organization selection, authorization resolution, route policy
and property repository checks. `resolveRequestContext` currently rejects a
non-active organization before property authorization. Shared
`resolveEffectivePropertyAccess` and its SQL repository require an active actor.
Changing only one guard is insufficient and must not broaden their Booking or
background-service callers. Ordinary active-account behavior stays unchanged.

The first implementation slice must add the disposition evaluator with synthetic
tests, without wiring it into authentication. Subsequent slices must cover:

- `apps/api/src/routes/authSession.ts`: PMS login, refresh and organization
  selection; existing active-only surface checks must not be relaxed globally.
- `packages/backend-auth/src/resolve.ts` and `plugin.ts`: verified bearer
  resolution and a restricted server-only context, not ordinary broad role access.
- `packages/backend-authorization/src/index.ts`: repository status filtering,
  permission narrowing and exact property scope. Both cached-in-context and
  repository-resolved property access must follow the same restrictions.
- `apps/api/src/routes/policy.ts`: both policy entry points and any protected
  route using direct context access. A scoped context cannot pass an unclassified
  policy, even when its role normally contains the requested permission.
- PMS collection/detail/write adapters and session tests: include routes that
  use resource checks without `enforcePropertyRoutePolicy`, plus cross-product
  denial tests with the same authenticated identity.

Do not enable the exception after only one slice lands. A partial deployment
must remain deny-by-default until all consumer boundaries and tests are present.

Historical claim preparation consumes a verified disposition, not an invented
active identity. It does not itself grant interactive access. Connection-state
readiness is independent: the one legacy-inactive connection remains excluded
from automatic binding transition even if its owner's PMS access is eligible.

## Eligibility evidence

The migration-only disposition must include a versioned policy and exact
source/target environment, source run and inventory revision, immutable source
ledger/checksums, source hotel and owner IDs, canonical property/source link,
target owner identity, organization and three ownership-link IDs, complete
target before-state hashes, expiry and approved disposition reason.

Recompute the source chain and enumerate competing ownership/claim rows.
Reject missing, ambiguous, different-owner or cross-property evidence. Reject
source rejected/suspended/deleted/missing owners, retired properties, newer
target denials and revoked approval. Pending source status alone neither rejects
historical ownership nor authorizes live target access. The source-inactive
connection requires a separate explicit readiness decision and is not an
automatic transition candidate. Current authentication does not by itself prove
ownership of a different historical internal user.

No Marketplace profile/listing approval, global user status, provider identity,
entitlement or unrelated organization membership is changed by this command.

## Separate historical transition

Keep VAY-1964's clean-claim adoption verifier and INSERT-only behavior unchanged.
It must continue rejecting all claim history. Add a distinct contract/consumer
for the historical same-pair case; never disguise the operation as adoption.

The registry's unique property/provider and provider/external keys include all
states. Preserve the existing claim UUID, property, provider, external ID,
source and created timestamp. Do not delete the claim or insert a competing
claim. The proposed storage is an append-only transition ledger plus an exact
compare-and-set of the registry's current state, in one transaction. The ledger
retains complete before/after hashes and original historical provenance. This is
not an upsert, and immutable ledger records cannot be updated or deleted by the
runner. Existing applied migrations are never edited.

Before mutation, require exactly one same-pair historical migration claim and
no competing claim for either key. Require every associated connection to be
disconnected with null live external ID. A verified, active, released, different
source or different-pair claim is rejected except exact stored success replay.

Reuse the registry's serialization keys and lock ordering. Bind a new command
ID and canonical payload hash to the full evidence and expected claim state.
Authorize the executor and verify the signature before replay lookup. Exact
successful replay returns the stored receipt without another mutation; a reused
ID with different bytes or stored failure rejects. For new execution, under the
same transaction/locks, recheck expiry, approvals, all current ownership and
claim evidence before appending receipt/audit and comparing/updating claim state.
Any failure rolls back the state change and successful receipt together.

Use VAY-1320's two immutable authority records (Flamur may hold both), controlled
signer/executor separation and exact evidence-bound expiry. No fabricated
principal or local fixture signature can authorize a production operation.

Rollback/revocation requires fresh evidence-bound authorities, locks and exact
transition identity. It appends a compensating event and restores historical
state only if the claim still matches this transition's non-active after-state
and connections remain disconnected/null. It cannot overwrite newer transitions
or active state. Retain both events; do not erase history. A replay of the
original success after revocation is a receipt, not renewed eligibility.

## Required tests and implementation slices

- Design acceptance first; identity disposition/evidence next; append-only
  transition storage next; signed consumer/replay/rollback next; integration
  rehearsal last. Keep each PR approximately 400 meaningful lines or less.
- Eight synthetic candidate shapes, pending versus genuinely restricted source
  users, missing/mismatched authenticated owner, newer target denial, absent or
  ambiguous canonical links and the source-inactive connection.
- Approved pending owner succeeds only for exact existing PMS properties;
  unapproved pending owners, other hotels, Marketplace/Booking operations,
  forged dispositions, revoked dispositions and later restrictions fail.
- Exact migration-derived pending membership is eligible only within the scoped
  exception; unrelated pending, absent, inactive, suspended, revoked, ambiguous
  and subsequently restricted memberships fail without changing stored status.
- Exercise organization selection and collection/detail/write boundaries, not
  only the property helper. Verify normal active-account behavior is unchanged.
- Resource-link matrix: allow only the exact active-source/pending-owner
  migration-derived suspended link; deny source-suspended/source-archived links,
  different runs/rows/keys, missing provenance, altered before-state and later
  restrictions. Exercise both shared property access helpers and their SQL paths.
- Classification matrix: every enabled identifier must enforce the same scope
  across policy/direct-context/resource/collection paths. Deny unknown identifiers
  or versions, forged classification and all excluded product/admin/create/enable
  operations, even when the ordinary role has the corresponding permission.
- Same/cross-pair concurrency, stale hashes, tampered/expired/wrong-environment
  signatures, missing/revoked approvals, machine/human separation, transaction
  failure, exact replay, payload drift and rollback after subsequent state change.
- PostgreSQL 16/17 uniqueness, locking, append-only privilege and audit tests.
- Assert no changes to users, Marketplace approval, entitlements, connections,
  outbox/jobs, provider configuration or source snapshots. No provider calls.
- Preserve both the shared staging pair and the separate Next-native import-QA
  binding; neither is a successful transition fixture.

Only synthetic fixtures are eligible for initial execution. Reusing the isolated
restore for writes needs a precise approved write/rollback boundary; previous
temporary read approvals are not write approval. Production execution, source
freeze, callbacks, schedulers, live external-ID population, replies, cutover and
shutdown remain excluded.

## Review and execution boundary

The PMS-only product decision is received; do not ask for it again. Independent
technical review and executable denial-matrix coverage remain required before
shipping the exception. Exact isolated write authorization and production GO
remain separate. This document is not completion of VAY-2017 or readiness proof.
