# Affiliate booking destinations

VAY-1501 / VAY-1505. Builds on the approved generic PMS approach, the
[offer terms](marketplace-affiliate-offer-terms.md) and
[booking evidence contract](affiliate-booking-evidence-contract.md).

Booking owns a destination: the named booking page to which affiliate traffic will
be sent. It is distinct from a PMS connection, which may supply reservation/stay
facts. Neither Vayada Booking nor a named external provider receives implicit trust.
Marketplace stores the exact destination version ID in its affiliate terms.

Hotel configuration accepts only `displayName` and `bookingUrl`. The name is trimmed
and bounded to 120 characters; the absolute URL is HTTPS, bounded to 2048 characters,
without embedded credentials or a fragment. Query parameters are preserved because
providers may identify a property there. Configuration does not fetch the URL,
follow redirects, certify domain ownership, or establish booking/tracking readiness.
The URL is never a template containing creator IDs or executable interpolation.
Identity, property, connection IDs and validation flags are server-owned fields.

Destination changes create new immutable versions. Evidence applies to the exact
destination version and canonical property, so changing a URL cannot inherit old
tracking validation. Disablement prevents new use without deleting historical
terms/evidence. Persisted configuration and current validation will be loaded only
after fresh property authorization by the application adapter.

Tracking assessment requires server-resolved connection evidence for four separate
purposes: referral round-trip, reservation lifecycle, completed stays, and classified
accommodation revenue. These implement the already agreed attribution, completion
and commission-basis requirements; they do not choose refund/no-show settlement
rules. Each purpose must be supported, validated with an evidence reference/date,
and operationally healthy. Unknown, merely documented, stale and revoked evidence
cannot pass. The supplying adapter owns freshness; this contract invents no TTL.
The application supplies exactly one current selected evidence entry per purpose;
duplicates and future-dated validation remain pending. This is not an evaluator of
raw evidence history. Each purpose may come from a different connection, all mapped to the same property
and destination version. This allows a booking engine plus an external PMS.

The pure assessment reports missing purposes and a `verified` or `pending` tracking
status. Even verified tracking is not permission to publish, issue a creator link,
attribute a booking or pay. Publication must additionally check current hotel and
creator authorization, approved Finance policy, complete accepted terms, live
connection access and the relevant attribution/evidence policy decisions.

Implementation order: validated configuration and tracking assessment (this slice),
Booking-owned immutable storage and authorized configuration/read API, hotel setup
UI and provider evidence adapters, then initial offer-draft creation and publication.
No destination is registered or verified by this pure contract. Public creator reads
and redirect execution remain unavailable until those application gates exist.

## Immutable persistence

Migration 0179 stores Booking-owned destination versions with their canonical
property, authoring organization/user, request and timestamp. Saves require fresh
Marketplace profile management permission, active entitlement and owner/operator
access, rechecking the persisted property/link under a transaction lock before any
replay. A completed actor/property/key/payload request replays; changed input
conflicts. Configuration and retry evidence commit together. New URLs create new
version IDs. No row grants verification, activation or publication.

Migration numbering: main uses 0174–0178. Destination storage uses 0179;
the unmerged Finance policy migration was renumbered to 0180 throughout this
stack. No applied migration or existing database ledger is rewritten.

## Hotel setup HTTP API

`/api/marketplace/properties/:propertyId/affiliate-destinations` supports POST
with exactly `{displayName, bookingUrl}` and one nonempty Idempotency-Key (up to
200 characters, no commas). Created versions return 201; replay returns 200;
invalid input 422, unavailable scope 404 and changed-key payload conflicts 409.
GET lists the newest 20 versions for the authorized property and authoring
organization. GET `/:destinationVersionId` retrieves that exact version or 404.
Reads return `trackingStatus: not_validated`, never verification from configuration.
Fresh hotel profile-management permission, owner/operator link, active hotel identity
and profile entitlement protect every endpoint; errors and successes are no-store.
The shared app error handler retains 503 for database connection/capacity failures;
ordinary server exceptions remain 500. Neither becomes a missing destination.
No edit/delete, verification, network-fetch, activation or publication route exists.

## Hotel setup form

The hotel profile Offers tab accepts an explicit booking-page name and HTTPS URL,
using the shared Booking validator and authenticated destination API. It lists
saved versions as tracking-not-validated and never follows or activates their URLs.
Retries preserve the same key for the same normalized input during the editor
session. Successful saves clear the form and reload stored history; a failed history
reload does not offer a duplicate save. The component is keyed to the canonical
property so requests and retry state do not carry across property selections.

## Tracking diagnostics

Authorized destination reads now include `trackingReadiness: { status, missing }`
from the shared Booking assessment; offer draft reads carry the same destination
diagnostics. The current adapter supplies no trusted evidence, so all four purposes
remain pending. No row, URL or PMS subscription can produce verified tracking.
The hotel setup form displays the server-reported missing purposes in expandable
details, or reports unavailable details when an older API omits the field.
No checkbox, verification write endpoint or provider-specific shortcut exists.

The next dependency is a trusted owner-domain evidence adapter, scoped to exact
destination/property and live connection. It must resolve an existing restricted
evidence reference, validation time and current connection health for each purpose.
The adapter owns freshness and revocation; documented support alone cannot pass.
Vayada Booking and external booking/PMS integrations must use the same evidence
contract. Existing Channex inventory/operational tests are not affiliate referral
round-trip or completed-stay proof. Policy gates in
[the booking evidence contract](affiliate-booking-evidence-contract.md) remain
applicable before attribution/intake runtime or publication is enabled.
