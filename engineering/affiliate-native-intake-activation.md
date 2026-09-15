# Native booking evidence: controlled activation

VAY-1505 / VAY-1552 · proposed activation contract · 15 September 2026.

## Current implementation and remaining decision

The shared stack validates observations, stores original receipts and deliveries,
enforces current hotel ownership, reads native creation events, and exposes
hotel-authorized inspection. It is open and unmerged through PR2252. Internal
`ingestBookingAffiliateCreation` is implemented; no HTTP write caller or collection
worker is enabled. See [evidence contract](affiliate-booking-evidence-contract.md).

Fresh checks of VAY-1056, VAY-1505 and VAY-1501 found approved hotel approval,
linked-property credit, last eligible click, offer-defined attribution window,
completed-stay eligibility and explicit percentage commission direction. They did
not find an approved retention/export/deletion rule for the new evidence store.
These are different decisions: approval to build the foundation does not select
how long to keep live evidence or how to remove it.

Native backend ingestion reads existing booking records; it adds no cookie,
browser identifier, redirect or creator matching. Browser storage/consent/transport
decisions apply separately when the original tracking-context capture is connected.
They must not be described as a technical prerequisite for this backend-only
operation. The retention decision for its new durable records still applies.

## Proposed first live caller

Use a hotel-manager-initiated command for one existing native booking. Do not start
an automatic worker, backfill, scheduled scan or an external-provider collector in
this slice. This bounds the operation while the complete flow is verified.

Proposed endpoint:

`POST /api/marketplace/properties/:propertyId/affiliate-evidence/native-bookings/:bookingId/creation`

- Resolve a fresh authenticated context; require the inspection endpoint's active
  hotel-group actor/membership, profile-management permission, current owner/operator
  link and active property entitlement. Repeat authorization before any replay.
- Accept only canonical route IDs and a bounded idempotency key. The body contains
  no source facts, provenance, creator, policy approval or tenant authority fields.
- Resolve the approved, versioned evidence-retention policy server-side. A missing,
  revoked or inapplicable policy keeps the command unavailable. A client flag,
  environment toggle or presence of a booking is not policy approval.
- Reuse native source validation and locks. Policy applicability, operation
  authorization, command idempotency, receipt/delivery persistence and actor audit
  must share the same transaction. Refactor the internal transaction boundary as
  needed; do not write an audit separately after the receipt commits.
- Scope command replay to the operation, organization/property and request identity;
  bind booking and actor identity in its fingerprint. A matching authorized retry
  returns the original response without another command effect. Reused keys with
  changed input conflict. Receipt deduplication remains a separate source identity.
- Audit the actor, organization/property, booking, request/correlation identity,
  applied policy version, receipt and outcome. Keep guest details out of this record.

Return 201 for a new accepted receipt, 200 for an authorized replay/duplicate, 404
for inaccessible/missing scope, 422 for malformed input, 409 for source conflict or
unavailable activation policy, and a retryable service error for infrastructure
failure. No response may claim creator attribution, verified stay or earning.
All responses remain no-store. For an accessible booking, missing/unsupported
creation evidence returns 409 `source_evidence_unavailable`; contradictory evidence
returns 409 `source_evidence_conflict`. Neither writes a receipt/delivery. Preserve
typed source reasons through the internal entry point: its current shared
`unauthorized_connection` result cannot implement these distinct HTTP outcomes.

## Retention decision to record before enabling writes

Record the policy owner, approval/version, applicable environment and effective
date, plus explicit rules for:

1. How long original observations and repeated/conflicting deliveries are retained,
   and which timestamp/event starts that period.
2. Export and deletion/anonymization behavior, including property transfer and
   account closure, with defined exceptions for records that must remain preserved.
3. How the policy relates to original booking records and later attribution/Finance
   records. Do not infer that all these records have the same retention period.
4. Who may authorize an exception or hold, its scope, review and release behavior.
5. Retention of command replay records, actor audit and lifecycle markers. After a
   receipt is removed, a retry must not return a stale success or recreate it; return
   410 `receipt_unavailable`. A new command key is not permission to re-collect erased
   evidence. Define when re-collection is allowed and a policy-governed marker or
   equivalent enforcement mechanism; do not retain identifiers indefinitely by
   accident. Policy-approved holds and expiry apply to these records too.

No numeric duration, legal basis or indefinite retention is selected here. An
existing approved policy can supply these rules if it explicitly covers this store.
Otherwise the product/policy owner must decide them; a developer cannot manufacture
an approval reference. Browser-tracking and monetary-policy decisions stay separate.

The current tables reject updates, deletes and truncation. That protects evidence
history but is not a complete retention implementation. Before activation, provide
and test the narrowly authorized export/deletion/anonymization path required by the
approved policy, including delivery rows and audit/hold behavior. Do not disable
the append-only guard globally or silently promise deletion the schema cannot do.

## Completion criteria for the next implementation

- The approved retention rule and controlled lifecycle path exist and are tested.
- The command enforces the full denial matrix, current policy applicability and
  fresh authorization on retries, including revoked access and policy changes.
- Receipt, command replay and audit are atomic on success and failure. Concurrent
  calls cannot create duplicate command effects; conflicts preserve source history.
- Tests exercise the real native reader, isolated PostgreSQL, response mappings,
  and the actual application route with authenticated context handling.
- After authorized merge/deployment, verify the exact deployed revision and bounded
  synthetic fixtures. No real guest booking or payment is created for validation.
- Any live enablement records the approved policy/version, scope, deployed revision
  and verification evidence. No automatic provider-wide or property-wide rollout.

This plan does not enable writes, merge the stack, set a policy, or finish VAY-1505.
Creator correlation still needs original tracking-context/click-cutoff persistence
and the separate last-eligible-click stack; native creation alone cannot supply it.
