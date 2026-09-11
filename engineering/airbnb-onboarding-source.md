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
