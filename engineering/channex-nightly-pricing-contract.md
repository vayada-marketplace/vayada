# Channex nightly pricing

VAY-1527 extends the VAY-1065 pricing calculation and VAY-1285 management
contract. Flamur approved the missing date-price contract and automatic sync
on 2026-09-07. Scope is the TypeScript PMS and Channex distribution path.

- Resolve each property-local stay date from current canonical flexible pricing
  and recurring source revisions. Seasons replace the base amount; weekend
  surcharges add to that amount. Annual seasons can cross December/January.
- A saved, plan-specific date price replaces the complete recurring room price,
  including when lower. It does not add another weekend surcharge. Removing it
  restores the currently applicable recurring price. This is a room rate, not
  an occupancy model, promotion, or change to existing booked prices.
- Date prices have a dedicated PMS source, currency, and revision. The target
  authenticated API saves/removes one date with optimistic concurrency; removal
  retains its revision. Dated transitional `pms.rate_rules` are not this source.
  This contract supplies Channex distribution; it does not change the separate
  immutable direct-booking quote/publication contracts.
- Missing, invalid, stale, mismatched, or ambiguous applicable canonical pricing
  fails the sync before any provider request. Never fall back to a base price to
  hide malformed pricing. Disabled recurring rules do not affect prices.
- Apply channel markup once after resolution, with scale two decimal half-up
  rounding. Manual sync, markup reconciliation, and scheduled sync share this path.
- Automatically enqueue into `pms.channex.management` when current source state
  changes or the property-local date advances. Reuse its leases, retries,
  dead letters, product audit, and status updates. Do not activate the older
  unwired scheduler/provider abstraction alongside this worker.
- Automatic enqueue requires the existing ARI capability to be mutating and
  background/management workers enabled. It must not change cutover ownership.
  Repeated scans of unchanged state reuse the same durable job; changed and
  removed sources produce new eligible work. Read current state at execution.

Validation must reach the actual provider request with saved-source integration
tests, including discounted overrides, year/weekend boundaries, local dates,
rounding, removal, and invalid pricing. Next/staging evidence must distinguish
request acceptance, provider readback, and downstream OTA delivery; no bookings.

### Observed manual-option metadata and incomplete task payload (2026-09-14)

The closed VAY-1545 sandbox probe stored independent EUR100/130/155 guest totals.
Non-primary manual options expose `derived_option: {rate: []}` and
`inherit_rate: false`; accept that exact empty shape, never a non-empty formula.
The detailed rate response may omit the absent parent. Require explicit null
from the property-scoped rate-options endpoint, matching rate, property, room,
currency and sell mode, rather than assuming an omitted parent means none.

The successful finished upload task omitted submitted `min_stay_through`.
A subsequent scoped property read reported `settings.min_stay_type: arrival`.
This is evidence of a compatibility gap, not proof that arbitrary omitted task
fields were applied. Keep exact original task-payload matching and block full
reconciliation until property restriction capability and all requested fields
are verified. Current/default restriction equality is not upload execution proof.
No provider setting change or runtime activation is part of this correction.

References: [rate options](https://docs.channex.io/api-v.1-documentation/rate-plans-collection#rate-plan-options),
[ARI fields](https://docs.channex.io/api-v.1-documentation/ari#fields), VAY-1545.
Local sanitized probe: `evidence/vay1545-multioccupancy/RESULT.md` in the shared
testing directory. This metadata correction alone does not complete the deployed
calculator-to-Channex flow or downstream OTA acceptance.

Initial ARI dispatch now checks the scoped provider property's
`settings.min_stay_type` before room/rate preflight and POST. Because the immutable
request includes both explicit minimum-stay fields, only `both` passes; arrival,
through, unknown or missing mode returns `ari_restriction_capability_unavailable`.
It sends nothing and creates no provider receipt. Existing claimed-attempt holds
and one-shot dispatch semantics remain; this check does not release/retry claims
or change property settings. The post-preflight authority recheck still applies.
A mode read is only a necessary capability observation: it does not prove the
setting cannot change afterward or that the subsequent upload executed. Exact
original receipt/task and independent current-value verification remain required.

### All-occupancy current price observations

Read each verified manual option ID for the immutable staged request's date,
requiring its exact decimal total and stop-sell true. Require every configured
occupancy exactly once, unique option IDs and primary ID matching the base rate.
Reject warning/error envelopes for metadata as well as price reads. Recheck
configuration and option IDs after reading all prices; no partial result.
This is a sequence of current observations, not an atomic provider snapshot,
original-upload execution, full restriction verification or activation proof.
The owning service must load immutable scope and recheck publication, ownership
and complete attempt/receipt history under bounded IO before returning evidence.
