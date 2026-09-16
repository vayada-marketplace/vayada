# Affiliate initial assent read (VAY-1502)

Extends `marketplace-affiliate-agreements.md` using migrations 0196–0197.
This slice reads an existing attempt; it does not enroll, publish, activate,
issue links, compute commissions or change collaboration lifecycle.

## Request and authorization

`GET /api/marketplace/affiliate-attempts/:attemptId` uses a fresh trusted
RequestContext and `marketplace.collaboration.read`. Missing/invalid auth is
401, missing permission or inactive actor/membership/organization is 403,
malformed UUID is 422. Absent or inaccessible attempts are the same 404
`scope_unavailable`. All responses, including failures, are `no-store`.

Hotel readers need the program's organization, active owner/operator links
for its hotel profile and offer, an active marketplace-hotel-profile
entitlement, and canonical property access (including assigned-property scope).
Creator readers need the participation's organization, the profile's current
owner user, and exactly one active owned creator-profile link matching that
profile. Creators do not need a paid entitlement. Persisted organization links
are checked as well as trusted context links; revoked links deny access.
Unsupported organization kinds cannot read this endpoint.

Reads expose retained history even if an offer is archived or a profile is
inactive; current identity and resource authorization are still required.
Neither hosted collaboration completion nor a newer publication replaces the
attempt's pinned terms. There is no arbitrary creator-directory/list endpoint.

## Response

Return only `participationId`, `attemptId`, `programId`, `propertyId`, `offerId`,
`creatorProfileId`, `origin`, `revision`, `assentState` (`pending` or `matched`),
`terms` (`id`, exact retained `disclosure` string, `disclosureHash`), and
`hotelApprovedAt` / `creatorAcceptedAt` (ISO timestamp or null).
Revision is the number of decisions for this exact attempt. Matched requires
both distinct decisions; it is not activation or evidence of earning eligibility.
An existing attempt with no decisions is pending at revision zero.

Use one SQL statement for attempt, pinned terms, decision timestamps, and
persisted scope so concurrent acceptance cannot produce mixed revisions.
Verify the retained disclosure bytes against their SHA-256 before returning
content. Corrupt storage fails closed as a server error. Do not return raw
SQL errors, audit actors, request IDs, evidence references or internal finance
policy data. There are no writes or runtime repair on reads.

## Validation

Exercise real PostgreSQL fixtures for each party, pending/matched transitions,
exact pinned disclosure, archived historical reads, foreign tenant/creator,
revoked persisted links, assigned-property scope, entitlement denial and
corrupt disclosure. Route tests cover authentication/permission denial,
malformed IDs, no-store, 404 equivalence, failures and the production prefix.
