# Marketplace Admin Contract

Marketplace vertical **V7** migrates the marketplace-owned admin surfaces from
the legacy marketplace API to typed TypeScript backend routes consumed by
`apps/vayada-admin`.

Contract version: `marketplace-admin.v1`.

## Routes

| Surface                    | Method   | Path                                                              |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| Admin collaboration list   | `GET`    | `/api/marketplace/admin/collaborations`                           |
| Respond as hotel           | `POST`   | `/api/marketplace/admin/collaborations/{collaborationId}/respond` |
| Approve as hotel           | `POST`   | `/api/marketplace/admin/collaborations/{collaborationId}/approve` |
| Create hotel-user listing  | `POST`   | `/api/marketplace/admin/users/{hotelUserId}/listings`             |
| Update hotel-user listing  | `PUT`    | `/api/marketplace/admin/users/{hotelUserId}/listings/{listingId}` |
| Archive hotel-user listing | `DELETE` | `/api/marketplace/admin/users/{hotelUserId}/listings/{listingId}` |

## Authorization

Primary authorization is platform organization membership:

```text
permission: platform.user.suspend
resource: platform/platform/vayada
relationship: operator
```

During WorkOS/platform backfill, the routes may fall back to the legacy
`users.is_superadmin` flag after a valid authenticated `RequestContext` is
resolved. This fallback is intentionally narrow to these marketplace admin
compatibility routes and must not be treated as a permanent authorization
primitive.

## Scope Boundaries

This contract only covers marketplace-owned resources:

- collaboration review actions that act as the hotel side;
- hotel listing create/update/archive for a hotel user.

Identity user CRUD remains out of scope and stays on the identity admin command
surface. Do not port legacy `admin/users.py` user CRUD as part of V7.

## Response Shape

Collaboration responses reuse the V4 collaboration read/lifecycle shapes and add
admin lifecycle timestamps (`hotelAgreedAt`, `creatorAgreedAt`, `completedAt`,
`cancelledAt`) needed by `vayada-admin`.

Listing writes reuse the V2 hotel listing request shape:
`title`, `listingSummary`, `accommodationType`, `rawLocationText`, `imageUrls`,
`collaborationOfferings`, and `creatorRequirements`.

## Fixtures

Representative cases live in
[`fixtures/marketplace-admin/cases.json`](fixtures/marketplace-admin/cases.json).
