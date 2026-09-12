# Published offer targets for Channex

VAY-1972, the delivery mapping decision for VAY-1545. Follows the trusted reader
contract and VAY-1970's verified nightly candidates. This describes required
implementation; it does not enable provider writes.

## Identity

The current `pms.channel_rate_plan_mappings.rate_plan_id` references
`pms.rate_plans`. Replacement offers instead have string IDs scoped to a room
inside an immutable published pricing configuration. Creating synthetic old
rate-plan rows to satisfy that foreign key would restore a retired dependency.

A replacement logical target is `(connection_id, room_type_id, offer_id)`, scoped
to the canonical property through database constraints. Its stable identifier
does not contain the publication revision, offer name, meal label or OTA name.
The same string offer ID in different rooms is a different target. Canonical
room and connection property must agree. Titles are display data, never adoption
keys. Publication membership is established through the trusted reader.

New targets use one shared base provider rate per published offer. Connected
channels map to that target through Channex; adding a channel does not create a
new Vayada target category. Channel discovery, native modifier display and
capability evidence remain separate concerns. Existing legacy mappings and
reservation identities remain retained; no automatic adoption by name or offer
position is permitted. An adoption must prove the exact external property, room
and rate identity plus ownership and supported semantics before activation.

## Target versions and retained history

Persist a stable logical target plus immutable numbered target versions, with
an active-version pointer and at most one pending replacement intent. Reserve a
version number with that intent before provider work; numbers increase
monotonically and are never reset or reused, including failed attempts. Seal the
immutable version only after exact external identity is established. It records:

- Canonical property, connection, room and offer identity.
- Connection binding generation and exact external property/room/rate IDs.
- Provider sell mode, complete occupancy options and one explicit primary option.
- Currency, meal identity and supported restriction/guest representation evidence.
- Adjustment ownership and the provider configuration evidence that supports it.

An external rate cannot silently become another logical offer's identity. Retain
superseded versions for audit and inbound identity resolution. External rate ID
resolves the logical offer, not necessarily a unique configuration version when
several versions reuse that ID. Never infer booking-time configuration from the
current pointer or receipt timestamp. Preserve provider booking facts and the
reservation's frozen evidence. Attach a historical target version only when an
explicit, verified correlation proves it; otherwise record that version as
unknown rather than reconstructing price/terms from current configuration.
Reusing an external rate retains the same logical offer identity. An offer
disappearing from the current publication
invalidates outgoing work immediately but does not delete historical mappings.

The old mapping and replacement mapping stores must not both claim an external
rate without an explicit, audited ownership transfer. The migration/writer must
enforce this across stores; independent uniqueness indexes are insufficient.

## Staging and activation

Resolve the active published offer and current owner evidence first. Create a
pending replacement intent with a durable operation identity and reserved version
number before provider work. Retries reuse that operation and reserved number.
The intent retains the proposed configuration and may initially have no external
rate ID; it is not an immutable verified mapping or an active target. Record
provider create/reconciliation evidence on the operation, then seal the version
with exact IDs. Resume a crash between evidence capture and sealing idempotently;
never edit a sealed version to fill a previously unknown identity. If create times out before an external ID
is recorded, reconcile provider state before retrying creation; titles alone
cannot prove ownership. Do not interpret a timeout as proof of no mutation.

Prefer a new pending provider target when a configuration change cannot be
proved safe in place. The prior complete active version remains the active
pointer while pending work is incomplete. This protects local readiness; it
cannot undo an in-place provider mutation. An ambiguous or partial in-place
update therefore suspends delivery/readiness until readback resolves actual
provider state. Never claim the old provider configuration survived by assumption.

Activation requires exact configuration readback, complete required initial ARI
acceptance/readback, and a compare-and-swap against the expected active version,
pending version, binding generation and current publication/owner evidence.
Stale completion cannot advance the active pointer. Failure retains historical
identity and a visible failed/reconciling operation; it cannot mark readiness.

VAY-1530 supplies meal identity mapping/readback. VAY-1545 then proves combined
guest-aware inclusive amounts. VAY-1528 supplies equivalent restriction/reset
semantics. Unknown occupancy, child, meal or restriction support blocks activation;
do not infer support from a matching label or a successful HTTP response.

## Amount ownership and dispatch

For the new shared-base target, Vayada sends the inclusive calculator total
without a channel markup. Native channel adjustments have one separate owner;
they are not baked into this shared rate. A three-person room total is one room
total, not three times that total. Meal amounts use the represented guests.
Retained old target adjustment behavior is not automatically migrated or applied
to the new target. No operation may combine both adjustment owners.

