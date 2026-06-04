# RequestContext contract

_VAY-608 contract record. Builds on VAY-600, VAY-602, VAY-603, VAY-605, and
VAY-607._

## Purpose

Every authenticated TypeScript backend route should receive a resolved
`RequestContext` before domain code runs. The context is the boundary between
provider authentication, Vayada authorization, and domain services.

The contract lives in `apps/api/src/platform/requestContext.ts` until the backend
package split in VAY-611 moves it into a shared backend authorization or test
package. Fixture cases live in
`apps/api/src/platform/requestContext.fixtures.ts` and are checked by
`apps/api/src/platform/requestContext.test.ts`.

## Resolution Chain

New authenticated routes should resolve context in this order:

```text
provider identity
-> internal user
-> selected organization
-> active membership
-> permissions
-> linked product resource
-> entitlements and resource state
-> audit metadata
```

WorkOS owns provider identity, session state, and provider organization
membership. Vayada owns internal users, organizations, product authorization,
resource links, entitlements, and product audit.

## Contract Shape

`RequestContext` contains:

- `actor`: internal Vayada user plus provider identity.
- `selectedOrganization`: one active internal organization for this request.
- `membership`: the active membership, role key, WorkOS role slugs, and resolved
  Vayada permission keys.
- `linkedResources`: product resources the selected organization can act on,
  such as booking hotels, PMS hotels, marketplace profiles/listings, creator
  profiles, affiliates, and payout accounts.
- `entitlements`: active or suspended product/module access.
- `locale` and `currency`: request presentation defaults for domain logic.
- `audit`: request ID, source, timestamp, and optional correlation metadata.

Domain code should consume this context rather than reading provider tokens,
cookies, legacy JWT claims, `X-Hotel-Id`, `users.type`, or `is_superadmin`.

## No Legacy Authorization Boundary

The TypeScript backend rewrite should not preserve legacy authorization inputs
as part of its route or domain contract. New `apps/api` authenticated routes
should require a resolved WorkOS-backed provider identity, internal user,
selected organization, active membership, permissions, linked resources,
entitlements, and audit metadata.

These inputs are deliberately not represented in `RequestContext`:

- `X-Hotel-Id`
- `users.type`
- `users.is_superadmin`
- direct product `user_id` ownership
- legacy local JWT claims as authorization state

If an old frontend or Python/FastAPI surface still depends on one of those
inputs, that behavior should remain outside the new TypeScript backend contract
until the surface is migrated to explicit organization/resource selection. Do
not add temporary `apps/api` routes whose authorization depends on those inputs.

## Fixture Coverage

The current fixture set covers allowed and denied cases for:

- hotel scope: booking/PMS hotel resources through hotel-group membership;
- creator scope: marketplace creator profile access without implicit hotel
  listing authority;
- affiliate scope: affiliate resource access without implicit hotel finance
  authority;
- platform scope: platform admin actions without implicit hotel ownership.

These fixtures intentionally require both a permission and an active resource
link for allowed access. A role or permission alone does not authorize a product
resource, and a resource link alone does not authorize an action.

## Future Route Usage

Authenticated route slices should:

1. Resolve `RequestContext` before calling domain services.
2. Pass `RequestContext` or a narrowed domain-specific context into application
   services.
3. Reject requests that cannot resolve selected organization, membership,
   permission, and linked resource context.
4. Add contract fixtures before adding a new scope, permission family, or
   resource type.
5. Record audit metadata from the context for mutating or sensitive reads.

Do not add product route behavior that depends directly on `users.type`,
`is_superadmin`, direct product `user_id` ownership, or hidden `X-Hotel-Id`
state.
