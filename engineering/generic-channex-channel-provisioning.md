# Generic Channex channel setup

VAY-1547. Accepted direction: 2026-09-07. Implementation: VAY-1548 → VAY-1549 → VAY-1550.

## Decision

New connections use shared canonical Channex base rates and Channex-native
channel-wide price modifiers. Channex's embedded UI owns OTA credentials and
listing mapping. Extra rate variants are reserved for independently managed
prices, restrictions, meal or occupancy products; OTA names are not a
provisioning allowlist.

Existing connections retain their variants and Vayada-applied markups. There is
no automatic migration, remapping or deletion. The same adjustment must never
be applied both by Vayada and by Channex.

## Staging evidence

The 2026-09-07 probe used an isolated synthetic room/base rate on the shared
property-scoped staging account and an Open Channel receiver. Channex itself,
provider API calls and outbound delivery were real; the OTA was simulated.

- A channel saved successfully while no rooms or rates existed; it remained disabled.
- GET channels returned `data.id`, `attributes.channel: "OpenChannel"`,
  `is_active: false`, property IDs and mapped rate IDs. It did not return
  `attributes.application`.
- Channel Settings offered amount/percent increases and decreases. A saved
  +12% appeared as `settings.derived_option.rate: [["increase_by_percent", "12"]]`.
- A room and shared base rate were created through standard APIs and mapped in
  the embedded UI. Save offered separate Save Only and Save & Activate actions.
- Actual update, activation and deactivation callbacks arrived. The creation
  callback was not captured because the webhook was registered afterward.
- An explicit `rate: "100.00"` write for one date produced outgoing
  `rate: "112.00"`, EUR, occupancy 2. Inventory stayed zero with stop-sell set.
- Channel and callback were disabled, the temporary receiver/tunnel stopped,
  and fixtures retained. No guest booking, payment or message was created.

The initial numeric `100` at rate creation produced `1.12` after markup; the
decimal-string write produced `112.00`. All money writes must use the explicit
currency/unit contract, including provisioning. VAY-1527 owns nightly pricing.

This is not evidence of real Expedia/Agoda onboarding, multiple simultaneous
channel mappings, or every occupancy/restriction combination. Those remain
acceptance boundaries, not reasons to hardcode each OTA.

## Contracts

**Identity:** Keep provider channel ID and raw provider code separately from
display aliases. Two connections of the same OTA remain distinct. Existing
cached records without IDs remain readable, but cannot authorize a channel
mutation. Never persist channel credentials/settings wholesale.

**Discovery:** Read every page with the bound property's filter. Validate the
entire listing before replacing cached channels; malformed or failed pages
must leave the previous complete snapshot intact. Reject cross-property
records. Unknown channel codes are valid data, not errors.

**Refresh:** Channel lifecycle events are property-scoped refresh hints, not
proof of readiness. Reuse durable jobs and deduplication. A bounded refresh
after embedded setup supplies a fallback. Do not rely on a webhook arriving
before the hotel reaches the mapping screen: shared base rates already exist.

**Pricing ownership:** New shared-base connections explicitly record their
strategy; absence means legacy Vayada-managed variants. Re-enabling an existing
binding or adopting existing provider rates must not silently change strategy.
Shared connections reject Vayada-side channel markup writes and show the native
modifiers; retained legacy connections preserve their existing markup behavior.

**Mapping completeness:** Provider channel discovery is not the set of required
Vayada rate variants. ARI completeness checks cover the explicitly managed
room/rate mappings, including missing mappings for new active canonical rates.
Missing inventory mappings still fail closed. A newly discovered channel must
not manufacture a nonexistent required pricing variant and stop valid updates.

**Readiness:** Distinguish base-rate preparation, OTA mapping/activation and
last synchronization result. Never equate an active channel or successful
provisioning job with OTA readiness. Seed date-specific prices and restrictions
before mapping/activation is offered as ready. Preserve VAY-1528 restrictions,
VAY-1530 meals and VAY-1545 occupancy contracts.

**UI:** Start with Channex's existing modifier editor. Display native modifiers
without flattening compound, decrease or amount rules into an incorrect single
percentage. Use provider IDs as row identity; do not expose provider credentials.

## Delivery slices

1. VAY-1548 fixes discovery shape, stable identity, pagination and the coupled
   mapping guard. It changes no rates, markup ownership or OTA activation.
2. VAY-1549 introduces explicit new-connection shared-base provisioning and
   readiness, preserving legacy defaults and safe retry/reuse behavior.
3. VAY-1550 adds native modifier visibility and a per-property migration runbook.
   Existing properties remain unchanged until an explicit migration is requested.

Migration requires a scoped inventory of current mappings and both modifier
layers, representative final-price comparisons across dates/occupancies, retained
old mappings, an authorized audited switch and a tested rollback. Provider-level
equivalence is required; a passing login or mock test is insufficient.

## Validation

Regression fixtures cover real provider shape, unknown codes, same-type channel
IDs, inactive/unmapped state, pagination failure, cross-property responses and
legacy cached records. DB tests cover complete and missing managed mappings and
ensure unrelated discovery does not block ARI. Shared setup tests cover partial
failure/retry, legacy behavior and conflicting markup writes. UI changes require
a real browser check; staged final-price evidence must distinguish a simulated
OTA receiver from an actual Expedia property.

## References

- [Channel iframe](https://docs.channex.io/api-v.1-documentation/channel-iframe)
- [Open Channel API](https://docs.channex.io/for-ota/open-channel-api)
- [Webhooks](https://docs.channex.io/api-v.1-documentation/webhook-collection)
- [Rate plans](https://docs.channex.io/api-v.1-documentation/rate-plans-collection)
- Related: VAY-1531 channel inventory; VAY-844 webhook setup; VAY-846 recovery.
