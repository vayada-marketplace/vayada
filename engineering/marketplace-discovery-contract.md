# MarketplaceDiscovery contract

This contract is marketplace vertical **V1 (public discovery reads)** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md),
following the contract standard in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md).
It covers the two public browse surfaces: hotel listings and creators. It does
not cover authenticated profile reads/writes, collaboration actions, listing
detail pages, or any admin surface.

The legacy sources are `GET /marketplace/listings` and
`GET /marketplace/creators` in
`apps/marketplace-api/app/routers/marketplace.py`. Consumers:
`apps/marketplace-web` (browse pages), `apps/vayada-admin` (marketplace
dashboard), and `apps/landing` (hotel-creator-network page).

## Endpoints

| Field                  | Listings                                                  | Creators                                                  |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Method                 | `GET`                                                     | `GET`                                                     |
| Path                   | `/api/marketplace/listings`                               | `/api/marketplace/creators`                               |
| Route adapter          | `registerMarketplaceDiscoveryRoutes`                      | `registerMarketplaceDiscoveryRoutes`                      |
| Frontend client target | `getMarketplaceListings(input) -> MarketplaceListingPage` | `getMarketplaceCreators(input) -> MarketplaceCreatorPage` |

## Authorization

Both routes are **public**. This is an explicit documented exception to the
`enforceRoutePolicy` requirement, in the same family as the public AI
bookability routes: no authentication, no `RequestContext`, no tenant scope.

