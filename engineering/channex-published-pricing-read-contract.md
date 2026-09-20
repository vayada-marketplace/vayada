# Trusted published pricing for Channex jobs

VAY-1952, a design prerequisite of VAY-1545. Depends on the replacement pricing
contract, VAY-1944/#1944 and VAY-1946/#1950. Publication components were inspected
at #1915 (`b0c55a359`), including #1906 and #1908. This is an implementation
contract, not an available reader, authorization grant or runtime activation.

## Boundary and authority

Introduce a PMS-owned internal `readPublishedPricingForChannexJob` in the API
domain layer. Only the server-composed durable Channex worker calls it. Its input
is `{ jobId, workerId, attemptNumber }`; it accepts no caller-supplied property,
organization, price, publication revision, terms, source tokens or RequestContext.
Worker identity comes from worker startup, not a request body. This is not a
public endpoint, credential exchange or general-purpose service account.

The database job and active attempt must match the exact lease holder, attempt,
running status and Channex management queue/type. Validate lease expiry with
database wall time using the worker's shared lease duration; do not duplicate a
hardcoded five-minute constant. Derive property and operation from persisted
records and validate their canonical tenant/resource scope. Limit price reads to
`provision`, `sync_ari` and `update_markups`; this does not authorize those writes.
Audit actor IDs and historical payload values are provenance, not user authority.

Service authorization is the intersection of the live job lease and the current
property's authorized Channex relationship:

- Canonical property exists and is not disabled.
- Exactly one active hotel-group organization has both canonical-property and PMS
  property links as owner/operator. Never select the first matching organization
  or recover organization scope from an old user's membership. Multiple matching
  organizations return `scope_unavailable` until explicit ownership is resolved.
- That organization has currently effective PMS access using the existing
  entitlement vocabulary and suspension precedence. Evaluate activation/expiry
  against database wall time. Missing or suspended access denies the read.
- The property's Channex connection is connected, degraded, or setup-incomplete
  with an existing external property ID and matching active binding claim.
  Suspended/disconnected connections and historical/released claims deny access.

No user membership or permission is fabricated. Existing user read/manage checks
must remain unchanged. The worker does not acquire authority to edit or publish
prices, provision identities, or send requests merely by reading a snapshot.

## Published data and owner evidence

Use the active `pms.pricing_v2_heads` revision and its complete immutable revision
and room snapshots. Never load a draft or pick the largest revision number.
Reuse the existing store parser and complete room/property/currency validation;
refactor a small internal read helper rather than copy SQL and validation.

Collect current PMS room, Booking terms and Finance source evidence through the
existing owner ports. Require exact equality with the publication's source set
and reject missing or unknown source keys. Verify current room scope/capacity,
every selected offer and linked ancestor's current terms, applicable Finance
readiness and the exact mandatory-charge declaration. Preserve declaration/source
fingerprint rules and explicit unsupported Finance outcomes. A source token match
alone is not verification of current time-sensitive owner readiness.

Factor shared owner validation only behind separately enforced user and service
entrypoints. Do not add an optional authorization boolean, permissive default
guard, or a synthetic RequestContext to reuse user-only composition functions.
The service entrypoint must itself verify the live lease and property authority.

Success returns `kind: "available"`, database read time, exact lease identity,
property/organization/connection/binding identity, publication revision and currency,
complete validated room configurations, exact source tokens and verified owner
references/terms. These are internal immutable copies, not public response DTOs.
VAY-1946 obtains expected revisions/terms from this result, never job payloads.

Failures return no configurations or candidate rows: `lease_unavailable`,
`scope_unavailable`, `connection_unavailable`, `publication_missing`,
`publication_invalid`, `sources_stale`, or `owner_unavailable`. Owner failure codes
may be retained in sanitized diagnostics. A contention/serialization failure is
retryable, not permission denial or a fallback price. No result becomes zero.

## Transaction and concurrency

One bounded database transaction establishes a coherent read. Take the existing
PMS inventory/publication advisory lock and reuse owner locks in their established
order. Validate identity links and entitlement rows as well as their absence;
prove concurrent new links/suspensions cannot yield a mixed authorization result.
The implementation must use suitable isolation or writer-coordinated locking and
test it; a query against existing rows is not proof against inserted rows.

The current claim path locks the job row before taking a canonical-property row
lock with SKIP LOCKED. The reader must not introduce a blocking reverse order.
An initial lease lookup is only a hint. Revalidate the lease/attempt and wall-clock
expiry at the final boundary; use nonblocking job-row acquisition or a compatible
shared order, rolling back/retrying contention. Test with the real claim code,
including worker ID reuse and lease reclaim. Do not extend an expired lease here.

Recheck the active publication and time-sensitive authority/owner evidence before
returning, using the owner ports' locking and expiry rules. Bound transaction time
and propagate timeouts. Release all database locks before provider HTTP calls.

Read success is evidence as of the transaction, not a promise that state cannot
change afterward. The delivery step must independently recheck publication,
sources, connection and mapping generation immediately before dispatch and before
recording success. Lease expiry during an in-flight request requires reconciliation;
it cannot prove cancellation at Channex. No stale worker may finalize readiness.

## Implementation slices and acceptance

1. Service lease/property authority with real PostgreSQL tests for forged scope,
   wrong queue/type, expired/reclaimed attempts, worker reuse, disabled property,
   missing/ambiguous links, inactive organization, suspension/expiry and claims.
2. Published snapshot/current-owner read reusing the publication stack. Test absent
   heads, malformed/partial rooms, stale sources/terms/charges, Finance unavailability,
   exact successful output and a new publication or owner mutation during reads.
   Include concurrent claim, link insertion and suspension; verify rollback and
   bounded retry instead of deadlock or partial success.
3. Compose with the nightly projection and candidate adapter. Validate complete
   occupancy/date/offer evidence and revision invalidation. Provider materialization
   and delivery remain separately reviewed steps, not side effects of this reader.

Implementation branches combine the exact reviewed publication and calculator
dependencies in isolated checkouts. Preserve the pricing task's active UI worktree.
Do not merge the old pricing planner back to resolve integration conflicts.

Keep `PRICING_UNAVAILABLE` in live provisioning/ARI paths until the reader and
remaining provider gates are implemented: VAY-1530 meal identities, VAY-1528
restriction equivalence/reset, guest/child representation, one adjustment owner,
mapping generation, serialized writes, partial/ambiguous response handling and
verified initial ARI. No OTA allowlist belongs in this read boundary. Provider
acceptance and actual OTA behavior require distinct evidence; no Expedia hotel is
needed for reader tests, but these tests cannot establish Expedia onboarding.
