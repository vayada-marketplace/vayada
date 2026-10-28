# VAY-902 shared add-on editor

[VAY-902](https://linear.app/vayadacom/issue/VAY-902) extends the existing target
`/api/booking/hotels/:hotelId/addon-items` contract. Architecture:
[TypeScript backend](typescript-backend-structure.md),
[PMS pricing read model](../apps/api/src/domains/pmsPricingReadModel.ts).

The existing `booking.addon_definitions.pricing_model` enum and `price_amount`
remain authoritative. The four toggle combinations already map to `per_stay`,
`per_guest`, `per_night`, and `per_guest_night`; existing target records need no
pricing conversion. This change does not touch legacy databases or APIs.

The existing metadata object gains `photos` (ordered, maximum five, exactly one
cover unless empty), `location`, `leadTimeHours` (VAY-2232: null, 12, 24, 48, 72
or 168), `maxGuests` (optional positive integer), and `maxQuantity` (positive
integer, default one). Saving `leadTimeHours` removes the free-text `leadTime`
older editors wrote; the API returns that text only while no choice is saved.
Text an older editor still writes replaces a saved choice, so that add-on stays off
the booking page until a choice is saved again.
The single `imageUrl`/`mediaObjectId` fields mirror the cover for compatibility.
Existing single images are projected as a one-photo gallery on read, so no
schema or destructive data migration is needed. Existing highlights and included
items remain archived in metadata; the new form never asks for them.

Writes resolve every managed image through the existing property-scoped approved
media registry. Client URLs cannot substitute for managed media. Imported image
URLs can only be retained on the original property's existing add-on. Photo order
and the cover flag persist independently. Empty galleries explicitly clear cover.

Currency is read from the PMS pricing read model, returned as `propertyCurrency`
in the list context, and inherited on price writes. Missing currency blocks saves.
Creation appends after the highest saved sort position while holding the existing
property lock. Edits and reorder operations retain their existing behavior.

Guest per-person counts retain the existing selected-adult policy, defaulting to
all adults; dates default to the stay and may be selected individually. A EUR 15
per-person-per-night breakfast for two adults and four nights costs EUR 120.
An optional `addonPackageQuantities` map carries package counts independently
of guests and dates through the quote and booking request. Max quantity limits
packages for all four models; existing requests default to one package. Lead time is a cutoff
(VAY-2232): guests can add the add-on only when check-in, at the hotel's check-in time in the
property's time zone, is at least that many hours away (the VAY-2145 bank-transfer rule). The
pricing-addons catalog names each add-on's first allowed check-in date (`bookableFrom`); the quote
and its acceptance check the rule against the database clock. Unconverted free text stays hidden.

"When does it happen?" (VAY-2391, migration 0525) is stored in two columns:

- `schedule_mode`: `arrival`, `departure`, `guest_pick`, `daily` or `anytime`.
- `bookable_weekdays`: ISO weekdays, 1 Monday to 7 Sunday, all seven by default.

The API reads and writes them as `scheduleMode` and `bookableWeekdays`, and the pricing-addons
catalog serves both.

A per-night price is always `daily`, and `daily` needs a per-night price. A save that breaks
this rule is refused with 422. A save without a mode picks one:

- when the price changes and the saved mode no longer fits, the default takes over;
- the default is `daily` for a per-night price, `arrival` for transport and `guest_pick`
  otherwise;
- readers treat a stored per-night price as `daily`.

When the guest sends no day, the quote fills it in:

- `arrival`: the check-in day;
- `departure`: the check-out day;
- `daily`: every night;
- `anytime`: no day, booked as one line with a NULL `service_date`;
- `guest_pick`: no day is filled in. Such a line stays unbookable until the guest picks one.

The guest sends a day only for a `guest_pick` add-on (VAY-2391 part 4, once the booking page that
sends no other day was live). The quote refuses:

- a day for an `arrival`, `departure` or `anytime` add-on other than its own;
- a `guest_pick` day on a weekday the add-on isn't bookable on, or on the check-out day;
- nights for a `daily` add-on other than every night of the stay.

Quotes issued before 0525 have a stale add-ons source revision, so guests get a new quote.
Booked `anytime` lines have no `service_date`: finance counts their revenue on the check-in day
("inferred"), and a folio line can't reference them (folio lines need a date).

The shared AddonEditor is used by Booking Flow settings. The unused onboarding
AddonsStep was deleted in VAY-2174; restoring an onboarding navigation step is a
separate product decision.