Because the routes are public, the responses may contain only public-safe
fields. For listings this is enforced at the schema level
(`chk_marketplace_listing_read_model_public_json` rejects private keys in the
read model's JSONB columns). The creators response is assembled from base
tables (`creator_profiles`, `creator_platforms`, `creator_ratings`) that do
contain private columns (`phone`, `owner_user_id`, `pii_retention_until`,
`profile_metadata`), so creators rely entirely on route-level projection plus
the fixture `mustExclude` assertions — the route must select named public
columns, never serialize whole rows.

Cross-origin: the browser cross-origin callers are **marketplace-web** and
**vayada-admin** (both call the API from a different web origin). The route
group must allow GET from those origins per environment. `apps/landing`'s
hotel-creator-network page fetches server-side (Next.js server component), so
it needs network reachability but not CORS. No credentials are required or
allowed on these requests.

Caching: responses carry
`Cache-Control: public, max-age=60, stale-while-revalidate=300` (same policy
as the public AI profile route). Because the CORS allow-origin header varies
by requester, every response on this group — allowlisted or not — must also
carry `Vary: Origin`, or shared caches would replay un-CORSed responses to
browser consumers.

## ID continuity (mixed legacy/target window)

V1 cuts over while collaborations stay on the legacy API until V4. Consumers
feed browse IDs directly into legacy endpoints: marketplace-web's hotel card
sends `listing_id` to legacy `POST /collaborations`, the creator detail modal
sends `creator_id` to the legacy invite flow, and vayada-admin's collaboration
modal matches `getListings()` rows against legacy `collaboration.listing_id`.

Therefore: **`listingId` and `creatorId` in V1 responses are the legacy
marketplace UUIDs** (`hotel_listings.id`, `creators.id`). The target tables
mint new primary keys and keep the legacy IDs in
`source_listing_id`/`source_creator_id`; the route exposes the source IDs
until the collaborations vertical (V4) cuts over and a coordinated ID
migration is planned. Target-native PKs must not leak into V1 responses.

## Request

```ts
type MarketplaceListingsRequest = {
  params: Record<string, never>;
  query: {
    limit?: number; // clamped to [1, 200], default 100
    offset?: number; // clamped to >= 0, default 0
  };
};

type MarketplaceCreatorsRequest = {
  params: Record<string, never>;
  query: {
    limit?: number; // clamped to [1, 200], default 100
    offset?: number; // clamped to >= 0, default 0
  };
};
```

Out-of-range numeric values are **clamped**, matching the booking reservations
list route convention. Non-numeric, non-integer, or duplicated
`limit`/`offset` values return `400` with `code: "invalid_query"`. An empty
value (`?limit=`) is treated as absent.

The legacy endpoints accepted no effective query parameters: the
marketplace-web/landing clients contain `page`/`limit` plumbing but no call
site sends them (the backend ignored them anyway), and the legacy
`creator_type` filter on `/creators` has no consumer. See intentional
differences.

Consumers that need the full dataset (landing's combined-reach stat,
vayada-admin's tab counts and collaboration modal lookup) must **iterate pages
to exhaustion** using `pagination.total`, or use `pagination.total` directly
where only a count is rendered. This is a required VAY-755 client behavior,
not optional.

## Response

### Listings

Default ordering: `createdAt DESC, listingId ASC`.

```ts
type MarketplaceListingPage = {
  items: MarketplaceListingReadModel[];
  pagination: { limit: number; offset: number; total: number };
};

type MarketplaceListingReadModel = {
  listingId: string; // legacy hotel_listings.id (see ID continuity)
  publicId: string; // marketplace_listing_read_model.public_id
  canonicalSlug: string; // .canonical_slug
  displayName: string; // .display_name (legacy hotel_name)
  listingTitle: string; // .listing_title (legacy name)
  listingSummary: string | null; // .listing_summary (legacy description)
  accommodationType: string | null; // .accommodation_type
  location: {
    displayText: string; // legacy single-string location
    countryCode?: string;
    city?: string;
  }; // public-safe subset of .location JSONB
  coverImageUrl: string | null; // property catalog public profile picture (legacy hotel_picture); joined from the hotel catalog public read model, NOT prepended into imageUrls
  imageUrls: string[]; // .image_urls — listing gallery images only
  offerings: MarketplaceOfferingSummary[]; // .public_offering_summary
  creatorRequirements: MarketplaceCreatorRequirements | null; // .public_creator_requirements
  createdAt: string; // legacy listing creation time, preserved by the transform (drives Newest/Oldest sort)
  projectedAt: string; // .projected_at (read-model freshness)
};

type MarketplaceOfferingSummary = {
  offeringId: string;
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null; // money decimal serialized as string
  currency: string | null;
  discountPercentage: number | null; // percentages/rates serialized as numbers
  commissionPercentage: number | null;
  minFollowers: number | null;
};

type MarketplaceCreatorRequirements = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[] | null;
};

type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";
```

Serialization rule: money decimals are strings (`paidMaxAmount`);
percentages, rates, and counts are numbers.

Server-side filter: only rows with `visibility_status = 'public'` are
returned. Projection mapping that produces it, preserving current legacy
behavior: a listing is `public` when its hotel profile is complete and the
owning account is verified — the legacy listing `status`
(`pending`/`verified`/`rejected`) does **not** gate visibility today
(pending and rejected listings of eligible hotels are served and rendered),
and V1 keeps that behavior. Whether rejected listings should be hidden is a
product decision deliberately out of scope here; if taken later it changes the
projection, not this contract.

### Creators

Default ordering: `createdAt DESC, creatorId ASC`.

```ts
type MarketplaceCreatorPage = {
  items: MarketplaceCreatorReadModel[];
  pagination: { limit: number; offset: number; total: number };
};

type MarketplaceCreatorReadModel = {
  creatorId: string; // legacy creators.id (see ID continuity)
  displayName: string; // creator_profiles.display_name
  locationText: string | null; // .location_text
  shortDescription: string | null; // .short_description
  portfolioUrl: string | null; // .portfolio_url
  profilePictureUrl: string | null; // .profile_picture_url
  creatorType: "lifestyle" | "travel" | "other"; // .creator_type; DDL value 'migration' maps to "other" in the response
  platforms: MarketplaceCreatorPlatform[];
  audienceSize: number; // sum of platforms[].followerCount
  averageRating: number; // aggregate over creator_ratings.rating, 2 decimals
  totalReviews: number; // count of creator_ratings rows
  createdAt: string; // legacy creator creation time (drives Newest/Oldest sort)
};

type MarketplaceCreatorPlatform = {
  platformId: string; // creator_platforms.id
  platform: MarketplacePlatformName; // .platform
  handle: string; // .handle
  followerCount: number; // .follower_count
  engagementRate: number; // .engagement_rate
  audienceCountries: { country: string; percentage: number }[]; // .audience_countries
  audienceAgeGroups: { ageRange: string; percentage: number }[]; // .audience_age_groups
  audienceGenderSplit: { male: number; female: number; other?: number } | null; // .audience_gender_split, null when empty
};
```

Eligibility: only creators with `profile_complete = true`,
`profile_status = 'active'`, and a non-null `display_name` are returned. The
transform guarantees `display_name` is populated from the legacy
`auth-db.users.name` during migration; rows that still end up null are
excluded rather than served with an empty name. The legacy cross-DB merge of
`auth-db.users.name` in route code must not be reproduced at runtime.

## Errors

Error responses use the established backend-http error envelope:

```ts
type MarketplaceDiscoveryError = {
  statusCode: 400 | 500;
  code: "invalid_query" | "internal_error";
  category: "validation" | "internal";
  message: string;
};
```

| Case                         | Status | Code             |
| ---------------------------- | ------ | ---------------- |
| Non-numeric `limit`/`offset` | `400`  | `invalid_query`  |
| Unexpected failure           | `500`  | `internal_error` |

Out-of-range numeric pagination values are clamped, not rejected. Empty result
sets are `200` with `items: []`, never an error.

## Intentional differences from legacy

| Legacy behavior                                                      | Contract behavior                                                                   | Why                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner_email` returned on every listing                              | **Removed.**                                                                        | Public PII leak. No consumer renders it from this endpoint (vayada-admin's hotels page gets owner emails from its authenticated admin user list).                                                                                                                  |
| `owner_user_id` returned on every listing                            | **Removed.**                                                                        | Identity linkage does not belong on a public surface. vayada-admin's `MarketplaceListingModal` uses it only to deep-link to user admin; that consumer must switch to an authenticated admin lookup (flagged for VAY-755; long-term home is the V7 admin vertical). |
| `status` field (`pending`/`verified`/`rejected`) per listing         | **Removed.**                                                                        | No browse consumer branches on it, and the route pre-filters to `visibility_status = 'public'` (mapping above preserves which listings are visible).                                                                                                               |
| `hotel_profile_id` per listing                                       | Replaced by `publicId`/`canonicalSlug`.                                             | Internal profile IDs are not public identifiers; slugs and public IDs are the cross-surface keys per the property catalog model.                                                                                                                                   |
| `hotel_picture` + `images` as separate fields                        | `coverImageUrl` + `imageUrls`.                                                      | Same split, explicit names. Cover comes from the hotel catalog public profile read model; gallery stays listing-owned. Consumers keep their distinct avatar/gallery semantics.                                                                                     |
| Bare JSON array response                                             | `{ items, pagination }` envelope with server-side `limit`/`offset`.                 | Clients already fake pagination locally; the envelope lets the server own it. Full-dataset consumers iterate pages (see Request). Clients update in VAY-755.                                                                                                       |
| `creator_type` query filter (`Lifestyle`/`Travel`)                   | **Dropped.**                                                                        | No consumer sends it. Can return as a filter slice if product asks.                                                                                                                                                                                                |
| Capitalized enums (`"Lifestyle"`, `"Instagram"`, `"Free Stay"`)      | Lowercase snake enums per target DDL (`"lifestyle"`, `"instagram"`, `"free_stay"`). | Match the target schema check constraints; clients map labels at render time.                                                                                                                                                                                      |
| Creator `name` from `auth-db.users.name` via cross-DB merge          | `displayName` from `creator_profiles.display_name`.                                 | The TypeScript runtime must not read the legacy auth DB; the transform denormalizes the display name.                                                                                                                                                              |
| `creator_requirements.creator_types` per listing                     | **Dropped.**                                                                        | No consumer renders it. Can return with a future filter slice.                                                                                                                                                                                                     |
| Offering/requirement `listing_id`, `created_at`, `updated_at` echoes | **Dropped.**                                                                        | Copied by one transform but never rendered; pure payload weight.                                                                                                                                                                                                   |

## Fixtures

`engineering/fixtures/marketplace-discovery/cases.json`
(`contractVersion: "marketplace-discovery.v1"`) defines the cases the route
ticket (VAY-754) must implement as route tests:

| Case                           | Asserts                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `listings-populated`           | Two public listings with offerings + requirements; lowercase enums; `mustExclude` owner email/user id keys anywhere in the payload. |
| `listings-excludes-non-public` | Private/unlisted/disabled rows and an incomplete-profile hotel's listing are absent.                                                |
| `listings-empty`               | `200` with empty `items` and `total: 0`.                                                                                            |
| `listings-pagination`          | `limit`/`offset` slice the `createdAt DESC, listingId ASC` ordering; `total` reflects the full count.                               |
| `listings-clamps-out-of-range` | `limit=0` → 1, `limit=999` → 200, `offset=-5` → 0; `200` responses.                                                                 |
| `listings-invalid-query`       | Non-numeric `limit` → `400 invalid_query`.                                                                                          |
| `creators-populated`           | Active complete creators with platforms; lowercase enums for `creatorType` and `platform`.                                          |
| `creators-audience-aggregates` | `audienceSize` equals the sum of `followerCount`; `averageRating`/`totalReviews` match the ratings fixture rows.                    |
| `creators-empty-platforms`     | A creator with no platform rows returns `platforms: []` and `audienceSize: 0`.                                                      |
| `creators-excludes-ineligible` | Incomplete, non-active, and null-display-name creators are absent.                                                                  |
| `creators-empty`               | `200` with empty `items`.                                                                                                           |

## Validation requirements for follow-up tickets

- VAY-754 (routes): route tests cover every fixture case; a payload-wide
  assertion proves no key matching `owner`, `email`, `phone`, or `user_id`
  appears in either response; CORS verified for the marketplace-web and
  vayada-admin origins (landing is server-to-server and needs none); ID
  continuity verified against legacy fixture IDs.
- VAY-755 (clients/cutover): typed clients implement the page envelope,
  page-iteration for full-dataset consumers, and enum label mapping;
  vayada-admin's listing modal deep-link is rewired to an authenticated admin
  source before the public fields disappear; Newest/Oldest sort switches to
  `createdAt` from the new payload.

## References

- VAY-753: this contract.
- VAY-737 / `marketplace-route-migration-inventory.md`: vertical order and
  consumer inventory.
- `packages/backend-migration/migrations/0008_marketplace.sql`: backing DDL.
- `target-schema-ownership-map.md`: marketplace table ownership.
- `booking-room-filter-settings-contract.md`: contract style reference.
- `public-bookability-contract.md`: public route + fixtures style reference.
