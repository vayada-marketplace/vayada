# Hotel setup profile-edit writer (VAY-965)

Status: implementation contract; no production grant, credential or caller change.
Predecessors: [credential lifecycle](hotel-setup-command-credential-lifecycle.md),
[launch settings](hotel-setup-launch-settings-command.md) and [logo](hotel-setup-logo-writer.md).

## Observed failure

An original Owner who deliberately edits shared hotel facts receives HTTP 500 from
`PUT /api/hotel-setup/properties/:propertyId/profile`: PostgreSQL 42501 on
`hotel_catalog.properties` through the intentionally restricted ordinary API login.
Logo-only Save already sends no profile PUT. This contract does not widen the
ordinary login and does not reuse the logo, launch-settings or creation credentials.

## Fields and semantics

Keep the public URL, request (`expectedProfileRevision` + `patch`), validation and
response unchanged. The intended fields are the canonical profile: hotel name,
property type, street/house number, postal code, city, country, timezone, the
explicit location consent flags/coordinates, and the hotel contacts (contact email,
reception phone, optional website, and other listed channels). The shared parser
merges the patch into the current canonical profile; omitted fields are preserved.
Persistence is the existing shared writer's contract: one profile revision increment,
location upsert, platform-contact replacement and the existing catalog/Marketplace
read-model projection. Booking settings, social launch contacts, descriptions,
media, policies, products and entitlements are never touched.

Every contact carries an explicit `isPublic`; the server never derives contacts from
the account email/phone. Unchanged contacts and location consent are preserved.
A changed public surface still requires publication permission at the route.
An input contact matching one the profile does not show (another product's private
contact or social) is refused with `private_contact_conflict` before any write, as
the launch-settings and booking writers do; it is never published or re-owned.

## Execution and authority

The public route checks setup access, then forwards only the original bearer, the
documented body and the required `Idempotency-Key` to the property-command service
(`HOTEL_SETUP_PROFILE_COMMAND_*`; unset keeps the ordinary pre-cutover writer,
`blocked` returns 503). There is no local-write fallback once admission is set.

The private handler verifies the original WorkOS session, hotel-group context,
`hotel_owner`, `hotel_catalog.setup.manage` and the active canonical Owner link,
then selects the server-owned `property_profile` assignment bound to the exact
property, organization and actor. Its login (`vayada_next_hotel_setup_profile_*`)
has **no table privileges**. It may only execute fixed security-definer functions:

- `hotel_setup_property_profile_snapshot(property, organization, actor)`
- `hotel_setup_update_property_profile(property, organization, actor, revision,
profile, key hash, fingerprint hash, correlation)`
- `hotel_setup_profile_allowed` / `hotel_setup_profile_bootstrap_proof_allowed`
  (credential proofs only).

Each call re-locks the organization, assignment, membership, role definition,
grants, actor and Owner link and requires the original Owner shape (`hotel_owner`,
no overrides, account-admin preset) with `hotel_catalog.setup.manage` and
`marketplace.profile.manage`. Revocation denies first attempts and replays.
Authority denials raise the dedicated SQLSTATE `HSP03` (relayed as 403); any other
error, including a missing grant or policy (42501), is relayed as 503.

### Who can edit once admission is enabled

Admission is one switch, but credentials are per property and per Owner actor, and
are provisioned by the protected manual bootstrap. With the caller enabled:

- Only the bound original Owner can save profile edits, from every caller (setup
  wizard, Marketplace and PMS editors, nearby editor). Managers and other non-Owner
  members who could use the ordinary writer get `403 owner_session_required`. This
  is a product decision to confirm before enabling.
- A property or Owner without a ready `property_profile` assignment (new hotels,
  co-Owners, an ownership transfer) gets a non-retryable
  `409 profile_edit_not_provisioned`, with copy that asks the Owner to contact
  support. Clients must not retry it.
- Automatic provisioning deliberately refuses actor-bound purposes. Provisioning
  for new properties and Owner changes is a **follow-up**: either extend the
  reviewed automatic reconciler to `property_profile` for the property's current
  Owner, or rebind the purpose to the property. Until then, enable admission only
  after every property that needs editing has been bootstrapped.

## Atomicity, idempotency and audit

One transaction: authority, snapshot, shared parse, then write. The writer replays
a completed key with an identical request fingerprint without writing; a different
fingerprint is an idempotency conflict. A stale `expectedProfileRevision` returns a
revision conflict before any write. A successful write records exactly one
`platform.idempotency_keys` row and one linked `property_profile_updated` audit
event (actor, organization, property, revision and changed field names; no values).
Any failure rolls back the profile, location, contacts, projections, key and audit.

## Required proof

- PostgreSQL 16/17 exact grants: authorized edit persists and projects; stale
  revision, revoked Owner, foreign organization/property/actor deny; replay creates
  no second revision, key or audit; contact privacy and consent stay explicit; the
  native login and the ordinary identity cannot UPDATE the catalog tables directly.
- Route/unit tests for forwarding, owner-session checks, idempotency and failures.
- Browser: edit, Save, full reload shows persisted values; logo-only Save sends no
  profile PUT.

## Release order

**Merge gate:** merging the DB slice into `main` is itself a release, because public
API startup applies 0470–0472. Do not merge it until step 1 has run against the final
0470 bytes (sha256 `065464209d9d0f32bb20465c3f511bf7feb7a15199617a2d7ad06c135334e536`).
The API hold must still capture the serving task.

1. Pre-stage the NOLOGIN parent `vayada_next_hotel_setup_profile_scope` exactly like
   the logo parent (platform `hotel-setup-migration-scope.yml`, add `scope=profile_0470`
   pinned to the 0470 bytes above): the production migration owner cannot create roles,
   so `vayada_admin` (NOSUPERUSER CREATEROLE) creates it. That yields its creator edge
   (ADMIN=true, INHERIT=false, SET=false, superuser grantor), which credential staging
   needs to grant the parent. 0470 then skips `CREATE ROLE` and only checks the posture.
   Without this step, startup fails with the same `CREATE ROLE` permission error 0466
   hit.
2. Apply 0470–0472 through normal public API startup (no login or grant is created).
3. Build the private primary, the rollback and the bootstrap pair from the final
   reviewed source (no earlier than the review-fix head, because the native definition
   pin changed). Register the pair in `engineering/hotel-setup-bootstrap-images.json`.
   Then deploy the private property-service primary. An image from an earlier head
   fails the profile attestation: as the secondary proof it blocks bootstrap, and as a
   rollback every save returns 503.
4. Protected bootstrap of the `property_profile` credential per original property
   with its exact Owner actor (RDS-compatible actor flow); publish the immutable
   secret version. Grant the profile secret prefix to the property task's secret
   read and to the bootstrap role first.
5. Deploy the web apps that send `Idempotency-Key` on profile edits (Marketplace,
   PMS and the onboarding surfaces) **before** enabling admission. Older bundles
   get `400 invalid_request` from the forwarder.
6. Deploy the public API, then set `HOTEL_SETUP_PROFILE_COMMAND_ADMISSION=enabled`
   with the property-service origin/token. Rolling the private service back to an
   image without this route requires `blocked` first.
7. Original Owner edit → Save → reload for both properties.
