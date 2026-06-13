# MarketplaceTripsExternalCollaborations contract

This contract is marketplace vertical **V5 (trips and external
collaborations)** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md).
It covers creator-facing trip planning records and collaborations with hotels
outside the Vayada marketplace.

Legacy sources are the `/trips*` routes in
`apps/marketplace-api/app/routers/trips.py`. The current consumer is the
marketplace-web calendar surface.

Contract version: `marketplace-trips-external.v1`.

## Migration Slices

Reads land before writes:

1. Define this contract and fixtures against the target marketplace ownership
   model.
2. Add dark TypeScript read routes in `apps/api`:
   `GET /api/marketplace/trips`,
   `GET /api/marketplace/trips/{tripId}`, and
   `GET /api/marketplace/trips/external-collaborations`.
3. Add the marketplace-web typed client and cut over the calendar trip reads to
   the typed-client facade with legacy fallback while Python remains source of
   truth.
4. Implement write routes for create/update/delete trips and external
   collaborations.
5. Remove fallback once the TypeScript read and write routes are fully wired to
   the target read/write model.

This PR intentionally implements slice 1-3 only. Write commands stay in a
follow-up V5 slice because they need idempotency, validation, and audit behavior
that should not be hidden inside a read-route PR.

## Endpoints

| Surface                       | Method                  | Target path                                       | Frontend typed client                             |
| ----------------------------- | ----------------------- | ------------------------------------------------- | ------------------------------------------------- |
| Trip list                     | `GET`                   | `/api/marketplace/trips`                          | `listMarketplaceTrips()`                          |
| Trip detail                   | `GET`                   | `/api/marketplace/trips/{tripId}`                 | `getMarketplaceTrip(tripId)`                      |
| External collaboration list   | `GET`                   | `/api/marketplace/trips/external-collaborations`  | `listMarketplaceExternalCollaborations()`         |
| Trip create/update/delete     | `POST`, `PUT`, `DELETE` | `/api/marketplace/trips*`                         | typed client exists; route implementation follows |
| External collaboration writes | `POST`, `PUT`, `DELETE` | `/api/marketplace/trips/external-collaborations*` | typed client exists; route implementation follows |

## Authorization

All routes are protected and must use `enforceRoutePolicy` at the route
boundary. V5 is creator-workspace scoped, following V3:

- `actor.status = "active"`.
- `selectedOrganization.kind = "creator_workspace"`.
- selected organization and membership are active.
- read routes require `marketplace.trip.read`.
- write routes require `marketplace.trip.manage`.
- the selected organization has exactly one active owner resource link selected
  for this route:
  `product = "marketplace"`, `resource_type = "creator_profile"`,
  `relationship = "owner"`.
- `trips.creator_profile_id` and `external_collaborations.creator_profile_id`
  must match that linked creator profile.
- `organization_id` on target rows must match the selected organization.

Legacy `creators.user_id` and `trips.creator_id` are migration inputs only.
They do not authorize target reads or writes and are not returned by this
contract.

## Target Ownership

The target tables are marketplace-owned:

- `marketplace.trips`
- `marketplace.external_collaborations`

Both tables store `creator_profile_id` and `organization_id`, with foreign keys
back to `marketplace.creator_profiles(id, organization_id)`. This preserves the
creator-workspace resource-link model and prevents cross-workspace trip access.

`tripId` and `externalCollaborationId` are stable UI identifiers. For migrated
rows they use the legacy source IDs where available; target-native rows may use
the target UUID. Internal WorkOS organization IDs, membership IDs, email, and
legacy owner columns are not exposed.

## Response

```ts
type MarketplaceTrip = {
  contractVersion: "marketplace-trips-external.v1";
  authorizationMode: "creator_workspace_resource_link";
  tripId: string;
  creatorProfileId: string;
  organizationId: string;
  sourceTripId: string | null;
  name: string;
  locationText: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
  externalCollaborations: MarketplaceExternalCollaboration[];
  createdAt: string;
  updatedAt: string;
};

type MarketplaceExternalCollaboration = {
  contractVersion: "marketplace-trips-external.v1";
  authorizationMode: "creator_workspace_resource_link";
  externalCollaborationId: string;
  creatorProfileId: string;
  organizationId: string;
  tripId: string | null;
  sourceExternalCollaborationId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: "custom_external" | "paid" | "free_stay" | "affiliate" | "other" | null;
  startDate: string;
  endDate: string;
  deliverablesSummary: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};
```

