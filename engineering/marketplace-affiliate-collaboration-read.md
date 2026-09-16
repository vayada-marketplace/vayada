# Affiliate assent from existing collaborations (VAY-1502)

Extends `marketplace-affiliate-assent-read.md`. Marketplace collaboration
screens currently have compatibility-facing collaboration IDs, not canonical
affiliate attempt IDs. Resolve that boundary on the server.

`GET /api/marketplace/collaborations/:collaborationId/affiliate-assent` returns
the same model as the existing attempt read. The collaboration ID is an opaque,
case-sensitive `source_collaboration_id`, 1–200 characters without surrounding
whitespace or control characters. Never interpret it as the canonical row ID.
Authentication, permission, active identity, no-store and sanitized errors follow
the existing endpoint; malformed keys return 422.

Resolve only the selected organization's side of the collaboration. Source keys
are unique per source system, not globally; multiple matching collaborations
within that side are ambiguous and return 404 instead of choosing one. Match the
canonical offer, property, hotel organization, creator profile and creator
organization to the affiliate program and stable participation. Select the
highest attempt number, then use the existing assent reader to enforce current
persisted links, creator ownership, hotel entitlement and assigned property
scope, and to return the exact pinned terms. Do not fall back to an earlier
matched attempt when the latest attempt is pending.

Missing collaborations, no affiliate participation/attempt and denied access
all return 404 `scope_unavailable`. This is deliberately not an eligibility or
application-readiness endpoint. The UI can show “Affiliate agreement unavailable”
without claiming that joining is allowed. A success is assent evidence only,
not activation or earning eligibility.

The lookup selects the most recent attempt visible at lookup time; the existing
reader returns that immutable attempt with decisions from its own single SQL
snapshot. A concurrently created attempt can appear on the next request. If
access is revoked before the second read, fail closed. There are no writes,
locks, repairs or acceptance copied from old collaboration fields.

No lifecycle-status or legacy affiliate-enabled filter: completed hosted/paid
collaborations retain access to their separate affiliate history. Missing or
inconsistent canonical ownership joins never yield another relationship's data.

Validate with actual PostgreSQL migrations for affiliate storage and a
production-shaped collaboration fixture: both parties, wrong tenants/creator,
canonical-vs-compatibility ID, scope substitution, completed collaboration,
no participation, latest pending over older matched attempt, revoked links and
assigned-property denial. HTTP tests cover auth, opaque-key validation,
404 equivalence, response forwarding and no-store errors.
