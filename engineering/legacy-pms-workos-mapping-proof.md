# Exact WorkOS organization mapping proof contract — VAY-2017

Status: independently reviewed basis for local synthetic implementation only;
no binding/provider execution or access grant. Design review: proposal SHA-256
`c628a43a789a1ab877dddd9aa06a8e4d5b68c65f7bad01e897cfc403d1decdd2`.
Based on app `b83cec1894c81b5f65fb8a871fdaa6e0e67335af` and
`engineering/legacy-pms-ownership-restoration.md`.

## Decision and smallest boundary

Target `legacy-pms-workos-mapping.v1`: one identity-owned migration command
records an **already existing, independently verified** WorkOS organization on
the exact migrated organization. An active provider membership is a prerequisite.
Reuse the existing lifecycle command/audit conventions and operator execution
boundary. Do not use `identity.access.grant` or the broad WorkOS backfill.

The future command performs conditional local metadata writes only. It cannot
create/activate/update WorkOS objects, repair a conflicting identity, create an
internal row, change a role or establish a missing resource link/entitlement.
Absent provider objects remain an explicit prerequisite for the separately
described provider preparation in `engineering/legacy-owner-account-setup.md`.

## Exact permitted delta

Only `identity.organizations`: `workos_org_id` null → approved `org_*`;
`workos_external_id` null → this same internal organization UUID; `updated_at`
→ transaction timestamp, only when a mapping field changes. Equal values remain
unchanged; any different non-null value blocks. Compare complete rows; permit
no other field difference, including future schema columns.
Require user `pending`, organization `suspended`, membership `pending`, existing
`hotel_owner`/`agency` membership and the exact proven PMS ownership chain.
Preserve every membership field, status, permission, property scope, link,
entitlement, email-verification and Marketplace field.

Consumer audit: `resolve.ts:118` only copies optional WorkOS membership metadata;
`authSession.ts:3332` and backend-authorization gate on internal membership/status,
role and resources. `legacyCurrentOwnerIdentity.ts` needs the organization ID,
not local provider-member fields. Backfill diagnostics are not access consumers.
Therefore v1 does not write `workos_membership_id` or `workos_role_slugs`.

## Preconditions and signed subject

- Reuse source ledger/ownership readers and full-row hashing. Require original
  migration provenance for every restriction being excused: exact run, plan,
  table, row, after-hash and full XID/current xmin with the existing XID horizon.
  A matching status alone, fabricated receipt or re-signed changed row is invalid.
- Bind one exact user/organization/membership and its complete approved existing
  property set. Require exactly one `hotel_owner` in the organization, as enforced
  by `legacyOwnershipRelationships.ts`; no second-owner/shared-membership reuse.
  Prove no competing owners or provider mappings. Require active
  canonical properties and independently eligible canonical/PMS links and PMS
  entitlement. Exclude protected QA/staging properties. No new link provenance.
- Existing external identity must already map the historical internal owner to
  the exact provider user. Verify the WorkOS session and independently reread the
  provider user external ID, organization external ID and active membership's
  user/organization/approved role. Email matching cannot resolve the principal.
  This narrow pre-link check leaves the ordinary current-identity verifier strict.
- Signed canonical subject includes command/version/environment, verified target
  DB identity, source/run/schema/release evidence, original receipt identities,
  before-row hashes/XIDs and values of all three mutable fields, allowed after-values,
  provider IDs, observation digest/window, property scope, expiry and two authority
  record IDs. Observation span and age are at most 15 minutes; expiry may be sooner.
- Reuse canonical JSON, SHA-256, Ed25519, trusted key/principal configuration and
  VAY-1320's two immutable authority records with its authorized sole-human rule.
  Signer and executor remain separate. Use a new signature domain/version; the
  existing `legacy-pms-owner-evidence.v1` approval cannot authorize this mutation.

## Atomic persistence and provenance

Reuse `productionIdentityMigration.ts:79`'s short `REPEATABLE READ` transaction,
`lock_timeout='5s'` and `SHARE ROW EXCLUSIVE` table-lock pattern. Before **any**
data SELECT, including approval/replay checks, lock in the existing identity
order: users, external_identities, organizations, organization_memberships,
organization_resource_links, product_entitlements; then hotel_catalog.properties,
hotel_catalog.property_source_links, approval records and revocations. This blocks
ordinary INSERT/UPDATE/DELETE, including a competing link from another organization
that current uniqueness allows. Row/advisory locks alone cannot protect absence.
Use bounded statement/transaction timeouts; lock failure aborts without writes.
After locks, acquire command/row locks, read fresh complete ownership/conflict
state and approval/revocation state, then conditionally update the exact preimage.
Establish no database snapshot before locks; make no provider calls under locks.

