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

1. Apply the migration (no login or grant is created).
2. Deploy private property-service primary and a compatible rollback that both
   contain this purpose (the bootstrap's secondary proof requires it).
3. Protected bootstrap of the `property_profile` credential per original property
   with its exact Owner actor; publish the immutable secret version.
4. Deploy the public API, then set `HOTEL_SETUP_PROFILE_COMMAND_ADMISSION=enabled`
   with the property-service origin/token. Rolling the private service back to an
   image without this route requires `blocked` first.
5. Original Owner edit → Save → reload for both properties.