List responses wrap `items` with `creatorProfileId`, `organizationId`,
`contractVersion`, and `authorizationMode`.

## Write Request Shape

Write routes accept target camelCase fields:

```ts
type CreateMarketplaceTripRequest = {
  name: string;
  locationText?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
};

type CreateMarketplaceExternalCollaborationRequest = {
  tripId?: string | null;
  title: string;
  hotelName?: string | null;
  locationText?: string | null;
  collaborationType?: "custom_external" | "paid" | "free_stay" | "affiliate" | "other" | null;
  startDate: string;
  endDate: string;
  deliverablesSummary?: string | null;
  notes?: string | null;
};
```

Validation rules for the write slice:

- `name` and `title` must contain non-whitespace text.
- `startDate` and `endDate` must be ISO calendar dates.
- `endDate >= startDate`.
- `tripId`, when present on an external collaboration, must belong to the same
  creator profile and organization.
- Unknown collaboration types are rejected instead of silently persisted.

## Errors

```ts
type MarketplaceTripError = {
  statusCode: 401 | 403 | 404 | 409 | 422 | 500;
  code:
    | "unauthorized"
    | "missing_permission"
    | "forbidden"
    | "missing_creator_resource_link"
    | "trip_not_found"
    | "external_collaboration_not_found"
    | "invalid_body"
    | "trip_conflict"
    | "read_model_unavailable"
    | "write_model_unavailable";
  category:
    | "authentication"
    | "authorization"
    | "validation"
    | "not_found"
    | "conflict"
    | "read_model"
    | "write_model";
  message: string;
};
```

## Intentional Differences From Legacy

| Legacy behavior                                                                          | Contract behavior                                                                    | Why                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Authorizes through `users.type` and `creators.user_id`.                                  | Authorizes through creator workspace, permission, and resource link.                 | Aligns V5 with V3 WorkOS organization/resource-link scoping.     |
| Returns snake_case fields and legacy creator IDs.                                        | Typed client exposes camelCase target fields and compatibility maps to old UI types. | Keeps the frontend stable during migration.                      |
| External collaborations use display labels such as `Custom / External`.                  | Target enum uses `custom_external`, `paid`, `free_stay`, `affiliate`, `other`.       | Matches target DDL and avoids display strings as storage values. |
| Trip-linked external collaborations can be fetched without proving trip ownership first. | Target routes enforce creator-profile scope on both trip and external rows.          | Prevents cross-workspace data access.                            |

## Fixtures

`engineering/fixtures/marketplace-trips-external-collaborations/cases.json`
defines the contract cases:

| Case                            | Asserts                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `trips-list-linked-creator`     | Linked creator workspace can read only its trip list and nested external rows. |
| `trip-detail-linked-creator`    | Linked creator workspace can read an owned trip detail.                        |
| `external-list-linked-creator`  | Linked creator workspace can read external collaborations for its profile.     |
| `trips-deny-wrong-org-kind`     | Hotel group cannot use the creator trips route.                                |
| `trips-deny-missing-link`       | Permission without creator-profile resource link is denied.                    |
| `trips-deny-missing-permission` | Resource link without `marketplace.trip.read` is denied.                       |
| `trip-write-validation`         | Follow-up write slice rejects invalid dates and unknown collaboration types.   |

## References

- VAY-799: this contract.
- VAY-737 / `marketplace-route-migration-inventory.md`: V5 scope.
- VAY-797 / `marketplace-creator-self-service-contract.md`: creator workspace
  scoping precedent.
- `workos-identity-architecture.md`: creator workspace organization linkage.
- `target-schema-ownership-map.md`: marketplace table ownership.
- `packages/backend-migration/migrations/0008_marketplace.sql`: backing target
  DDL.
