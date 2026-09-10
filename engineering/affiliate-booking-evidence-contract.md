# Affiliate booking evidence contract

VAY-1505 · proposed `affiliate-booking-evidence.v1` · 2026-09-08.

This is a design contract, not an implemented API or an approved attribution policy.
It advances the [shared journey](https://linear.app/vayadacom/document/shared-affiliate-interface-and-marketplace-journey-working-design-8736e1018fcf)
under VAY-1056. Policy acceptance remains required before dependent runtime work.

## Ownership and integration

Follow [Booking/PMS boundaries](booking-pms-domain-boundaries.md). Booking owns
checkout/referral context; PMS ports supply operational reservation/stay evidence.
The affiliate capability joins evidence to Marketplace agreements; Finance owns
commission policy, eligibility, calculation, adjustments and payment execution.
Vayada and external systems use the same contract. No PMS subscription requirement,
new service, provider framework or cross-domain database access is introduced.

The [fresh VAY-1537 assessment](https://linear.app/vayadacom/document/fresh-pms-and-booking-engine-assessment-8-september-2026-20c1fce82ae4)
is the provider input; its withdrawn predecessor must not be reused. Its current
findings require separate referral, reservation and operational-stay evidence.
Documented capability is not authenticated lifecycle validation or provider selection.
In particular, a scheduled departure date or payment is not completed-stay evidence.

## Stable identities and authorization

- Marketplace owns `programId`, `agreementId`, `termsVersionId`, `creatorProfileId`
  and stable `linkId`; a click gets a distinct `clickId` where capture is permitted.
- Internal `propertyId` does not depend on a provider's property identifier.
- Authenticated connection context supplies `organizationId`, `propertyId`, provider,
  environment, adapter/mapping version and allowed external properties. These are
  resolved server-side, never accepted from an unsigned guest or webhook claim.
- A source booking key is `(connectionId, externalPropertyId, reservationId,
reservationItemId)`. `reservationItemId` identifies a source room/stay item;
  null means whole-reservation scope, not an unknown room disguised as an item.
- Provider migrations can change connection IDs. Cross-source aliases require
  corroborated booking references and audited mapping; retain original source keys.
  Do not deduplicate by guest name, email, amount or dates alone.
- Authorization is checked both at intake and before queued work/reconciliation.
  Revocation stops new reads and retries. Previously accepted evidence remains
  governed by retention and Finance obligations, not silently deleted.

## Adapter observation request

The internal application port accepts the following JSON shape. Transport-specific
webhook authentication, pagination and API calls stay in existing adapter boundaries.
There is no public unauthenticated conversion endpoint implied by this contract.

```json
{
  "contractVersion": "affiliate-booking-evidence.v1",
  "sourceEventKey": "reservation-r17-revision-4",
  "sourceRevision": "4",
  "supersedesEventKey": null,
  "sourceOccurredAt": "2026-09-08T10:00:00Z",
  "retrievedAt": "2026-09-08T10:00:03Z",
  "booking": {
    "externalPropertyId": "hotel-7",
    "reservationId": "r17",
    "reservationItemId": null
  },
  "facts": {
    "reservationStatus": "confirmed",
    "stayStatus": "unknown",
    "scheduledArrival": "2026-10-01",
    "scheduledDeparture": "2026-10-03",
    "actualDepartureAt": null,
    "bookingAmount": {
      "amount": "240.00",
      "currency": "EUR",
      "basis": "gross_booking"
    },
    "referralCandidates": [{ "reference": "opaque-ref-123", "method": "source_reservation_field" }]
  },
  "provenance": {
    "kind": "authenticated_source_read",
    "evidenceReference": "internal-evidence-92",
    "originActor": "unknown",
    "causedByVayadaCommandId": null
  }
}
```

The trusted envelope adds `observationId`, `connectionId`, internal property scope,
`receivedAt`, mapping version and a canonical source-fact digest after validation.
`evidenceReference` is an internal access-controlled reference, never a URL to fetch
arbitrarily. Validate that it belongs to the same connection/property and exists.
Source identifiers and opaque referral strings are bounded data, not executable URLs.

| Field              | Semantics                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sourceEventKey     | Required stable adapter key scoped to connection and source booking key. Use provider event ID where available; polling uses stable source revision/snapshot identity, never receipt time alone.      |
| sourceRevision     | Opaque nullable source revision. Ordering is adapter-defined and versioned; never compare arbitrary strings lexicographically.                                                                        |
| supersedesEventKey | Nullable explicit correction reference within the same source/booking scope. A reference does not independently establish authority.                                                                  |
| sourceOccurredAt   | Nullable source event/entity-change time. Do not substitute scheduled stay dates.                                                                                                                     |
| retrievedAt        | Nullable time of the authenticated read. A callback followed by a read records the read snapshot, not an invented historical callback payload.                                                        |
| facts              | Partial observation. Omitted field means not observed; explicit null means known absent/cleared, only for nullable fields. Omission never erases previous facts.                                      |
| reservationStatus  | requested, confirmed, cancelled, deleted, unknown. Source deletion does not imply cancellation or commission reversal.                                                                                |
| stayStatus         | not_started, checked_in, completed, no_show, unknown. Keep separate from reservation status.                                                                                                          |
| actualDepartureAt  | Nullable UTC timestamp. completed with no actual timestamp may remain an operator assertion with an evidence gap; do not fabricate a timestamp.                                                       |
| bookingAmount      | Nullable nonnegative decimal-string value, currency and explicit basis: gross_booking, accommodation, tax, fee or other. Missing is not zero; this is not automatically commissionable revenue.       |
| refundTotal        | Optional nullable nonnegative cumulative refund snapshot with currency/basis. Changes follow revision ordering; never sum repeated snapshots. Mixed currencies require review.                        |
| referralCandidates | Optional array; empty means source reports none. Candidate reference/method is evidence, not a winning creator or a permission grant. Resolve ownership and agreement eligibility internally.         |
| provenance.kind    | authenticated_source_read, authenticated_source_event, authorized_hotel_confirmation or authorized_import. Manual evidence records internal actor and submission IDs through its authorized boundary. |
| originActor        | hotel_operator, source_system, vayada_command or unknown. Preserve causation if Vayada initiated an operational write; do not count self-created checkout as independent external proof.              |

New optional fields must preserve omission semantics. Unknown contract versions and
unknown status values are rejected/quarantined with a reason, not mapped to success.
Unmapped provider statuses normalize to `unknown` with a restricted raw-status evidence
reference. No guest name/email or provider secrets belong in this shared payload.

## Intake outcomes and durable processing

Application outcomes are versioned separately from provider HTTP acknowledgements:

```text
accepted  { observationId, receivedAt, processing: "pending" }
duplicate { observationId, receivedAt, processing: "pending" | "processed" | "review" }
rejected  { code, retryable, correlationId }
```

Codes include invalid_contract, invalid_facts, unauthorized_connection,
property_mapping_missing, evidence_reference_invalid, event_key_conflict and
temporarily_unavailable. Provider adapters map these to their delivery protocol;
acknowledge acceptance only after durable storage. Duplicate means the same key and
canonical source-fact digest; changed source facts under the same key are a conflict, not a
successful replay. Preserve rejected/conflicting evidence through restricted audit.

The digest includes the scoped source booking key, source revision/change time,
supersession reference, mapping version and normalized `facts`. It excludes
`retrievedAt`, `receivedAt`, generated observation IDs and evidence-reference IDs.
Repeated reads of the same revision can have different retrieval/evidence metadata
without becoming conflicts. Append these authenticated retrieval/provenance records
to the original observation; never overwrite its first receipt or original causation.
A provenance discrepancy requiring review remains visible even when facts deduplicate.
Mapping changes that alter normalized facts require explicit reprocessing/correction,
not silent replacement under the original event key.

Delivery deduplication is not commission deduplication. Persist source observations,
resolved booking/item aliases, attribution decision version and Finance source key
separately. A booking-engine group and PMS room items cannot both earn overlapping
commission. Require explicit group/item mapping and allocation before eligibility;
partial completion/cancellation must not qualify the entire group automatically.

Project facts per source using its ordering contract. With no reliable ordering,
reconcile by authenticated current read where supported or hold for review. Conflicts
between authoritative sources require an explicit source-authority policy; a generic
"latest received wins" rule is prohibited. Scheduled dates cannot progress stay state.
Corrections preserve previous evidence and decisions. Finance handles monetary changes
through audited adjustments, including after payment, without replaying transfers.

## Read contract and capabilities

The shared product read model returns internal booking/item reference, agreement/link
reference only when authorized, reservation state, stay state, attribution state,
evidence state, reasons and freshness. Each resolved fact links to the observation
that supports it. No new ledger fields or UI-side commission calculation are added.

```text
attribution: pending | attributed | unattributed | needs_review
evidence: pending | sufficient | needs_review | unsupported
decision: { version, policyVersionId, termsVersionId, evidenceIds, reasonCodes }
freshness: { sourceObservedAt, lastRetrievedAt, projectedAt, connectionState }
```

An attribution decision can be complete while stay evidence remains insufficient.
`sufficient` is scoped to a named evidence purpose/policy, never a generic guarantee
of real-world truth. Finance product states (estimated, awaiting_verification,
eligible, processing, paid, adjusted) are separate and supplied by Finance contracts.

Each connection exposes capability entries for referral round-trip, reservation IDs,
room/item IDs, updates, cancellation, no-show, completion, money/refunds and backfill.
Each entry separates support (supported/unsupported/unknown), validation
(documented/validated/not_validated), validation evidence/date and operational health.
A documented completion field is not enough to advertise verified completed stays.

Creators see their own partnership and earnings only; hotels see their authorized
property. PMS/Booking Admin cannot widen access. Raw guest/provider evidence stays
restricted to the necessary review roles. Missing traffic referrer displays unknown;
identical links never promise post-level or cross-device attribution. Mark known
test clicks/events and exclude them from production metrics and earning eligibility.

## Required scenarios

| Input sequence                                        | Expected result                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Event key A twice, same source facts                  | One observation effect; same receipt reference; no duplicate earning.                    |
| Event key A reused with changed amount                | event_key_conflict; preserve discrepancy; no overwrite.                                  |
| Cancellation revision 8, then confirmation revision 7 | Keep cancellation when ordering is established; otherwise review/reconcile.              |
| Unordered contradictory snapshots                     | Neither receive time nor string sorting establishes authority.                           |
| Confirmed booking without referral                    | No guessed creator; unattributed or pending bounded reconciliation with explicit reason. |
| Valid referral, scheduled departure in past, paid     | Stay remains unknown without qualifying completion evidence.                             |
| Completion asserted by Vayada write                   | Preserve command causation; no independent-proof claim.                                  |
| Two PMS room items and one booking-engine group       | No double counting; require mapping/allocation; partial stay does not complete group.    |
| Refund total 20 delivered twice, then revised to 30   | Current refund total 30, not 70; Finance adjustment references applicable revision.      |
| Paid commission then corrected evidence               | Paid record retained; adjustment/review through Finance.                                 |
| Connection revoked before queued reconciliation       | No further provider reads; expose stale/pending evidence.                                |
| Collaboration completed; affiliate agreement active   | Agreement/link remain active under their independent terms.                              |

Repeated-poll example: revision 4 fetched at 10:00 and 10:05, with identical source
facts but different retrieval timestamps/evidence references, returns the same
observation ID and preserves both retrieval records. It produces no duplicate
commission or event-key conflict. A changed amount under revision/key 4 still
conflicts; a legitimate revision 5 is a new observation.

## Policy and implementation gates

VAY-1056 must record enrollment, agreement lifecycle/terms selection and linked-hotel
credit scope. VAY-1505/VAY-1087 must record attribution window/precedence, repeat
booking treatment, evidence authority, missing-referral review and retention/consent.
VAY-1510 owns commissionable amounts, conditions, payer, fees/refunds/no-shows,
currencies and settlement timing/thresholds. No numeric defaults are implied here.

Recommended implementation order after those decisions: package-level contract and
validation fixtures; durable scoped intake; Vayada Booking/PMS adapter; named external
or manual adapter accepted by VAY-1087/VAY-1537; shared read models and Finance handoff.
VAY-1501 offer publication must require explicit accepted terms/policy references and
show tracking readiness; membership in Vayada PMS never implies program eligibility.
Marketplace application/invitation acceptance must not activate earning until required
terms acceptance, property authorization and the chosen evidence path are ready.

This draft does not complete VAY-1505 or unblock unresolved commercial behavior.
No product routes, schema migrations, provider connections or payment effects change.

## Accepted completed-stay authority — 2026-09-10

Flamur accepted an explicit authenticated hotel/PMS check-out as completed-stay
evidence, retaining that it is a hotel assertion and its audit/command causation.
The same rule applies to Vayada and external PMSs. Scheduled departure, payment
or reservation confirmation alone do not qualify; no extra manual approval is
required solely because the authenticated hotel recorded the check-out.

The first PMS-owned internal read requires a fresh Marketplace hotel-management
context and entitlement, a persisted active owner/operator property link, one exact
booking/stay item, current checked-out state and an explicit matching check-out
plus user audit record. Missing, conflicting or ambiguous evidence remains pending.
Check-out records must retain the exact stay-item reference. A null reference
remains pending even for a current single-item booking: assignment deletion can
clear that reference, so current item counts cannot prove original scope. Recorded action time is not invented actual
departure time. Pending operational flags are retained as a boolean signal; their
financial effect is not decided here. Guest PII and private notes are excluded.

This read is not a connection capability test, public route or automatic update
to destination tracking readiness. It does not establish referral matching or
commissionable revenue, publish terms or authorize payment. External adapters must
supply equally scoped authenticated provenance through their owning boundary; no
provider is selected by this policy decision. Remaining intake, retention, money
and evidence-conflict policy gates above remain open.
