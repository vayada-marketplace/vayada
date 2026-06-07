# Property Catalog Backfill Plan

_VAY-666 implementation note. Builds on
[`public-hotel-profile-ownership.md`](public-hotel-profile-ownership.md) and
[`target-schema-ownership-map.md`](target-schema-ownership-map.md)._

## Scope

The target DDL lives in
`packages/backend-migration/migrations/0004_property_catalog.sql`. It creates
the `hotel_catalog` schema for canonical public property identity, source
links, slugs, verified domains, location, profile copy, media, amenities,
public contacts, public policy summaries, and the
`property_public_profile_read_model` consumed by Distribution/public surfaces.

The first fixture case is
`packages/backend-migration/fixtures/cases/property-catalog-public-profiles`.
It documents one complete property, one property with missing/ambiguous
location, and one verified custom-domain property. Its parity expectations
assert complete/incomplete status, missing structured location behavior,
verified custom-domain projection, and forbidden private/provider keys in the
public read model.

## Source Inputs

| Source                                          | Target usage                                                                                                     | Notes                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Booking `booking_hotels`                        | Display name, slug, custom domain, locale, public contact, booking policy projection, booking-owned source links | Preferred source for current public booking identity when owner/admin catalog value is absent.                          |
| PMS `hotels`                                    | Timezone, structured address, geo, operational setup evidence, PMS source links                                  | PMS values seed catalog facts only through normalized fields. PMS and provider payload shapes are not public contracts. |
| Marketplace `hotel_profiles` / `hotel_listings` | Public copy, images, amenities, listing overlay source links, free-form location evidence                        | Free-form location is preserved as evidence and promoted only when confidence is high or confirmed.                     |

## Conflict Rules

| Field                  | Resolution                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display name           | Owner/admin catalog value, then Booking, then PMS, then Marketplace. Trim whitespace and preserve brand casing.                                                              |
| Slug                   | Canonical Booking slug or owner/admin catalog slug wins. Old Booking/Marketplace slugs become `property_slugs` redirects or overlays.                                        |
| Verified custom domain | Only verified domains enter `property_domains` with `canonical_when_verified = true`; unverified setup state remains out of public read models.                              |
| Structured address     | Prefer verified owner/admin or PMS structured address. Booking address may fill gaps. Marketplace free-form text is stored as `raw_marketplace_location` unless confirmed.   |
| Latitude/longitude     | Use only valid paired coordinates. Do not publish one coordinate without the other. Do not infer geo from low-confidence free-form text.                                     |
| Timezone               | Prefer explicit owner/admin or PMS IANA timezone, then Booking timezone. Unknown timezone keeps the public profile incomplete for quote semantics.                           |
| Locale                 | Catalog owns default/supported locales. Include only locales with renderable public content or defined fallback behavior.                                                    |
| Currency               | Finance owns target currency capability; catalog may reference public summaries but does not own payment provider state.                                                     |
| Descriptions           | Owner/admin catalog copy wins, then Booking public copy, then Marketplace profile/listing copy, then PMS property details. Store locale-specific copy only when public-safe. |
| Media                  | Owner/admin approved media wins, then Booking public media, then Marketplace approved listing media, then PMS property/room media only when explicitly public-approved.      |
| Amenities              | Normalize to controlled `amenity_key` values. Booking/PMS/Marketplace labels can seed display labels, but duplicate keys merge into one catalog fact.                        |
| Public contacts        | Include only field-level public contacts. Booking public support contact wins, then owner/admin catalog contact, then PMS/Marketplace contacts marked public.                |
| Public policy summary  | Booking/checkout owns booking policy semantics. Finance owns deposit/payment summaries. Catalog stores the public projection only.                                           |

## Public-Safety Rules

- Raw Booking/PMS/Marketplace IDs are stored only in `property_source_links`.
- Channex/provider IDs, credentials, mappings, webhook payloads, and sync traces
  are excluded from catalog tables.
- Public read models expose `public_id`, canonical slug/domain facts,
  public-safe profile/location/media/amenity/contact fields, and stable
  completeness reasons.
- Incomplete or ambiguous source data becomes a completeness reason or
  migration note, not a guessed public fact.

## Follow-Up Consumption

Distribution and public API/page work should consume
`hotel_catalog.property_public_profile_read_model` or a domain repository over
it. Follow-up route/API tickets should not query legacy Booking, PMS, or
Marketplace profile tables for public hotel identity.
