# Shared Channex pricing: replacement integration and launch checks

VAY-1549 / VAY-1550. Updated 2026-09-09 for the approved delete-first
TypeScript pricing rebuild. This replaces the earlier per-property migration
runbook; that procedure remains in Git history. Production Python is unchanged.
Provider identities, binding claims and room/rate mappings must be preserved.

## Integration status

The tested channel stack is not integrated with the replacement pricing stack.
PR #1771 consumes the old `loadPmsPricingSourceSnapshot`,
`loadPmsRecurringPricingBookingEvidence` and Booking nightly resolver in
`apps/api/src/integrations/channexManagementPlans.ts`. Provisioning also reads
`base_rate_amount::float8` and uses the old scale-2 money conversion. These are
not adapters for the new currency-aware minor-unit contracts.

Deletion PR #1764 (dc77cff1d) replaces `provisioningPlan` and `ariPlan` with
`PRICING_UNAVAILABLE` errors. A non-mutating Git merge check against channel
head 47801e9eb reports conflicts in `channexManagementPlans.ts` and its test.
Resolve those boundaries by retaining unavailability until the new evaluator
and export adapter exist; never restore the removed calculator to resolve a
conflict. Retain independent discovery/refresh and durable provider identity
handling when integrating the stacks.

Contract PRs #1792 → #1793 → #1794 (final head e46d02862) define configuration
and evidence, not a callable pricing evaluator or provider exporter. See
`engineering/replacement-pricing-contract.md` on that stack. VAY-1542 owns
actual evaluation; VAY-1545 owns provider materialization and adjustment
ownership. Both were Backlog at this checkpoint. VAY-1540/1541 own persisted
configuration and command validation. These dependencies prevent declaring
replacement setup ready; they do not prevent read-only channel discovery.

## Launch acceptance

1. Consume revision-bound canonical offers through the replacement evaluator
   and provider adapter. Missing configuration, evaluator, stale revisions or
   unsupported currency/guest/meal semantics must return unavailable before
   a pricing write. Do not substitute zero, a stored base-rate float, the old
   calculator or an assumed FX rate.
2. Preserve tenant-scoped binding claims and existing provider IDs. Repeated
   setup and retries must reuse the same canonical room/offer mappings. A new
   OTA code must not require a code change or create a dedicated rate by default.
   Distinct meal, occupancy or restriction products may require distinct rates.
3. Choose one adjustment owner for each exported price. For shared-base/native
   pricing, send the unmarked canonical amount and display the provider's ordered
   modifiers without applying them in Vayada. Prove a EUR510 base with +10%
   produces EUR561 once. Do not infer ownership merely from an OTA name or revive
   an old TypeScript calculator for connections missing strategy metadata.
4. Verify exact currency-aware decimal serialization and occupancy totals
   EUR100/130/155. A table total must not be multiplied by guest count. Verify
   supported child/meal combinations with actual represented guests, independent
   restriction inheritance, and explicit unsupported results. VAY-1530 owns meal
   identity, VAY-1528 restrictions, and VAY-1545 combined export/readback.
5. Exercise authenticated setup through durable jobs, initial price/inventory
   sync, partial failure, retry and stale-work handling. Mapping/activation must
   remain unavailable until current base mappings and initial ARI are verified.
   Old successful timestamps must not establish readiness for a new generation.
6. Verify discovery preserves separate provider channel IDs even for duplicate
   OTA types. Refresh is GET-only; amount/decrease/compound modifiers display in
   order, and unknown modifier semantics are not labeled as a simple percentage.
7. Use bounded synthetic inventory with zero availability. Record provider
   readback separately from actual OTA mapping/activation and delivery. OpenChannel
   or simulated Expedia evidence cannot establish real Expedia or Agoda behavior.
   Preserve shared fixtures; no real bookings, payments or automatic remapping.

## Existing evidence and review limits

The 2026-09-09 authenticated local flow used WorkOS Staging, PostgreSQL and the
real worker against a local HTTPS provider simulator. Setup/retry reused IDs,
missing canonical pricing blocked settings access, initial ARI sent EUR120.00
and zero availability, and refresh displayed simulated Expedia +12% with GET-only
requests. Separate live staging readback confirmed OpenChannel +12% and the
preserved EUR120.00 rate. These checks cover the earlier implementation, not
replacement evaluator/export integration or real Expedia onboarding.

CodeRabbit reported a review rate limit for both PRs, despite a SUCCESS status.
There was no completed CodeRabbit review at this checkpoint. Prior independent
implementation reviews do not substitute for review of the eventual integration.
