# Approved Marketplace hotel profile

VAY-1943 continuation of `onboarding-command-safety.md`, migration 0046 and
`public-hotel-profile-ownership.md`.

The Marketplace hotel page reads only the immutable submission referenced by
the approved, active Marketplace pointer. Latest submissions and mutable setup
drafts are never fallback sources. Reading does not submit, approve or activate.

The public projection explicitly includes property ID, submission revision ID,
display name, property type, short description, public locality and approved
images. Street address, postal code, coordinates, contacts, organization/user
IDs, source manifests, readiness hashes and moderation notes are excluded.
Locality is omitted when the submitted Catalog profile marks it private.

Images must still resolve through the existing Platform Media public resolution
port for the submitting organization and property. Only media IDs captured in
the approved snapshot can resolve; stored snapshot URLs are never served.
Revocation or unresolved media suppresses the profile rather than serving stale
images. An unavailable resolver also fails closed. The active pointer is checked
again after resolution to avoid returning a revision withdrawn during the read.

The runtime public read will use `GET /api/marketplace/hotels/:propertyId` with
`Cache-Control: no-store`. Missing, non-active and unapproved profiles return the
same 404; malformed property IDs return 400; provider failures return a generic
503 without snapshot content. The browser page uses this projection only. Review
may link to that route only after verifying the matching active revision.

This contract does not add moderation/activation commands, collaboration writes,
offers, pricing, payments or Booking publication. Local approval/activation rows
used by tests are synthetic fixtures only.