Durable dispatch records bind each property-local date/occupancy item to the job
lease, publication and source evidence, connection binding generation, target
version and exact external IDs. Serialize writes for the external rate so a new
generation cannot overtake an unresolved prior request. Release database locks
before HTTP, but retain durable ownership of the dispatch/reconciliation state.

Recheck fresh authority and target/publication evidence before sending and before
recording success. Database generation checks prevent stale local completion;
they cannot cancel an in-flight provider request. Lease loss, transport ambiguity,
partial rejection or warnings require reconciliation per affected item before a
later generation proceeds. HTTP status alone never marks the whole batch accepted.

## Implementation and proof

1. Add target/version persistence and ownership constraints, with transaction tests
   for cross-property references, competing pending versions, external-ID ownership,
   immutable history, interrupted create/sealing and stale activation. Test delayed
   initial reservation delivery and modifications across an in-place change: no
   unsupported historical-version inference. No provider writes in that schema step.
2. Add the job-authorized target planner/writer using the existing reader and
   candidate adapter. Test removal, replacement, exact occupancy/currency/meal
   identity, one primary option and unsupported states without partial activation.
3. Implement serialized dispatch, per-item response classification and readback
   reconciliation. Test stale leases, reverse completion order, partial warnings,
   unknown create results and failure after an in-place mutation.
4. Run bounded provider configuration and inclusive-amount readback only within an
   authorized fixture window. Verify OTA behavior separately where supported;
   simulator or Channex acceptance is not Expedia onboarding evidence.

Keep `PRICING_UNAVAILABLE` until these gates and the meal/restriction dependencies
are satisfied. Preserve shared fixtures owned by other active tasks. No production
change, reservation, payment, deployment or merge follows from this decision.

## Explicit primary occupancy (VAY-1983)

The hotel chooses the standard adult guest count during channel setup. This is a
provider setup choice, not a pricing formula or an inferred room-capacity default.
Do not derive it from included-guests base counts; those can vary by calendar row.

The reservation entrypoint requires `primaryOccupancy`, an integer from one to the
current published room's adult capacity. The pending proposal retains the choice;
changing it with the same operation key is a conflict. Existing intents without a
choice cannot become valid by retrying with a guessed default. They require an
explicit replacement operation through the later cancellation/reconciliation flow.

Provider options must eventually mark exactly this guest count primary while
retaining every supported occupancy price. Missing, unsupported or stale choices
block activation. This slice adds backend validation/storage; the hotel-facing
control, provider configuration and activation remain separate implementation work.

## Closed configuration planning (VAY-1985)

Pending proposals now retain a manual per-person configuration fragment with all
adult occupancy options, the explicit selected primary, currency and meal type.
Linked local prices are materialized manually; provider rate inheritance is off.
No rate amounts or zero-price placeholders are introduced by this planner.

Every default weekday starts stop-sell closed. This fragment is not a complete
create request: exact provider identity, scoped request construction and closure
readback are still required. Channex defaults alone do not establish a closed rate.
Daily ARI, equivalent restrictions and initial price/readback must be complete
before sales open. Provider capability/OTA support is not implied by this plan.

Rooms permitting children currently return an explicit unsupported state; their
child capacity is never silently removed. The local 100-option bound matches the
nightly adapter and is not a claimed provider limit.

## Configuration metadata readback (VAY-1988)

The GET-only verifier derives expectations from the strict planner and checks
meal identity against the same response through the existing meal helper. It
requires exact property/room/rate identity, currency and manual per-person mode,
all independent occupancy options with the chosen primary, disabled rate and
stop-sell inheritance, no automatic pricing and seven closed default weekdays.
Provider option ordering and unrelated metadata do not affect comparison.

Missing explicit evidence fails closed: option derivation must be null, automatic
pricing must be null, and no parent must be explicit in attributes or the parent
relationship without a contradictory identity. A provider response omitting those
fields is unavailable until its semantics are verified; absence is not inferred
to mean independent pricing. Caller expectations are captured before provider IO.

This returns metadata evidence only. It does not verify option rate amounts, daily
ARI closure, restriction equivalence, OTA capability or activation readiness.
Binding evidence to the current pending intent and fresh authority, durable create
recovery, transactional sealing and initial ARI remain separate requirements.
Provider response shapes follow the [official rate-plan documentation](https://docs.channex.io/api-v.1-documentation/rate-plans-collection),
checked 2026-09-12; automated fixtures are not live provider proof.
