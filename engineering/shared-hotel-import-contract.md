# Shared hotel and room import

Status: contract and parser implemented in slice 1, 2026-09-10. Full-flow implementation is delivered by subsequent stacked PRs; deployment and real-account acceptance remain pending.

## Outcome

An owner can review prepared hotel details and room types during onboarding,
after accepting a hotel-account invitation, or from room settings. Saving uses
one authorized canonical property and the existing domain commands. Accepting
an invitation alone does not create a property or rooms.

The initial source is admin-prepared data attached to an invitation. Website/OTA extraction is a separate source adapter; it is not
silently included in this scope. VAY-1009 already tracks Booking.com/Airbnb room
extraction and explicitly excludes property onboarding.

## Existing contracts

- [TypeScript boundaries](typescript-backend-structure.md)
- [Domain ownership](backend-database-restructure.md)
- [Identity and resource links](workos-identity-architecture.md)
- [Setup command safety](onboarding-command-safety.md)
- [VAY-1009](https://linear.app/vayadacom/issue/VAY-1009): future OTA source

The import branch builds on draft PR #1805 (`ff3406b6d`), which owns the shared hotel prerequisite handoff.

## User flows

### Admin preparation and invitation

1. Admin enters the invited email, organization/property names, and tracks.
2. An optional preparation form collects hotel details and room-type drafts.
   It uses the supported catalog fields, not the retired Python setup object.
3. Admin reviews the prepared data and creates the invitation.
4. The public invitation lookup continues to expose only the masked identity,
   names, selected tracks, and expiry. Prepared contacts and room data are not
   part of public lookup.

### Invitation acceptance

1. Preserve current matching-email and invite-bound organization checks.
2. Provision/select the invitation organization and redeem setup tracks using
   the existing commands and recovery behavior.
3. Resolve the accepted invitation's prepared data through an authenticated,
   organization-scoped endpoint. A browser refresh must not require an unused
   code or rely solely on session storage.
4. If no canonical property is selected, offer creation or selection from the
   current organization's authorized properties. Never choose the first hotel
   or match ownership using the invitation's display name.
5. Review prepared data against the selected property. Show additions, changes,
   missing required values, and conflicts before any canonical import writes.
6. Save the selected changes and continue with an explicit `propertyId`.

### Onboarding and room settings

Onboarding uses the same preparation/review component after property selection.
Room settings supplies the currently selected, server-authorized property. It
does not offer implicit property creation. If no prepared source exists, normal
manual setup remains available. Additional import sources must produce the same
review model rather than implement their own persistence logic.

## Data and ownership

- Hotel profile fields use `domain-hotels` property/profile contracts.
- Room-type facts use `domain-pms` room facts and vocabulary validation.
- Room types and physical units are distinct. Missing stock counts stay unknown;
  an imported room type must not imply a number of bookable physical rooms.
- Pricing, availability, cancellation/payment policies, publication, amenities,
  and media remain separate domain operations. They are not inferred from an
  imported description or written as side effects of basic room-fact import.
- Prepared data has an immutable source revision and stable item identifiers.
  A review records the target organization/property and target revisions.
- Invitation records keep authentication/redemption state. Prepared data and
  import progress have their own versioned contract and durable lifecycle.
  Do not revive the unvalidated legacy `data: dict` contract.

## Access and privacy

Every read, preview, and apply endpoint enforces the typed request context.
An invite code never authorizes an import write by itself. The server resolves
the current organization, active membership, required permission, and linked
property; it ignores client claims of ownership.

Hotel-profile changes require catalog write permission and an owner/operator
link. Room changes additionally require the appropriate active PMS entitlement
and room-management permission. Marketplace-only invitations may prefill hotel
details, but cannot grant PMS access merely because prepared data contains rooms.
Front-desk import permission is not inferred from ordinary room-edit permissions;
the initial bulk-import flow is restricted to authorized owners/operators.

Prepared data attached to an invitation is readable only by authorized platform
admins or the accepted invitation's actor in its bound organization. Wrong-email,
expired, revoked, unrelated-organization, and unaccepted invitations do not expose
the prepared payload. Existing authentication must establish verified email
ownership before invitation provisioning; add explicit test evidence for this.

## Duplicate prevention and recovery

- Resolve a single property before applying. Imported names, URLs, and addresses
  are suggestions, never property access grants.
- Bind each source revision/import operation durably to its target property.
  Retries reuse that binding and the property-create idempotency key.
- Separate invitations for the same hotel are not automatically the same
  organization. Admin UI must warn about existing pending invitations and offer
  reuse/revocation; linking existing organizations is a distinct authorized flow.
- Assign each prepared room a stable draft ID. Use the canonical draft-room
  binding to resolve retries to the same room type.
- Name matches flag a possible duplicate for review. They do not silently merge
  or overwrite a room. Existing room updates are outside this version.
- Reauthorize immediately before writes. Reject stale review revisions rather
  than overwrite newer user edits.
- Persist per-item results and command keys. If property saving succeeds and a
  room fails, show the partial result and retry only unfinished items. Do not
  delete successful records as an attempted cross-domain rollback.
- Replaying an import after the user edits a saved room must preserve that edit.

## Delivery sequence

1. Repair the invite-to-property handoff for both adaptive and shared setup.
   Use existing authorized property selection/creation and preserve entry/return
   products. Existing links with a property ID keep their behavior.
2. Add a bounded prepared-data contract, persistence, admin form, and protected
   post-acceptance retrieval. Keep existing invitations valid and public lookup
   unchanged. Add request-size, field-length, item-count, and vocabulary limits.
3. Add one reusable review UI for hotel fields and room drafts. Resolve incomplete
   data in editable forms and expose precise permission/conflict failures.
4. Apply through property and PMS domain commands with durable target bindings,
   idempotency, optimistic concurrency, and per-item recovery.
5. Mount the shared flow after invite acceptance, in onboarding, and in room
   settings. Verify each entry point with the same prepared fixture.
6. Integrate OTA extraction separately under VAY-1009. Keep extracted content as
   untrusted suggestions, with explicit source information and missing values.

Each delivery step should be a narrow reviewed change. The whole feature is not
complete when only its contract, UI shell, or happy-path preview is implemented.

### Implementation progress

This first slice contains the prepared-data contract, bounded parser, and parser
tests. Subsequent slices add storage, authenticated routes, the admin editor, and
the shared review UI. Runtime activation starts in slice 5; onboarding and PMS
mounting arrive in slice 7. The following behavior describes the complete stack,
not functionality available from slice 1 alone. The adaptive flag remains unchanged.

Version 1 supports hotel name/type, street/postal address, city, country, timezone,
and room name/description/occupancy/bed/bathroom/size facts. Contacts, media, physical
inventory, prices, availability, amenities, and publication are separate setup steps.
Existing room types are preserved; importing into an existing room is not supported.

Migration 0178 stores the invitation-to-property binding and per-field/per-room
success markers. The binding commits before canonical commands, under a session
advisory lock. Failed unlocks destroy the connection. Room creation uses a stable
draft binding plus a facts-sensitive command key so corrected failures can retry.
Property creation preserves its source key when the owner fills missing details.
Both explicit Add paths use a fresh key and blank draft. A changed replay of an
invitation create command requires review instead of patching the original hotel.

Import saves do not remount the adjacent setup wizard or discard unsaved edits.
Existing forms retain their ordinary revision-conflict handling; reopen the relevant
setup step to read newly imported facts. Skipped fields and rooms remain available.

Complete-stack validation evidence belongs in the implementation PRs, including
#1841. It is not evidence that this contract slice exposes the full flow.

## Acceptance and verification

- An accepted invitation opens usable property selection/creation under both
  setup flags, then continues with the selected canonical property ID.
- Public lookup never returns prepared hotel contacts or room drafts.
- Wrong actor/organization, revoked/expired/unaccepted invitation, inactive
  membership, missing permission/entitlement, and unlinked property are denied.
- Old invitations without prepared data still work.
- Preparing or previewing data creates no canonical hotel/room records.
- An owner can edit, select, and skip prepared fields/rooms before saving.
- Room settings cannot create or switch properties implicitly.
- Missing facts are not converted into fabricated occupancy, beds, stock, prices,
  amenities, or published content.
- Repeated acceptance, refresh, double-click, concurrent apply, and a lost
  response create at most one property/room per durable source binding.
- Conflicting names and stale revisions require review; saved user edits survive
  replay. Partial failure reports accurate per-item results and resumes safely.
- Actual PostgreSQL integration tests cover uniqueness and concurrency. Fake
  repository tests alone are insufficient evidence for these guarantees.
- Build/typecheck affected shared packages and frontends; run relevant API and
  frontend tests, then exercise real UI/API flows using bounded synthetic data.
- Record deployed revision and real-account smoke evidence separately from
  local/mocked verification. Preserve reusable accounts and shared fixtures.

## Local validation record for slice 1

- Prepared-data parser tests cover valid data, unknown facts, unsupported fields,
  duplicate room identifiers, and input bounds.
- No runtime route, database migration, or mounted import UI is included in this
  slice. Their validation is recorded in the later implementation PRs.
- Not deployed. Real-account invite acceptance and deployed saving remain to be
  verified after the prerequisite and import changes are merged and deployed.

## Migration allocation correction (2026-09-10)

Prepared import uses version 0178. The shared next database already applied closure
migrations 0174–0177 from the approved closure canary; those files and checksums
are immutable. A read-only ledger check at 04:06:34 UTC showed version 0174 named
`pms_room_type_closures` and no `hotel_catalog.prepared_import_applications` table.
The original prepared-import 0174 filename therefore conflicts with applied
history and is moved to 0178 without changing SQL. No database ledger is edited.
Deploy with the closure migration lineage preserved; the aggregate owner must
verify the combined catalog before rollout.
