# MarketplaceHotelSelfService contract

This contract is marketplace vertical **V2 (hotel profile and listings
self-service)** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md).
It follows the read-before-write pattern in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md)
and builds on the public discovery ID rules in
[`marketplace-discovery-contract.md`](marketplace-discovery-contract.md).

The legacy sources are `/hotels/me/profile-status`, `GET/PUT /hotels/me`, and
`POST/PUT/DELETE /hotels/me/listings*` in
`apps/marketplace-api/app/routers/hotels.py`. The sole current consumer is
`apps/marketplace-web`.

This contract is intentionally a contract-first slice. It does not cut
marketplace-web over, does not implement route handlers, and does not cover
creator profile self-service, collaboration lifecycle, uploads, notifications,
or admin listing management.

## Endpoints

| Field                 | Profile status                                         | Profile read/update                             | Listing create/update/delete                                  |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------- |
| Methods               | `GET`                                                  | `GET`, `PUT`                                    | `POST`, `PUT`, `DELETE`                                       |
| Paths                 | `/api/marketplace/hotels/me/profile-status`            | `/api/marketplace/hotels/me`                    | `/api/marketplace/hotels/me/listings[/{listingId}]`           |
| Backing tables        | `marketplace_hotel_profiles`, hotel catalog read model | `marketplace_hotel_profiles`, hotel catalog     | `marketplace_hotel_listings`, offerings, requirements         |
| Frontend client shape | `getMyMarketplaceHotelProfileStatus()`                 | `getMyMarketplaceHotelProfile()`, `update...()` | `create...Listing()`, `update...Listing()`, `delete...()`     |
| Rollout order         | Read contract before writes                            | Read before `PUT`                               | `POST`/`PUT` before `DELETE`, only after ID rules are covered |

## Ownership

Canonical property facts come from the hotel catalog:

- `hotel_catalog.properties`
- `hotel_catalog.property_public_profile_read_model`
- property catalog contact/media/location projections

Marketplace owns only marketplace participation state:

- `marketplace.marketplace_hotel_profiles`
- `marketplace.marketplace_hotel_listings`
- `marketplace.listing_collaboration_offerings`
- `marketplace.listing_creator_requirements`
- `marketplace.marketplace_listing_read_model`

`PUT /api/marketplace/hotels/me` does **not** write canonical property facts
such as display name, public location, website, phone, email, or cover image.
Those fields are returned for context from the hotel catalog and are read-only
in this vertical. A future hotel catalog self-service command may own those
writes; this contract does not hide that decision inside marketplace routes.

## Authorization

All V2 routes are protected routes and must use route policy enforcement at the
adapter boundary.

Implementation prerequisite: the route implementation slice must grant
`marketplace.profile.manage` to the accepted hotel-group roles before enabling
these routes. The current baseline role seed proves the permission key exists,
but hotel-group grants are not part of this contract-only change.

Required policy for profile status, profile read, and profile update:

```ts
{
  permission: "marketplace.profile.manage",
  resource: {
    product: "marketplace",
    resourceType: "hotel_profile",
    resourceId: profile.propertyId,
    allowedRelationships: ["owner", "operator"],
  },
}
```

Required policy for updating or deleting an existing listing:

```ts
{
  permission: "marketplace.profile.manage",
  resource: {
    product: "marketplace",
    resourceType: "hotel_listing",
    resourceId: listing.listingResourceId,
    allowedRelationships: ["owner", "operator"],
  },
}
```

`listingResourceId` is the target-native
`marketplace.marketplace_hotel_listings.id` UUID. It is resolved after the route
loads the row addressed by the public `listingId` path parameter
(`marketplace_hotel_listings.source_listing_id`) inside the authorized profile's
`property_id` scope. It is never returned in response payloads.

Create listing uses the profile resource check because the listing does not
exist yet. The route creates the listing under the authorized profile's
`property_id` and `organization_id`, then creates an active
`identity.organization_resource_links` row for the new target listing UUID before
returning success. If either write fails, the listing creation rolls back and the
route must not return a public `listingId`.

### Compatibility fallback

Preferred authorization is the organization resource-link path from
[`workos-identity-architecture.md`](workos-identity-architecture.md):

```text
WorkOS session
-> internal user
-> selected organization
-> active membership
-> marketplace.profile.manage
-> organization_resource_links row for marketplace hotel_profile / hotel_listing
```

During migration only, the adapter may use a documented fallback for legacy
hotel accounts that are not linked yet:

```text
internal user_id
-> legacy hotel_profiles.user_id
-> marketplace_hotel_profiles.source_hotel_profile_id
-> property_id / organization_id scoped to the migrated row
```

Fallback rules:

- It is allowed only when no active marketplace hotel profile resource link is
  available for the selected organization.
- It may resolve only `source_system = 'migration'` profiles.
- It must resolve exactly one current profile. Multiple matches return
  `409 ambiguous_legacy_profile`.
- It must not expose `user_id`, owner email, legacy JWT claims, or
  `users.type` in the API payload.
