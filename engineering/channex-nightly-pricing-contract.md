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
