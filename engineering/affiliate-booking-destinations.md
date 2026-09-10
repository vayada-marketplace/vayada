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

Migration numbering: main already uses 0174 for PMS closures. The predecessor
Finance migration in this stack must be renumbered/restacked before merge; 0179
was the next unused main number when this slice was created.