- It must set audit metadata or route-local telemetry to
  `authorizationMode: "legacy_user_id_fallback"` so link backfill can be
  monitored.
- It cannot bypass listing authorization. Updating or deleting a listing still
  resolves the public `listingId` to the target listing UUID inside the fallback
  profile scope before the route mutates anything.

The fallback is an implementation bridge, not the target authorization model.

## ID continuity

V1 public discovery exposes `listingId` as
`marketplace_hotel_listings.source_listing_id`, not the target table primary
key. V2 must keep the same rule until the collaboration lifecycle vertical
plans a coordinated ID migration.

Rules:

- Every listing returned by V2 has a non-null external `listingId`.
- Migrated rows keep the legacy `hotel_listings.id` in `source_listing_id`.
- New V2-created rows must assign a stable external UUID and persist it in
  `source_listing_id` before the row can be returned or projected publicly.
- V2 `listingId` must equal V1 discovery `items[].listingId` for the same row.
- `PUT` never changes `listingId`.
- `DELETE` archives the listing and removes or privatizes its discovery read
  model projection; it does not recycle the ID.
- Target-native `marketplace_hotel_listings.id` stays internal to the route
  repository and does not appear in response payloads.
- Listing update/delete policy checks use that target-native UUID, not
  `source_listing_id`, because `identity.organization_resource_links.resource_id`
  stores target resource IDs.

## Request and response

Shared enums are lowercase target-schema values:

```ts
type MarketplaceHotelProfileStatus = "pending" | "verified" | "rejected" | "suspended" | "archived";

type MarketplaceHotelListingStatus =
  | "draft"
  | "pending"
  | "verified"
  | "rejected"
  | "suspended"
  | "archived";

type MarketplaceAccommodationType =
  | "hotel"
  | "resort"
  | "boutique_hotel"
  | "lodge"
  | "apartment"
  | "villa"
  | "other";
```

### Profile status

```ts
type MarketplaceHotelProfileStatusResponse = {
  contractVersion: "marketplace-hotel-self-service.v1";
  authorizationMode: "organization_resource_link" | "legacy_user_id_fallback";
  propertyId: string;
  profileComplete: boolean;
  missingFields: MarketplaceHotelMissingField[];
  hasDefaults: { location: boolean };
  missingListings: boolean;
  completionSteps: string[];
};

type MarketplaceHotelMissingField =
  | "displayName"
  | "location"
  | "hostSummary"
  | "website"
  | "coverImage"
  | "listing";
```

`displayName`, `location`, `website`, and `coverImage` are catalog-derived
checks. `hostSummary` is marketplace-owned. `listing` requires at least one
non-archived marketplace listing.

### Profile read

```ts
type MarketplaceHotelProfileResponse = {
  contractVersion: "marketplace-hotel-self-service.v1";
  authorizationMode: "organization_resource_link" | "legacy_user_id_fallback";
  property: MarketplaceHotelPropertyFacts;
  marketplaceProfile: MarketplaceHotelProfile;
  listings: MarketplaceHotelListing[];
};

type MarketplaceHotelPropertyFacts = {
  propertyId: string;
  publicId: string;
  displayName: string;
  canonicalSlug: string;
  profileStatus: "complete" | "incomplete" | "disabled" | "private";
  location: {
    displayText: string;
    countryCode?: string;
    region?: string;
    city?: string;
  };
  websiteUrl: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  coverImageUrl: string | null;
  projectedAt: string;
};

type MarketplaceHotelProfile = {
  propertyId: string;
  organizationId: string;
  marketplaceProfileStatus: MarketplaceHotelProfileStatus;
  profileComplete: boolean;
  profileCompletedAt: string | null;
  hostSummary: string | null;
  collaborationGuidelines: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The response must exclude raw owner identity and legacy profile identifiers:
`user_id`, `userId`, `owner_email`, `ownerEmail`, `hotel_profile_id`, and
`hotelProfileId`.

### Profile update

```ts
type UpdateMarketplaceHotelProfileRequest = {
  hostSummary?: string | null;
  collaborationGuidelines?: string | null;
};
```

Unknown fields are rejected. In particular, legacy editable fields
`name`, `location`, `email`, `website`, `phone`, and `picture` return
`400 canonical_property_read_only` from the V2 route. They must not be silently
accepted, because doing so would make marketplace route code the owner of hotel
catalog facts.

### Listings

```ts
type MarketplaceHotelListing = {
  listingId: string;
  propertyId: string;
  listingStatus: MarketplaceHotelListingStatus;
  title: string;
  listingSummary: string | null;
  accommodationType: MarketplaceAccommodationType | null;
  rawLocationText: string | null;
  imageUrls: string[];
  collaborationOfferings: MarketplaceHotelListingOffering[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirements | null;
  createdAt: string;
  updatedAt: string;
};

type MarketplaceHotelListingOffering = {
  offeringId: string;
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  currency: string | null;
  termsSummary: string | null;
};

type MarketplaceHotelListingCreatorRequirements = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
};
```

Internal route authorization uses a separate resolved target:

```ts
type MarketplaceHotelListingAuthorizationTarget = {
  listingId: string; // marketplace_hotel_listings.source_listing_id
  listingResourceId: string; // marketplace_hotel_listings.id
  propertyId: string;
  organizationId: string;
};
```

`rawLocationText` is a marketplace listing label retained for migration parity.
It is not the canonical property address; UI that needs canonical geography must
use `property.location`.

Create request:

```ts
type CreateMarketplaceHotelListingRequest = {
  title: string;
  listingSummary?: string | null;
  accommodationType?: MarketplaceAccommodationType | null;
  rawLocationText?: string | null;
  imageUrls?: string[];
  imageMediaObjectIds?: string[];
  collaborationOfferings: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirementsWrite;
};
```

Update request:

```ts
type UpdateMarketplaceHotelListingRequest = Partial<
  Omit<CreateMarketplaceHotelListingRequest, "collaborationOfferings" | "creatorRequirements">
