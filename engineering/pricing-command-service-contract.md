# VAY-1543: private pricing command service

Reviewable integration contract, 2026-09-21, source `13fe24d76`.
Supersedes the open broker-versus-capability options in
`pricing-property-boundary-proof.md`: propose a **private command service with
native property-bound PostgreSQL logins**, not a generic connection broker.
The user's approved database-protection plan authorizes this preparation.
No production service, grants, credentials, or API routing are implemented here.

## Boundary and fixed commands

The ordinary API is a transport caller, not the authority that mints pricing
scope. A separately isolated service verifies original WorkOS bearer tokens and
runs complete existing pricing commands. It never returns credentials, SQL
connections, arbitrary-query access, or a reusable privileged execution handle.
An in-process helper or second pool in the ordinary API is not this boundary.

The private service—including its verifier, authorization checks and credential
selector—is the trusted computing boundary. It holds the admitted credentials.
This protects against ordinary-API scope forgery and wrong-property SQL on an
already selected connection. It does not protect against compromise of the
private service or a credential-selection defect inside that service. Database
policies do not replace the service's admission and selector tests.

Proposed private operations (versioned internal URLs, not new public APIs):

| Operation                                        | Inputs accepted                                                                                        | Existing implementation to reuse                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /v1/owner/properties/:propertyId/authority` | Original bearer only; property UUID is a requested resource, not authorization                         | `createBookingPricingAuthorityStore.read` in `apps/api/src/domains/bookingPricingAuthority.ts` |
| `PUT /v1/owner/properties/:propertyId/authority` | Original bearer, one idempotency key, exact `{expectedRevision, authority}`                            | Same store's `save`; preserve current hash, revision CAS and replay semantics                  |
| `GET /v1/public/hotels/:slug/offers`             | Canonical slug only                                                                                    | `createPublicPricingOfferCatalog.read` in `apps/api/src/domains/publicPricingOfferCatalog.ts`  |
| `POST /v1/public/hotels/:slug/quotes`            | Slug, existing quote request DTO and idempotency key; initial admission permits `pay_at_property` only | `createReplacementBookingQuoteIssuer` and `createCurrentPricingQuoteStore.issue`               |

Reject unknown keys, arbitrary operation names, organization/user/membership
claims, role/connection selectors, serialized `RequestContext`, caller property
scope for public operations, SQL, and callback URLs. Keep existing body/key
limits and parsers; avoid a generic `execute(operation, payload)` endpoint.
Quote issuance writes evidence but never accepts a quote or creates a booking,
payment, inventory hold, provider write, or pricing publication.

The API integration changes only these current callsites:

- `apps/api/src/routes/replacementPricing.ts`: authority GET/PUT currently use
  `enforceRoutePolicy` and `createReplacementPricingCommands`. Retain outward
  policy and request validation, forward the original bearer, and move these
  two execution calls to the private service. Other replacement-pricing
  operations keep their existing routing and credentials.
- `apps/api/src/routes/bookingWebPublic.ts`: replace only `getPricingOffers` and
  `quoteBooking` execution, now backed by `pricingPool` at lines 1451–1456.
  Keep acceptance, payments, addons and guest disclosure outside this service.
- `apps/api/src/server.ts`: remove use of the shared pricing credential for
  those four handlers after cutover. Missing private-service configuration or
  unavailable service returns the existing unavailable response; never fall
  back to general, auth, owner or migration credentials.

## Independent authentication and admission

The service uses the existing `createWorkOSVerifier` from
`packages/backend-auth/src/verify.ts` with fixed deployment configuration for
JWKS URL, issuer and client ID. Signature/expiry and expected client checks run
inside the service. Neither those verifier settings nor a verified-session
object may arrive from the ordinary API. Require a non-empty signed session ID
and organization claim for owner commands. Bearer tokens are not logged.

Reuse `resolveRequestContext` with the service's own identity repository and
authorization resolver. It resolves provider IDs to internal actor and selected
organization; do not trust body IDs or forwarded role/permission headers.
Before selecting a property login, enforce the same permission, resource link
and entitlement policy as `replacementPricing.ts`: read requires
`pms.rooms_rates.read`, manage requires `pms.rooms_rates.manage`, active
hotel-group membership, active owner/operator property link and PMS entitlement.
This admission read does not grant a durable right to execute after revocation.

The private service then chooses a preprovisioned, allowlisted property login.
The ordinary API cannot access that registry or ask for a login directly.
For owner commands, the store repeats `lockReplacementPricingAuthorization`
inside the eventual transaction, including current user/membership, assignment,
permission overrides, property links and scoped suspension checks. Thus a
membership revoked between admission and transaction fails closed.

Public commands do not get an owner login, even if an Authorization header is
present. A read-only discovery query maps the canonical slug to a candidate
allowlisted property; it establishes no access. `lockPublicPricingAuthority`
must re-resolve under its current inventory/identity/publication locks and
match the selected login's DB-owned property/organization assignment. A moved
slug, owner transfer, stale/unpublished profile or mismatch returns unavailable;
never retry on another role or silently rebind the assignment.

## Transaction and database contract

Each command owns one `PoolClient` from beginning through commit/rollback;
source reads and authorization stay on that connection. Reuse the existing
store transaction boundaries. No transaction spans an HTTP exchange, and no
socket/PoolClient is serialized back to the API. Preserve inventory advisory
lock → organization lock → existing row-lock order; add no earlier conflicting
lock. A timeout or caller disconnect rolls back active work; an uncertain
committed PUT/quote is recovered only with its original idempotency key.

Provision separate native logins for each initially admitted property and class:

- Owner-read: locked reads only; no intentional INSERT/UPDATE.
- Owner-manage: INSERT authority revisions/heads, UPDATE **only head revision**.
- Public: locked public-source reads and INSERT quotes; no authority writes.

All are non-owner, NOINHERIT, NOBYPASSRLS, without role membership, CREATE,
TRUNCATE, DELETE, credential-registry writes or unreviewed definer execution.
The DB-owned assignment binds `session_user` to property and organization;
callers cannot change it. Restrictive policies enforce both columns on quote
and revision inserts. Head writes must additionally bind the referenced
revision's organization; the old/new property cannot change because column
UPDATE is limited to revision. Actor attribution is still obtained from the
service's independently verified context: **this proof does not enforce actor
identity in the database**, and that limitation must be reviewed explicitly.

Every other UPDATE right needed for locking must have a proven restrictive
write denial. Reuse the complete relation inventory in
`pricing-runtime-role-boundary.md`; test its real joins and triggers, not just
one example. Keep unrelated existing database roles and their behavior intact.
Do not grant this policy to a common role that can SET ROLE into another scope.

## Exact missing provisioning boundary

Propose one separately deployed private ECS service, initially admitting only
the existing reusable synthetic property. It has no public ingress, receives
only the fixed commands from the API, and has its own task/execution IAM roles.
Only its execution configuration can obtain its exact property-role secrets;
the API task role, execution configuration and container environment must not
obtain them. No shared writable volumes, debug shell, migration/owner credential
or broad Secrets Manager/SSM access. Use authenticated encrypted internal
transport; network placement alone does not replace independent owner auth.

This topology does not exist in the reviewed app changes. Platform must supply
the private listener/discovery and caller authentication, restricted secret
mapping, bounded pools/timeouts and identity/public discovery read credentials.
The service also needs the reviewed lock-only grants/RLS and operation-role
preflight before any request is enabled. The API and service must not share
privileged pricing secrets under different variable names.

VAY-2029 currently coordinates **six** services. This additional service needs
an explicitly reviewed serialized deployment/rollback path and compatible API
cutover; it cannot be silently added to the six-image manifest. Initial scope
is one synthetic property, not automatic per-hotel credential provisioning.
Provisioning more properties or credential rotation needs a separate reviewed
lifecycle that invalidates stale organization assignments after ownership change.

## Bounded validation and next implementation slice

The executable local proof now uses separate owner and public PostgreSQL logins.
It passes own-property writes, same-organization cross-property rejection,
wrong-organization quote rejection, public-to-owner write/SET ROLE denial,
owner-to-quote denial, head reparent denial, retained public row locking,
rollback and assignment revocation on the real migrated schema. It is **not**
an HTTP/service-auth test or full production ACL attestation.

Next app slice: move these fixed command adapters into an isolated service
entry point without importing `server.ts` or starting unrelated workers.
Reuse the existing verifier/resolver/policy/store modules, not reimplementations.
Its local admission tests must reject forged/expired/wrong-client tokens,
forged context headers, wrong property, read-only staff attempting manage,
revoked membership after admission, public-to-owner escalation and moved slug.
Actual-role PostgreSQL 16/17 integration must cover replay, CAS, source changes,
lock blocking, immutable evidence and every denied relation/optional branch.

Only after those slices and platform isolation are reviewed should API proxy
wiring be enabled. Review the concrete topology rather than installing unused
transport wrappers in today's API. The current pricing rollout remains blocked;
this contract authorizes no live provisioning or deployment by itself.
