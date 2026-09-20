# Pricing runtime role and transaction boundary (VAY-1543)

_Review proposal only, 2026-09-20. No application wiring, grants, secrets, or deployment are changed by this document._

## Decision requested

The VAY-1543 owner authority read and public pricing-offer read are blocked on
`next` by PostgreSQL permission errors. Keep activation blocked. Review a
**dedicated pricing execution credential and pool**, selected by the server for
the pricing routes, with every authorization, publication, and quote operation
using **one caller-owned connection and transaction**. Do not add the needed
privileges to the general `TARGET_DATABASE_URL` role.

This is a candidate boundary, **not a grant request yet**. PostgreSQL requires
`UPDATE` privilege for `SELECT ... FOR UPDATE` and `FOR SHARE` ([SQL SELECT
documentation](https://www.postgresql.org/docs/current/sql-select.html)).
That privilege also permits actual writes on **every locked relation**, not
just `identity.organizations`: authority history, PMS rooms, public content,
and Finance evidence are exposed by naive direct grants. Security review must
first decide how a pricing-only executor may hold these locks without gaining
unacceptable cross-domain or cross-property mutation capability.

## Evidence and scope

- The deployed API source is `dda47a35e4c739ca55dd36f8f98c0339d485f033`
  (app PR #2512); platform attestation PR #160 covered its image. The owner
  authority GET and public offers each returned `503 pricing_unavailable` in
  the coordinated synthetic-hotel smoke. No authority or fixture write occurred.
- Read-only RDS logs show `vayada_next_api_runtime` denied
  `identity.organizations` at 10:19:10 and 10:20:33 UTC and
  `booking.pricing_authority_heads` at 10:13:06 and 10:13:10 UTC on 2026-09-20.
  These are direct evidence of missing table privileges, not a complete trace
  linking each line to one request. Do not infer a hotel-data cause.
- `apps/api/src/server.ts` creates `propertySetupOwnerPool` from
  `TARGET_DATABASE_URL` and passes it to the replacement-pricing commands.
  Public pricing and quote adapters also use the general target connection.
  The platform runtime preflight intentionally limits general-role writes; the
  two blocked relations are not approved writes.
- This inventory is for the **bounded VAY-1543 smoke paths**: owner authority
  GET/PUT, public offers GET, and no-payment quote **issue**. Public guest
  disclosure/quote GET, booking creation, quote acceptance, payment execution,
  PMS mutations, and Channex are outside this proposal and must not inherit the
  pricing credential by accident. `createCurrentPricingQuoteStore.read` is not
  wired to that public GET and is not evidence of route coverage.

## Lock and DML inventory

The table records direct SQL in the route call graphs at the deployed source.
`U-lock` means `FOR UPDATE`; `S-lock` means `FOR SHARE`. Both require `UPDATE`
privilege, despite the latter's name. Plain `SELECT` also needs `SELECT`.
Conditional rows require privileges even if the synthetic fixture does not
exercise that branch. Every lock below must remain on the **same connection**
until commit/rollback; moving a helper to a second pool is not equivalent.

| Route/call path                                                                         | Relation(s)                                                                                                                                                                           | Operation needed                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Owner authority GET/PUT: `lockReplacementPricingAuthorization`                          | `identity.organizations`                                                                                                                                                              | U-lock                                             |
| Same                                                                                    | `identity.organization_memberships`, `identity.users`, `hotel_catalog.properties`                                                                                                     | S-lock                                             |
| Same                                                                                    | `identity.organization_resource_links`, `identity.membership_property_assignments` (assigned mode), `identity.role_permission_grants`, `identity.product_entitlements`                | S-lock                                             |
| Owner GET/PUT and all public paths: `lockBookingPricingAuthority`                       | `booking.pricing_authority_heads`, `booking.pricing_authority_revisions`                                                                                                              | S-lock                                             |
| Owner PUT only: `createBookingPricingAuthorityStore.save`                               | `booking.pricing_authority_revisions`                                                                                                                                                 | SELECT (idempotency), INSERT (immutable revision)  |
| Same                                                                                    | `booking.pricing_authority_heads`                                                                                                                                                     | INSERT, UPDATE (compare-and-swap head)             |
| Public offers and quote: `lockPublicPricingAuthority` / `lockCurrentPricingPublication` | `identity.organizations`                                                                                                                                                              | U-lock                                             |
| Same                                                                                    | `identity.organization_resource_links`, `identity.product_entitlements`                                                                                                               | S-lock                                             |
| Same                                                                                    | `hotel_catalog.property_slugs`, `hotel_catalog.properties`, `hotel_catalog.property_locations`, `distribution.public_hotel_bookability_profiles`                                      | S-lock; slug resolution also plain SELECT          |
| Same: current room/terms source                                                         | `pms.room_types`, `booking.pricing_v2_offer_term_heads`                                                                                                                               | S-lock                                             |
| Same: finance source/readiness                                                          | `hotel_catalog.properties`, `finance.payment_provider_accounts`                                                                                                                       | U-lock on source branch; provider account optional |
| Same                                                                                    | `finance.payment_settings`, `finance.online_card_execution_evidence` (optional)                                                                                                       | S-lock                                             |
| Same: fixed-charge policy                                                               | `hotel_catalog.properties`                                                                                                                                                            | U-lock                                             |
| Same                                                                                    | `booking.fixed_charge_heads`, `booking.fixed_charge_revisions`                                                                                                                        | S-lock                                             |
| Public offers GET only: published content                                               | `distribution.active_public_booking_revision`, `distribution.public_booking_content_revisions`                                                                                        | S-lock                                             |
| Quote issue: `lockCurrentPricingQuote`                                                  | `booking.booking_settings`                                                                                                                                                            | S-lock                                             |
| Quote issue: addon, last-minute, promo components                                       | `hotel_catalog.properties`, `booking.promo_definitions` (when code supplied)                                                                                                          | U-lock                                             |
| Same                                                                                    | `booking.addon_definitions`, `booking.booking_settings`, `hotel_catalog.property_locations`, `booking.room_last_minute_heads`, `booking.room_last_minute_revisions`, `pms.room_types` | S-lock                                             |
| Quote issue: `createCurrentPricingQuoteStore`                                           | `booking.pricing_quotes`                                                                                                                                                              | SELECT (idempotency), INSERT                       |

Additional **plain SELECT** relations on these paths include
`pms.pricing_v2_heads`, `pms.pricing_v2_revisions`, `pms.pricing_v2_rooms`,
`pms.pricing_v2_charge_declarations`, `pms.room_types`,
`booking.pricing_v2_offer_terms`, `hotel_catalog.property_slugs`,
`finance.online_card_readiness` (card branch), and `pms.room_type_closures`
(public room eligibility). Verify this list against the eventual target
source; it is not a blanket grant for every table in those schemas. Advisory
transaction locks used by the PMS pricing helpers do not themselves require
table `UPDATE` rights.

The quote is “no-payment,” **not read-only**: successful issue inserts one
`booking.pricing_quotes` row, but does not create a guest booking or payment.
The operator must approve that bounded quote write and idempotency behavior
before smoke. All other pricing mutators beyond authority selection remain
outside this credential proposal until their own route inventories are reviewed.

## Proposed boundary and unresolved write escalation

1. Define a pricing-specific runtime role and separately named secret/pool.
   The server, not a request field or tenant identifier, chooses it only for
   explicitly enumerated pricing handlers. Never fall back to the owner or
   migration URL. Keep `TARGET_DATABASE_URL` and the VAY-2038
   `AUTH_DATABASE_URL` role unchanged. Do not reuse the identity role as the
   pricing credential.
2. Derive exact schema usage, SELECT, and intentional-write rights from the
   inventory, but **do not grant UPDATE merely to satisfy row locking**. That
   would permit direct mutation of every locked authorization, financial,
   public, and pricing-evidence table. Even column-scoped UPDATE is a write
   grant; table ACLs alone cannot confine writes to the current property. No
   owner membership, BYPASSRLS, CREATE, DELETE, broad schema DML, or arbitrary
   `SECURITY DEFINER` execution. Encode the final allowlist and its inverse in
   the platform runtime preflight before provisioning.
3. Resolve **all** row-lock-to-write escalations before any grant. The current
   `identity.organizations FOR UPDATE` additionally serializes FK-backed
   entitlement inserts. An audited, narrowly scoped lock-only database
   capability might avoid direct UPDATE grants, but it would require separate
   threat review, explicit preflight exception, and proof that it cannot
   mutate protected rows, return privileged data, or accept forgeable client
   identity claims. The intentional authority-head and quote writes also need
   property-scope enforcement or an explicitly reviewed risk decision. A
   shared advisory-lock protocol would require all competing writers to
   participate and is not presently a drop-in substitute. Until these
   mechanisms are reviewed, this design is **no-go**.
4. Preserve the existing caller-owned `READ COMMITTED` transaction and
   idempotent authority revision/head update. Authorization checks, org and
   publication locks, current-source reads, quote calculation, and quote
   insertion must use the same `PoolClient`. No cross-role query mid-transaction
   and no client-supplied `SET ROLE`. Keep the public fail-closed behavior.

This boundary is distinct from VAY-2038's identity-runtime proposal (app PR
#2520), which isolates staff-login identity writes. That proposal does not
authorize the general product role to lock booking pricing rows; the two
designs need coordinated review of shared `identity.*` access and secrets.

## Required proof before deployment

- PostgreSQL integration tests with **separate actual test roles**, not owner
  credentials: enumerate all successful allowed lock/read/write paths for
  owner GET/PUT, public offers, and quote issue in one transaction. Include
  empty authority head, assigned membership, optional finance evidence,
  fixed-charge policy, promo-code branch, revoked/suspended entitlement,
  stale expected revision, and idempotent replay.
- Negative ACL tests: snapshot the general role's **existing** shared-table
  grants and prove it gains no new pricing/identity privileges; do not revoke
  capabilities already used by unrelated routes (for example,
  `hotel_catalog.properties`). The only intended pricing writes here are
  `INSERT` on `booking.pricing_authority_revisions`, `INSERT`/`UPDATE` on
  `booking.pricing_authority_heads`, and `INSERT` on `booking.pricing_quotes`,
  all scoped to the authorized property. Deny direct writes to every other
  protected locked relation (including Identity, Finance, PMS, and
  Distribution), `UPDATE`/`DELETE` on revisions or quotes, `DELETE` on heads,
  cross-property writes, and unreviewed definer execution. A successful
  `FOR SHARE` test alone does not prove this boundary: attempt direct UPDATE
  on every locked table. If grants cannot enforce these denials, redesign the
  lock/write mechanism rather than treating a dedicated pool as sufficient
  isolation.
- Concurrency tests retain the existing reader-versus-writer blocking and
  stale/revocation behavior (`bookingPricingAuthority.integration.test.ts`).
  Test transaction rollback on every denial/error and no leaked privileged
  connection on ordinary routes. A route test must demonstrate that swapping
  to the general pool fails closed, not silently succeeds on owner credentials.
- Platform preflight and deployment attestation verify the **exact** secret
  parameter-to-role mapping, allowed and denied table/function privileges,
  running task definition, image digest, and source ancestry. Coordinate with
  VAY-2029 and VAY-2038 before using the shared synthetic fixture. Only then
  perform one owner authority read, explicit Vayada selection if unconfigured
  (expected revision and idempotency key), bounded public offers, and one
  no-payment quote. No reservation or payment.

## Rejected shortcuts and rollback

- Broad UPDATE grants on `TARGET_DATABASE_URL` would let every general API
  handler mutate sensitive identity/pricing rows; fail least-privilege review.
- Removing `FOR SHARE`/`FOR UPDATE` or splitting calls across pools loses the
  existing revocation, FK-serialization, and compare-and-swap guarantees.
- A naive definer function that trusts app-supplied WorkOS claims or a return
  to an owner database URL crosses the same trust boundary by another path.
- If reviewed rollout fails, stop pricing-route traffic and return to the
  previously attested task definition/image and secret mapping through the
  normal coordinated release process. Revoke the dedicated role's **new**
  grants/secret only under a reviewed platform rollback; preserve the shared
  synthetic hotel and all quote/authority evidence for investigation. Do not
  bypass deployment guards or activate production pricing while the smoke is
  blocked.

Approval required from app, platform/database security, VAY-2038 identity,
and VAY-2029 release owners before an implementation or grant PR. VAY-1543
stays In Progress until deployed acceptance and explicit human completion.
