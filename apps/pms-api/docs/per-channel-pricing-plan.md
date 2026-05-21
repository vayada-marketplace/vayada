# Per-channel pricing via Channex — implementation plan

## Goal

Let a hotel charge different prices on Booking.com, Airbnb, and the direct booking engine. Markup is configured in Vayada admin; Vayada computes adjusted prices and pushes them to Channex per-rate-plan. Direct prices stay unchanged (served straight from the PMS).

## Product decisions (already agreed)

- **Markup scope:** per-hotel only. One set of markups applies to every room type.
- **Channels in v1:** Booking.com + Airbnb. Other OTAs left on the default/direct plan.
- **Non-refundable:** markup applies uniformly to both `standard` and `non_refundable` plan types.
- **Math location:** PMS computes adjusted prices and pushes N rate-plan entries to Channex. No reliance on Channex derived-rate-plan feature.

## Shape of the data model

### New table — `channex_channel_markups`

```sql
CREATE TABLE channex_channel_markups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,           -- 'booking_com' | 'airbnb' (extensible)
    markup_pct NUMERIC(6,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_channex_channel_markups_hotel_channel
    ON channex_channel_markups(hotel_id, channel);
```

### Extend `channex_rate_plan_mappings`

Add `channel TEXT NOT NULL DEFAULT 'direct'`. Replace the current non-unique room-type index with a composite unique index on `(room_type_id, channel, plan_name)`.

Existing rows default to `channel = 'direct'` — they continue to serve as the fallback plan.

### Plan combinations created per room type

- `direct / standard` (always — the existing default)
- `direct / non_refundable` (if `non_refundable_enabled`)
- `booking_com / standard`
- `booking_com / non_refundable` (if enabled)
- `airbnb / standard` only (Airbnb accepts one rate plan per listing)

## Implementation steps (in order)

### 1. Migration — `048_channex_per_channel_pricing.sql`

- Create `channex_channel_markups` table.
- `ALTER TABLE channex_rate_plan_mappings ADD COLUMN channel TEXT NOT NULL DEFAULT 'direct';`
- Drop `idx_channex_rate_plan_mappings_room_type` (currently non-unique, added in migration 032) and recreate as unique `(room_type_id, channel, plan_name)`.

### 2. Repository layer — `app/repositories/channex_mapping_repo.py`

- New class `ChannexChannelMarkupRepository` with:
  - `list_by_hotel_id(hotel_id) -> List[dict]`
  - `upsert(hotel_id, channel, markup_pct) -> dict`
  - `get_markup_map(hotel_id) -> dict[str, Decimal]` — returns `{'booking_com': 0.18, ...}`
- Update `ChannexRatePlanMappingRepository.create` signature to accept `channel: str = 'direct'`.
- Update `list_by_room_type_id` / `list_by_hotel_id` to include the `channel` column in results (already `SELECT *`, so just DTO-through).

### 3. Sync service — `app/services/channex_sync_service.py`

- **`provision_property`** (lines 120–154): replace the `plans_to_create` loop with an iteration over `(channel, plan_name)`:
  ```python
  plans_to_create = []
  for channel, label in [('direct', ''), ('booking_com', 'BDC'), ('airbnb', 'Airbnb')]:
      plans_to_create.append((channel, 'standard', f"{rt['name']} - {label} Standard".strip(' -')))
      if rt.get('non_refundable_enabled') and channel != 'airbnb':
          plans_to_create.append((channel, 'non_refundable', f"{rt['name']} - {label} Non-Refundable".strip(' -')))
  ```
  Dedup check against existing mappings is now `(channel, plan_name)`.
- **`_build_restriction_entry`** (lines 248–276): add `markup_pct: Decimal = 0` parameter. After resolving `rate`, apply `rate = round(rate * (1 + markup_pct / 100), 2)`. Direct passes 0.
- **`push_restrictions_for_rate_plan`** (lines 318–381): accept `channel` + look up the markup from `ChannexChannelMarkupRepository.get_markup_map` once at the top. Pass `markup_pct` into `_build_restriction_entry`.
- **`push_ari_for_hotel`** (lines 386–405): read markup map once per hotel; for each rate plan mapping, pass its `channel` and the corresponding markup into `push_restrictions_for_rate_plan`.

### 4. Admin endpoints — `app/routers/admin_channex.py`

- `GET /admin/channex/markups` → returns list of `{channel, markup_pct}` for the hotel. Includes defaults (0%) for channels with no row yet.
- `PUT /admin/channex/markups` → body `{markups: [{channel, markup_pct}]}`. Upserts each row. Kicks off `asyncio.create_task(push_ari_for_hotel(hotel_id))` so Channex sees new prices without manual re-sync.
- Add Pydantic models `ChannelMarkupResponse`, `ChannelMarkupUpdateRequest` in `app/models/channex.py`.

### 5. Frontend — `pms-frontend`

- `services/channex/index.ts`: add `getMarkups()` and `updateMarkups(markups)` methods + `ChannelMarkup` interface.
- `app/(app)/channel-manager/page.tsx`: new card "Channel Pricing" between the OTA iframe card and the provisioned-room-types card.
  - Numeric input for Booking.com (%), Airbnb (%). Single "Save" button.
  - After first save, show an info banner: "Open _Manage Channels_ and re-map each OTA to its new rate plan."
- i18n keys: `channels.channelPricing.title`, `channels.channelPricing.bookingComLabel`, etc.

### 6. Commits & ship

Three logical commits in `pms-backend`:

1. `feat(channex): migration 048 for per-channel pricing`
2. `feat(channex): per-channel rate plans + markup math`
3. `feat(channex): admin endpoints for channel markups`

Plus one commit in `pms-frontend`:

1. `feat(channel-manager): channel pricing UI`

Then bump submodule pointers in the parent repo.

## Things to check during implementation

- **Existing hotels with an active Channex property**: they already have `direct/standard` (+ maybe `direct/non_refundable`) plans. Re-running `/provision` after the migration will add `booking_com/*` and `airbnb/standard` plans. Make sure provision is idempotent on `(channel, plan_name)` not just `plan_name` (the migration's composite unique index will enforce this).
- **OTA re-mapping**: existing hotels that already have BDC/Airbnb connected via iframe are currently mapped to the old `standard` (now `direct/standard`) plan. They need to re-map inside the Channex iframe — surface this in the UI.
- **Channex plan quota**: a property with 5 room types × non-refundable enabled will now create 5 × 5 = 25 rate plans (up from 10). Worth noting in the `project_channex_multitenant.md` quota caveat.
- **Airbnb sync**: `push_restrictions_for_rate_plan` for the `airbnb/standard` plan must not send non-existent `airbnb/non_refundable`. The rate-plan-mapping rows drive the loop, so this is naturally correct.
- **Rate rounding**: apply `round(..., 2)` after markup, matches current code style.

## Out of scope for v1

- Per-room-type markup override.
- Expedia, Agoda, other OTAs (add rows to `channex_channel_markups` later; create plans via small provision extension).
- Channex-side derived-plan sync (our PMS-computed push is authoritative).
- Minimum-price floors / max-price ceilings per channel.
