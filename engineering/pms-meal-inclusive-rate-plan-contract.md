# Canonical meal inclusion (VAY-1529)

Extends `pms-pricing.v1` and the existing property-scoped flexible-rate-plan
PUT/read contracts. VAY-1530 consumes this contract for Channex.

- `mealPlan` accepts exactly `room_only` or `breakfast`. Breakfast is included
  in `baseAmountDecimal`; no surcharge or optional add-on is created.
- Omitting `mealPlan` on update preserves stored inclusion. Omitting it on
  create defaults to `room_only`. Explicit `room_only` removes breakfast;
  null, empty strings and other values are invalid write inputs.
- Canonical rows predating this change may have SQL NULL: these mean room only
  for direct booking. Reads normalize them to `room_only`. This default applies
  only to `pricing_contract_version = pms-pricing.v1`; NULL on an adopted or
  legacy provider plan is unknown and must not overwrite provider meal terms.
- Storage is `pms.rate_plans.meal_plan`. The existing unique canonical plan per
  `(property_id, room_type_id)` and its `id` / `flexibleRatePlanId` are retained.
  Meal edits update the same row and increment `flexible_rate_plan_revision`;
  they never create another meal-specific plan or replace channel mappings.
- Existing scope authorization, room/currency/plan revision checks, idempotency,
  audit and `pms.pricing_source.changed` event behavior apply. Fingerprints
  distinguish omission from explicit choices. VAY-1530 owns any Channex queue
  trigger and provider reconciliation; this ticket emits the existing change
  event and public-offer projection notification only.
- Public offers disclose the inclusion; booking creation records purchased meal
  terms in immutable booking evidence. Later plan edits cannot rewrite them.
- Optional breakfast add-ons remain independent configuration. Included
  breakfast must not automatically select or charge an optional add-on.

This is a single inclusive flexible offer, not a parallel room-only/breakfast
package builder. Noncanonical plans and Python APIs are outside this contract.
