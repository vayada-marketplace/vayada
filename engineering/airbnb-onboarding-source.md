# Airbnb onboarding source — first adapter slice

VAY-1009 follow-up to [shared hotel import](shared-hotel-import-contract.md).
Design checked against [Channex's Airbnb API guide](https://docs.channex.io/channel-api-examples/airbnb)
on 2026-09-10. This slice adds an unmounted server adapter, not an OAuth route.

## Connection and ownership boundary

The documented flow generates a link through `POST /api/v1/meta/airbnb/connection_link`.
The owner authorizes on Airbnb; Channex creates an inactive connection. Success
returns `channel_id` and the caller's `token` to the configured redirect. A browser
query parameter is not proof of access. Future routes must persist a short-lived,
single-use state bound to the authenticated actor, organization and selected
canonical property, then verify the returned channel against the expected Channex
group/property. Failure callbacks must also correlate to the initiating session.

New hotels should use Vayada's authorized provisioning lifecycle; they need not
supply their own Channex credentials. Existing external-property adoption remains
subject to [its separate proof contract](channex-property-adoption-proof-contract.md).
Never discover a tenant binding by matching a hotel name or using a platform key.

The adapter accepts server-resolved Channex IDs and a server-held key. Before
listing access it reads the channel and requires the expected group, exact single
property and Airbnb adapter. Multi-property channels fail closed in this first
slice. These checks supplement, and do not replace, authenticated tenant access.
No API route or browser call may expose the adapter before that access is implemented.

## Read and review

`GET /api/v1/channels/{channel_id}/action/listings` returns
`data.listing_id_dictionary.values` with listing `id`, `title`, and `occupancies`.
The documented occupancy array contains every count from one through capacity.
Only a complete, unique sequence establishes `maxGuests`; otherwise it stays null.
Adult/child limits, beds, bathrooms, size and description remain unknown in this
slice. Listing details are a separate endpoint whose content fields need their
own reviewed normalization. No stock, price, availability or publication is inferred.

Listing suggestions use stable `abb_` IDs and the existing bounded prepared-import
parser. More than 50 listings, duplicate IDs and invalid required fields fail
explicitly. The source represents the connected account's listings, not proof that
every listing belongs to the selected hotel; the owner must choose the relevant ones.

The existing invitation repository cannot store this source by pretending the
connection is an invitation. A later source repository must durably bind the
connection/listing revision to the authorized destination and preserve replay keys.
The shared review UI and domain save commands remain the intended consumers.

## Scope and validation

Only two GET requests are permitted by this adapter. Origins are fixed by the
staging/production enum; redirects are rejected; reads time out and response size
is bounded. Provider payloads and credentials are never included in errors.
There is no channel creation, mapping, activation, publication or reservation read.

Tests use synthetic documented responses to verify scope denial before listing
access, invalid data, bounded responses and sparse normalization. No real host
authorization or current live-listing read is claimed. Remaining slices are durable
source storage, authenticated connection start/callback, selection and details,
shared-review integration, and fresh-host verification.

## Durable connection attempt and source slice

Migration 0179 adds `hotel_catalog.airbnb_import_sources`, separate from invitations.
An internal repository generates a random 256-bit state, persists only its SHA-256
digest, and binds it to actor, organization, canonical property, Channex environment,
group and external property. Pending state expires after 20 minutes, independently
of the provider link lifetime. Invalid/expired/wrong-scope callbacks return no record.

The future callback must reauthorize the session, resolve the pending record, and
verify/read the channel using its stored scope. Only then may it atomically complete
the attempt with the channel ID and validated prepared snapshot. Concurrent callbacks
have one winner. Completed snapshots are immutable; a unique environment/channel
binding prevents a new attempt from binding that connection elsewhere or generating
a second source identity. Reconnection/source refresh needs a later explicit reuse
flow; it must not overwrite this snapshot. Reading a completed source requires its
exact actor/organization/property scope and remains possible after attempt expiry.

This repository is internal infrastructure, not an authorization boundary. Route
policy, current membership/permission/property-access checks, callback CSRF/session
correlation, failed-attempt cleanup, and item-level application receipts remain later
slices. No route is mounted and no provider connection is created by this change.
Integration tests use bounded synthetic records in the reserved local database,
including concurrent completion and conflicting channel bindings.

## Authenticated route adapter slice

The isolated Fastify route plugin exposes POST `/properties/:propertyId/airbnb-import/start`
and `/complete`, plus GET `/sources/:sourceId` under that property path. It is not
registered in the running application yet. Every request requires active actor,
membership and hotel organization, hotel setup permission and owner/operator link,
plus PMS management permission, owner/operator link and property entitlement.
The shared property policy also enforces the member's current assigned-property
scope; organization-wide property links alone are insufficient.
Mutations require an exact configured browser Origin; bodies and IDs are bounded.

Start accepts no provider IDs or redirects from the browser. Its injected server
binding resolver supplies the property/group/environment; its connection-link port
must use fixed configured success/failure destinations and validated provider URLs.
Completion accepts only the opaque state and returned channel ID. It loads the
pending attempt under current actor/organization/property scope, re-resolves the
current binding and compares it to the saved one, reads/verifies the provider channel,
and only then completes the source. `success=true` alone is not accepted as proof.

The future frontend callback must POST through the authenticated API client from
its configured origin, remove callback tokens from the address bar and avoid token
logging. Provider rejection/temporary read failure leaves pending state retryable;
expiry or already-completed state requires source retrieval/new flow rather than
another completion. Failure redirects display failure without completing anything.
Source retrieval rechecks the current binding before exposing its saved snapshot.
Production binding/link ports, callback UI and live mounting remain later slices.

## Connection link transport slice

The unmounted provider factory posts only to the configured Channex environment's
connection-link endpoint. Server-resolved group/property IDs and a fixed return path
containing canonical property/source IDs bind the link to its pending attempt.
The opaque state is passed as Channex's callback token; browser redirects cannot
choose destinations. Returned links require HTTPS on airbnb.com or www.airbnb.com.
Responses are bounded to 256 KiB and transport failures are sanitized.

Tests mock provider responses; no live connection was created. Mounting still needs
a trusted binding resolver, callback handling, and request-log token redaction.
The existing 20-minute attempt expiry still applies even if a provider link lasts longer.

## Browser return slice

`/setup/airbnb-return/:propertyId/:sourceId` is disabled unless the server sets
`AIRBNB_IMPORT_CALLBACK_ENABLED=true`. The response sets no-referrer policy. The
client scrubs query/hash before authenticated completion or session recovery.
Strict Mode reuses one completion operation. Cancelled/malformed callbacks do not
complete; reload or a lost completion response reads the actor-scoped saved source.
Only a matching source returned by Vayada produces a review-ready message. No room
is applied, and the existing setup page does not yet consume this source.

Browser tests use synthetic auth/provider API responses. Live mounting still needs
trusted binding resolution, verified request-log token redaction at proxy/application
layers, and source review/application wiring. URL scrubbing cannot remove tokens
from the initial incoming request logs. Do not enable this flag remotely yet.

Focused browser check: start the isolated marketplace frontend with the callback
flag, then run `E2E_AIRBNB_IMPORT_CALLBACK=1 E2E_MARKETPLACE_BASE_URL=<local-origin>
npx playwright test tests/e2e/marketplace-web/airbnb-import-return.spec.ts
--project=marketplace-web-chromium`. The suite is opt-in because normal builds keep
the callback disabled.

## Application receipt prerequisite

Airbnb room saves must reuse the canonical room commands and stable draft identity
`import:<sourceId>:<listingId>`. Invitation receipt rows cannot represent Airbnb
sources. A separate receipt table references the immutable Airbnb source; scope
comes from its actor, organization and property. Per-source advisory locking
serializes application callbacks and presents prior successful item receipts.
Only successful receipts persist; failed items remain retryable. Existing receipts
win on merge so later retries cannot replace an already-recorded room identity.

This is an internal storage port, not a new save endpoint. Callers must reauthorize
current hotel access and recheck the provider binding before canonical commands.
A room command may commit before its receipt is written: the future consumer must
reuse the existing draft-room binding lookup to recover that gap without creating
a second room or overwriting subsequent edits. Tests in this slice validate receipt
serialization and scope using synthetic executors, not actual room creation.

## Shared review consumer

The optional Airbnb review API lives at `/properties/:propertyId/airbnb-import/sources/:sourceId/review`.
It inherits Airbnb session, assigned-property, entitlement and Origin checks. It rechecks
the source's saved provider binding on reads and inside the serialized application callback.
The existing prepared-import executor handles selected room validation, canonical commands
and draft binding recovery; the Airbnb receipt repository supplies its source and receipts.
The URL and body source IDs must agree. Property-field updates are excluded for Airbnb.
No invitation discovery route is registered for this consumer. Production mounting remains off.

The callback now embeds the shared room review panel using the explicit source review
endpoint. Owners select only relevant listings, fill sparse facts, and save canonical
room types before returning to setup. The shared component's default invitation
endpoint is unchanged. Source changes reset pending edits and ignore stale responses.
Browser checks use simulated API/auth responses, including a lost save response followed
by receipt refresh; actual Channex linking and production binding remain unverified.

## Integrated local smoke

The reserved database harness composes the optional Airbnb routes with real source,
application receipt and canonical room repositories. Only identity and provider ports
are synthetic. An opt-in Playwright test drives the actual callback and shared editor
through that harness, discards the save response, reloads, removes only its own receipt,
and concurrently replays a changed room draft. The saved room identity/name must remain
unchanged and the receipt must be recovered without another room. Each run preserves
one new synthetic room for inspection; the existing demo is not reset.
