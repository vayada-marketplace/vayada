# Hotel setup launch-settings command (VAY-965)

Status: proposed implementation contract; no production grant or cutover authorization.
Predecessor: composed source `3eeac573b0562f567833b2acafacd5df9c1d625d` and
[credential lifecycle](hotel-setup-command-credential-lifecycle.md).

## Observed Save path

`SharedFirstRunPropertySetupWizard` creates or updates the profile, saves an
optional logo, PUTs launch settings, reloads status, and selects the property.
Marketplace supplies the launch-settings adapter. Its PUT currently uses the
ordinary booking settings writer, which also updates profile revision, rewrites
policy summaries and guest-form flags, and synchronizes offer read models.
These extra writes are unnecessary for this eight-field request. This code trace
does not establish the exact failing production SQL or either account's health.

## Boundary

Keep the public PUT `/api/hotel-setup/properties/:propertyId/launch-settings` and
its response and validation. Forward only this validated command to the separate
property-command service using `HOTEL_SETUP_COMMAND_ORIGIN` and its token.
The creation-only service must still register only POST `/properties`.
Forward the original WorkOS bearer; reject injected context, query parameters,
invalid property IDs and unknown fields. The private handler independently
requires the current owner session, setup permission and property linkage.
No local-write fallback when forwarding is enabled or the executor is unavailable.

Use a distinct `launch_settings` native property assignment and login under the
existing property-command secret prefix. Do not add booking privileges to
`currency_ready`, `feature_hub`, the creation login, or the ordinary API login.
Reuse native credential resolution, verified TLS, role posture and transaction
scope checks. Extend their explicit operation allowlists and exact preflight
inventories; assignment selection remains server-owned. Before any write, lock
and recheck the active assignment, organization and current ownership in the same
transaction. Revocation must deny retries as well as first attempts.

## Persistence

The command accepts only `defaultCurrency`, `supportedCurrencies`,
`defaultLanguage`, `supportedLanguages`, `instagram`, `facebook`, `tiktok`,
and `youtube`. Reuse the existing parser and shared response conversion.
Write only the four corresponding booking settings columns and the four social
contact types. Preserve email, phone, WhatsApp, policies, guest-form flags,
profile revision, other products and entitlement state. Existing private-contact
publication conflict semantics remain; never expose a private contact merely
because its URL matches. Keep public-profile/read-model synchronization required
by existing readers, with its exact write set reviewed before granting access.
Repeated identical PUTs must preserve unrelated values and have no activation
side effects. Transaction failure rolls back all settings and projection writes.
Return saved values from the same scoped operation, not an unscoped writer.
Record a transactional audit receipt for the verified actor, organization,
property and `launch_settings` operation, with sanitized metadata. Native guards
must reject forged actor/property receipts; receipt failure rolls back the save.

Booking display currency is not PMS pricing currency. This PUT must not activate
Financials or overwrite established PMS pricing. The subsequent native first
pricing-currency command retains its existing idempotency and completion rules.

## Required proof and release order

1. Review the narrow SQL/projection write inventory, native RLS operation and
   migration contract before adapters or grants. Attest affected catalog hashes
   independently on PostgreSQL 16 and 17; preserve the final 0461 guard.
2. Test missing/invalid auth, non-owner, missing permission/link, inactive or
   wrong-purpose assignment, wrong property/organization, revoked ownership,
   and private contact conflict. Native login direct SQL must deny out-of-scope
   rows, non-social contacts, policy/guest-form edits, forged audit receipts and
   product activation.
3. Exercise the real wizard sequence: create, optional logo, settings, status
   reload and property selection; retry after settings failure without another
   property. Prove subsequent native first currency creates seven starter
   categories and Financials once, preserving Owner-off and global restrictions.
4. Coordinate composed-source images and rollback, separate service credentials,
   reader assignment visibility, exact IAM, clean Terraform plan and normal CI
   release. Neither immutable creation candidate currently proves this command.
5. Confirm authenticated live Save and status for both reported accounts before
   reporting recovery. Keep VAY-965 In Progress until accepted live completion.

## Release admission hold

The public API can set `HOTEL_SETUP_COMMAND_ADMISSION=blocked` before initial
property credential bootstrap or rollback. The existing shared forwarder then
rejects all property commands with uncached 503 without transport or ordinary
writes. Creation has its separate `HOTEL_SETUP_CREATION_COMMAND_ADMISSION`.
`enabled` requires a valid private origin/token pair; unknown states fail startup.
Unset retains the existing pre-cutover behavior. Keep origin/token configuration
when blocking an already-enabled caller. Only the reviewed release removes the
hold after private-service and credential proof; setting it does not prove recovery.

## Manual native property bootstrap (VAY-1092)

The protected operational image invokes `/app/apps/api/dist/cli/hotelSetupPropertyBootstrap.js`.
Its separately reviewed rollback app and dependencies are fixed at `/proof/rollback`; arbitrary module roots are rejected.
The protected release driver must prove exclusive ownership, public admission blocked, and the private property service desired/running/pending all zero through proof and publication.

Inputs are `HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL`, `HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT`,
`HOTEL_SETUP_COMMAND_PROPERTY_ID`, `HOTEL_SETUP_COMMAND_ORGANIZATION_ID`,
`HOTEL_SETUP_COMMAND_ACTOR_USER_ID`, and `HOTEL_SETUP_COMMAND_OPERATION` (one of the four reviewed purposes).
The driver privately validates and normalizes the production owner URL to the target database with sole `sslmode=verify-full` before invocation.
Prepare the pinned CA via `NODE_EXTRA_CA_CERTS` before starting Node; there is no insecure fallback.

The CLI creates a disabled role, generates a private password, activates only the exact staged identity,
proves primary and rollback native credentials, then publishes one immutable property-purpose secret version.
Publication uses official regional SDK endpoints and one captured AWS credential identity; account verification precedes writes.
Only nonsecret identity/scope and `publication.secretArn/versionId` appear in the single success receipt.
Failure emits a sanitized inspection-required code. Never blindly retry, overwrite, or adopt a partial role/assignment/secret.
The synthetic fixed-root script `scripts/test-hotel-setup-property-bootstrap.mjs` is restricted to an owned loopback test database; its AWS preload is test-only and must never be included in the operational image.