> & {
  collaborationOfferings?: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements?: MarketplaceHotelListingCreatorRequirementsWrite | null;
};
```

Writes replace the full offering array when `collaborationOfferings` is present.
Writes replace or clear creator requirements when `creatorRequirements` is
present.

Validation:

- `title` must be non-empty.
- `collaborationOfferings` is required on create and must contain at least one
  offering.
- Every offering requires at least one `availabilityMonths` entry and one
  `platforms` entry.
- `free_stay` requires positive min/max nights and max >= min.
- `paid` requires positive `paidMaxAmount`, serialized as a decimal string.
- `discount` requires `discountPercentage` from 1 to 100.
- `affiliate` requires `commissionPercentage` from 1 to 100.
- `minFollowers`, when present, must be positive.
- Creator age max must be greater than or equal to age min when both are
  present.

## Discovery read model coherence

Any V2 write that changes public listing fields must update or enqueue a
refresh for `marketplace.marketplace_listing_read_model` in the same logical
operation:

- create listing: create read-model projection only when the profile/listing is
  eligible for discovery; otherwise project non-public or leave absent
  according to the V1 projection rule;
- update listing: refresh title, summary, accommodation type, location,
  gallery, offerings, requirements, and `projected_at`;
- delete listing: archive listing and remove or non-public the read-model row;
- profile update: refresh discovery rows affected by host/profile completion
  state if `profile_complete` changes.

Route tests for write implementation must compare the V2 listing response
`listingId` to the V1 discovery fixture row for the same listing.

## Errors

Error responses use the backend HTTP error envelope:

```ts
type MarketplaceHotelSelfServiceError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 500;
  code:
    | "invalid_request"
    | "canonical_property_read_only"
    | "unauthorized"
    | "forbidden"
    | "missing_resource_link"
    | "not_found"
    | "ambiguous_legacy_profile"
    | "id_continuity_violation"
    | "validation_failed"
    | "internal_error";
  category: "validation" | "auth" | "conflict" | "internal";
  message: string;
};
```

| Case                                          | Status | Code                           |
| --------------------------------------------- | ------ | ------------------------------ |
| Missing/invalid auth                          | `401`  | `unauthorized`                 |
| Missing permission                            | `403`  | `forbidden`                    |
| Missing org resource link and no fallback     | `403`  | `missing_resource_link`        |
| Profile/listing not found in authorized scope | `404`  | `not_found`                    |
| Ambiguous fallback legacy profile             | `409`  | `ambiguous_legacy_profile`     |
| Canonical property field sent to profile PUT  | `400`  | `canonical_property_read_only` |
| Listing write would return null listingId     | `409`  | `id_continuity_violation`      |
| Request field validation failure              | `422`  | `validation_failed`            |
| Unexpected failure                            | `500`  | `internal_error`               |

## Fixtures

Representative fixtures live in
`engineering/fixtures/marketplace-hotel-self-service/cases.json`
(`contractVersion: "marketplace-hotel-self-service.v1"`).

Follow-up route tickets must cover every fixture case before write cutover:

- linked profile status/read success;
- legacy `user_id` fallback success and no identity leakage;
- denied access when neither resource link nor fallback is available;
- profile update only changes marketplace-owned fields;
- canonical property fields are rejected;
- listing create/update preserve external `listingId` and refresh discovery;
- listing create creates a target `hotel_listing` organization resource link
  before returning;
- listing update/delete prove positive authorization with an active target
  `hotel_listing` link and denial when the resolved listing UUID is not linked;
- delete archives and removes the public discovery projection;
- listing validation errors.

## References

- VAY-796: this contract-first slice.
- VAY-737 / `marketplace-route-migration-inventory.md`: vertical order.
- `marketplace-discovery-contract.md`: V1 public discovery ID continuity.
- `workos-identity-architecture.md`: organization resource links and
  compatibility fallback.
- `request-context-contract.md`: route policy expectations.
- `packages/backend-migration/migrations/0004_property_catalog.sql`: canonical
  property facts.
- `packages/backend-migration/migrations/0008_marketplace.sql`: marketplace
  profile/listing tables and read model.