Add only a typed append-only mapping receipt, following existing migration
receipt patterns and `platform.prevent_append_only_mutation`; do not introduce
a general transition service. Record command/payload hash, original migration
receipt references, exact organization before/after hashes and full XIDs, plus
authenticated before-values for all three mutable fields, retaining exact native
timestamp precision. Store actual after-values, provider-evidence digest,
authorities, executor and audit reference; no unrelated raw row/PII copy.
Write the organization, receipt, `platform.product_audit_events` and completed
`platform.idempotency_keys` result atomically; failure rolls back all four.
Reuse identity reconciliation events for correlation, not as proof.

The existing approval registry pins its old version in a CHECK constraint.
A forward migration must explicitly admit this one new version while retaining
all old behavior; add a version-specific validator over the existing primitives.
Do not edit applied SQL, reinterpret old signatures, or update migration receipts.
Grant the controlled executor only the required scoped access; runtime receives
no provenance-table or receipt-table privilege through this change.

A later evaluator may follow exactly original receipt → this mapping receipt →
current row. Verify current full hash/xmin against the mapping receipt; reconstruct
the original row by replacing only the three mutable fields with its authenticated
before-values, using the existing full-row canonicalization. Its hash must equal
both receipt before-hash and original migration after-hash; recorded before-XID
must equal the original receipt XID. Enforce the existing full-XID horizon for
both links. Recompute the exact permitted delta and current approval/revocation.
Missing/tampered before-values fail. No arbitrary chains or second-owner reuse.
Equal-state no-ops create no receipt or xmin change. Later changes, including ABA,
invalidate this proof; they need a separately reviewed transition.

## Provider outcomes, retries and revocation

V1 uses bounded GET evidence only. Failed/partial/paginated/conflicting results,
missing objects, timeout or unknown provider status produce no local write. Retry
reads only within fresh observation/approval bounds. A successful read followed
by a local failure permits retry only after fresh provider reads and locked
before-state checks. Provider evidence is point-in-time, never cross-system atomic.

If prior separately authorized provider preparation has an uncertain outcome,
consume only its durable intent/result and independently verified exact IDs.
Never issue another create, infer absence from a transient 404, or attach an
email candidate. Missing original intent or unresolved result blocks this command;
recovery stays with that provider operation and its original idempotency key.

Authenticate the executor and verify signature/registry before replay lookup.
Exact stored success returns a historical receipt only, with current validity;
changed payload rejects. Expired/revoked authority never permits a new mutation,
renewed eligibility or another provider action. Recheck expiry/revocation and
before-state immediately before commit. Table locks exclude a concurrent revocation
append until commit; if it committed before lock acquisition, fresh checks reject.
Later revocation immediately invalidates consumption, without erasing the receipt.

Revocation invalidates dependent eligibility without clearing history or mappings.
Physical rollback needs fresh approval, unchanged after-state and proof no other
membership/disposition depends on the mapping. Never restore active status or
overwrite newer restrictions. Existing prepared-owner/session holds stay in force.

## Synthetic PostgreSQL 16/17 acceptance stack

The first implementation is an internal organization-only mapping-proof verifier,
using real original migration receipts and full-row reconstruction. No public API,
executor, receipt schema, registry change, provider call or runtime consumer yet.
The remaining acceptance cases below belong to later separately reviewed slices.

1. Real migration receipts + mocked exact provider GETs accept only the declared
   organization delta; prove memberships/receipts/statuses/links/entitlements unchanged.
2. Deny changed role/status/scope/owner/provider IDs, missing/conflicting mappings,
   inactive provider membership, retired property, missing entitlement/provenance,
   altered schema fields, stale hash, ABA xmin and invalid XID horizon.
3. Prove reconstruction matches the original hash/XID; reject missing/tampered
   before-values, later writes/ABA and second-owner reuse, with no scope expansion.
4. Race ordinary writers inserting another organization's link or a second owner
   both before and after lock acquisition: observe conflict on fresh read or block
   the writer until commit. Cover timeout, replay/drift, competing commands,
   audit/receipt rollback and revocation before/during/after the locked transaction.
5. Test expired/stale evidence, GET failure/timeout, uncertain earlier provider
   intent and provider-success/local-failure recovery; assert zero provider writes.
6. Prove runtime cannot read receipts; existing login holds and all PMS/Marketplace
   gates remain unchanged. This slice does not claim an end-to-end login proof.

No new product-policy decision is required for this boundary: PMS-only intent is
settled. Missing identities or changed ownership remain separate reconciliation,
not reasons to broaden it. Independent technical acceptance covers this design
and tests; actual binding/provider execution still needs exact operation approval.
Afterward, a separate reviewed runtime disposition handoff and inventoried PMS
consumer chain remain necessary. No speculative operation allowlist is added here.
