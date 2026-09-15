# Team, roles & permissions: VAY-1439 implementation contract

Status: implementation authorized; confirmed decisions and remaining preset details are listed below. This
document does not change runtime authorization or authorize a migration of
existing users. [VAY-1439](https://linear.app/vayadacom/issue/VAY-1439)
owns the complete feature; each implementation PR must identify its covered
acceptance criteria and remaining successors.

## Existing implementation and gaps

Assessment base: `b342b7d6f` on `main`, 15 September 2026. The five attached
Linear images were inspected alongside the complete ticket.

| Requested capability         | Existing foundation                                                | Required extension                                                                                             |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Worker roster and suspension | VAY-1420/VAY-1427 page, `pmsStaffClient`, canonical staff routes   | Preserve existing states, add requested labels/actions and summaries                                           |
| Account admin card           | `hotel_owner` membership                                           | Read actual admin membership; roster currently excludes it; never infer from current viewer                    |
| Invitations                  | Identity persistence, WorkOS delivery and acceptance               | PMS form and delivery feedback; invitation read model must expose safe revision/delivery state for resend      |
| Edit access                  | Membership PATCH accepts role, overrides and selected property IDs | Authorized read of stored configuration before editing; current roster omits overrides and scope mode          |
| Custom roles                 | Global `role_permission_grants` and membership overrides           | Organization-owned role definitions, membership/invitation references, validated commands and resolver support |
| Product toggles              | Organization entitlements and permission-based product entry       | Independent membership restrictions enforced by server and manifest; do not modify subscription entitlements   |
| All future properties        | Resolver already supports `all`                                    | Staff validation, HTTP commands, persistence and acceptance currently require/write `assigned`                 |
| Property matrix              | Roster returns effective property IDs                              | Include owner rows and distinguish configured assignments from presently usable access                         |
| Admin transfer               | WorkOS identity and ordinary lifecycle commands                    | Single-admin invariant, migration preflight, atomic transfer and fresh provider authentication proof           |
| Sixteen section controls     | Explicit granular permission keys                                  | Complete section-to-route mapping; several requested Edit levels have no corresponding key                     |

Code references: `apps/pms-web/app/(app)/settings/team/page.tsx`,
`apps/api/src/routes/staffInvitations.ts`,
`packages/backend-auth/src/{lifecycle,staffInvitations,staffInvitationAcceptance}.ts`,
and `packages/backend-authorization/src/index.ts`.

VAY-1321 is marked Done, but the checked-out resolver's
`isAgencyMembershipScope` requires `accessOrigin === 'agency'`; owner-delegated
staff fail closed. The invitation API accepts only the four VAY-1085 staff
roles. The existing delegation contract/schema therefore must not be reported
as a delivered owner invitation/delegation flow on this base. Verify any other
implementation before reuse and explicitly account for missing runtime work.

Booking Add-ons and Promos currently authorize with `booking.settings.manage`
(`bookingAddonItems.ts`, `bookingPromoCodes.ts`); granting their proposed Edit
level through that key would also grant unrelated Settings access. Split these
route policies before exposing independent section controls. `pms.finance.manage`
exists in the wider permission type but is absent from the staff override
allowlist; distinguish existing API capability from delegable staff capability.

## Boundaries retained

WorkOS owns identities, credentials, MFA, sessions and provider invitations.
Vayada owns membership authorization. Extend existing identity tables and
commands; do not introduce parallel account-users or password storage.

Retain [staff authorization](staff-access-authorization-contract.md),
[external-owner delegation](external-owner-delegation-contract.md),
[WorkOS identity](workos-identity-architecture.md), and typed `RequestContext`
with `enforceRoutePolicy`. No legacy Python changes or deployment cutover are
part of this feature.

Every grant remains bounded by active membership, organization, property links,
delegation ceilings, guest-contact rules and product entitlement. UI access
counts describe configured levels, not a promise to bypass those restrictions.
Suspended and invited users have no current access, even when assignments are
shown. The matrix must label configured property assignments if it retains the
mockup's checkmarks for those users.

## Role and section semantics

Account admin maps to `hotel_owner`, never platform admin. It cannot be assigned
through ordinary staff edits, invitations, custom roles, or role deletion.
Existing role defaults and membership overrides are preserved until an explicit
migration is reviewed; renaming a card must not silently change access.

Custom roles belong to one organization. Persist the role reference on both
membership and invitation, with same-organization integrity. Resolve current
role grants on every authorization resolution; validate overrides against those
grants and role ceilings. Reject missing, deleted, foreign or malformed roles.
Role edits are versioned, audited and transactional. Reject deletion while
members or pending invitations reference a role; VAY-1439 permits this simpler
alternative to a reassignment flow.

### Security ceilings versus editable defaults

A role has an immutable security class, editable default section permissions,
and independent per-member overrides. Security classes and their permission
allowlists are server-owned policy, never values an ordinary role editor can
create or expand:

| Security class | Ceiling and assignment rules                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account admin  | Reserved `hotel_owner`; assignment only through provisioning or authenticated admin transfer, never custom-role commands                                 |
| Staff          | Validated staff section keys; no billing, ownership transfer or platform administration; Agency managers may manage workers within the limits below      |
| Housekeeping   | Staff ceiling excluding guest contact permission; customized or cloned Housekeeping roles retain this class                                              |
| External owner | Existing external-owner ceiling and assigned-only scope; delegation permission remains a separate admin-controlled grant, never an editable role default |

Custom roles start in the Staff class. Duplicating a protected preset retains its
class; changing its name never changes the class. A role's class cannot change
through role-default edits. Only the account admin may create/edit/delete role
definitions. Agency managers may invite and manage workers within their own effective
permission, property and product ceilings. They cannot edit themselves, another
Agency manager, an Account admin or an External owner; grant management authority;
change role definitions; or transfer ownership. Other agency staff cannot assign
another member's role. Preserve the external-owner contract's exception when
that flow is delivered: an owner with current delegation permission may select
permitted Staff/Housekeeping roles for their own invited or delegated staff,
within the owner's live permission/property/product ceilings. This permits
validated transitions between those staff classes, never creation of roles or
assignment into Account admin/External owner classes. Other class transitions
require an explicit audited admin command and destination-model validation;
ordinary staff cannot change their own class or elevate themselves through a
shared role definition.

An effective section permission is the role default plus valid member grants,
minus member denies, bounded by the immutable class and any live delegator
ceiling. Defaults are not the ceiling: Calendar View plus a member Edit override
is valid for Staff when its required read keys are present. Reject any defaults
or grants outside the class ceiling on write; malformed persisted configuration
fails closed on read. Overrides that become invalid after a role edit must be
detected transactionally before committing that edit, with an explicit validated
reassignment/reset required instead of silently widening or breaking access.
The role catalog/read response exposes the class and allowed controls so the UI
cannot imply an unavailable grant. Retain separate property and product checks.

Role defaults and per-member overrides remain distinct. Changing a role must
explicitly retain or reset overrides; saving an unrelated property edit must
not replace unseen overrides with empty arrays. The access response includes
stored configuration, effective access, allowed edits and a revision; stale
saves return conflict before any partial mutation.

The sixteen UI sections require a reviewed key/route mapping before their
editors ship. Calendar, reservations, inbox, rooms/rates, property settings,
design and booking flow can reuse existing read/write keys. Dashboard has
separate operational and financial visibility; reservations separately control
cancel and guest contacts; room-status-only access exists. Preserve those
distinctions instead of expanding permissions to fit a three-way switch.
Financials and Channel Manager currently have read-only staff controls. Booking
Chat, Add-ons and Promos need an endpoint inventory and explicit mapping.
Never display a successful Edit level backed only by a read permission.

For each section, enumerate all data reads, commands, exports and background
actions before exposing No access/View/Edit. View authorizes reads, Edit adds
the section's bounded commands, and No access removes all section keys.
HTTP method alone is insufficient: POST can run reads, and GET must never
perform an unguarded mutation. Cross-section endpoints need an explicit policy.
Bulk actions use the same validated mapping as individual controls.

## Product and property configuration

Persist per-membership PMS/Booking restrictions separately from organization
entitlements. OFF is a hard server veto after role/override resolution, including
compatibility permissions and product entry. ON permits normal policy checks;
it never purchases or activates a product. Preserve the underlying section
configuration when a product is turned off and back on. Extend invitations,
acceptance, auth responses, product switcher and direct API enforcement together.
New or malformed product configuration must have documented fail-closed rules;
an explicit compatibility migration preserves existing valid access.

For external-owner-delegated staff, effective product access is the intersection
of the staff member's switches and the live delegator's switches, followed by
normal entitlement checks. Compute the delegator's delegable permission set
after its product veto, so retained underlying section grants cannot authorize a
disabled product through the delegation. Apply this on every context resolution,
manifest read, invitation acceptance and delegated access mutation. Turning PMS
OFF for an owner removes derived PMS access on staff's next request, even when
their own PMS switch stays ON; Booking remains independently evaluated. Pending
invitations requesting an owner-disabled product cannot activate until the
invitation configuration or owner's access is explicitly corrected and all
ceilings are revalidated. Turning a product back ON restores only still-valid
configured access. Malformed/missing delegator product state fails closed;
agency-origin staff are unaffected by another member's product switches.

For agency-origin staff, `all` means all current and future active canonical
properties linked to the organization, with no snapshot assignment rows.
`assigned` validates selected IDs transactionally. External owners and their
delegated staff retain assigned-only ceilings; selecting all visible checkboxes
does not grant future properties. Revalidate scope during invitation acceptance.

Access saves update role, overrides, products, scope and status atomically in
one identity command, with idempotency, revision checks and audit. Do not compose
independent status/access calls under one Save button and imply atomic success.
After save, refresh the manifest; another user's already-open browser needs a
defined bounded refresh mechanism. Server denial applies on its next request
regardless of navigation refresh timing.

## Invitation and transfer lifecycle

Reuse invitation persistence and at-most-once delivery. Show pending/unknown
delivery accurately; a persisted invitation is not proof an email was sent.
Resend uses explicit replacement/revision semantics and never blindly retries
an ambiguous provider call. Invitation IDs are distinct from membership IDs;
pending rows cannot call membership status/removal/edit routes. Acceptance
revalidates current role, property and delegation restrictions.

Transfer requires fresh WorkOS-backed authentication bound to the current
session, actor, organization, target and short expiry; no browser boolean,
password stored by Vayada, or existing session cookie alone is sufficient.
Consume proof once inside the transfer transaction. The target must be an active
eligible membership in the same organization, with an active user.

Before enforcing one admin, inventory zero/multiple-owner organizations and
legacy aliases. Produce a migration exception report; never choose an admin
arbitrarily or silently demote existing owners. Serialize transfers on the
organization, validate the current admin again, and change both memberships in
one transaction under a database-enforced invariant.

The transfer request includes the former admin's proposed non-admin role,
products, property mode/assignments and overrides, with revisions for both
memberships and any referenced role. Preview this resulting access before fresh
authentication; bind its fingerprint to the one-use proof. There is no implicit
fallback role or reuse of old admin grants. The default selection remains a
product decision below, but every transfer must supply and validate a complete
non-admin configuration. An invalid or stale configuration changes neither user.

Normalize the new admin atomically: set `hotel_owner` and the reserved admin
role reference, `all` property mode, no assignment rows, empty permission
overrides, both membership product switches ON and `agency` access origin.
This removes membership restrictions, not organization entitlement restrictions.
When promoting delegated staff, explicitly adopt the membership into the agency
and remove its subject delegation edge in the same transaction. An external owner
who still delegates access to staff is ineligible until those dependents are
explicitly reparented/adopted or removed through the existing lifecycle; reject
the transfer without orphaning or silently adopting their staff. Invalid,
cross-tenant, suspended or pending targets and self-transfer are rejected.

Rewrite the former admin using the complete validated non-admin configuration,
including its role reference, scope rows, overrides and products, retaining
agency origin and no subject delegation. Increment both access revisions, consume
the bound proof and write redacted before/after audit in the same transaction.
Concurrent ordinary access edits must use compatible locking/revision checks;
they cannot restore old restrictions or old admin privileges after the transfer.
Existing sessions resolve the new configuration on their next request.
Reconcile coarse WorkOS roles through
durable retryable work; provider events cannot restore the previous Vayada role.

## Confirmed product decisions and preset details

Confirmed by Flamur in this task on 15 September 2026:

1. Agency managers may manage staff. Billing and admin transfer remain
   Account-admin-only. Implement the bounded worker-management rules above;
   this supersedes v1's blanket prohibition for Agency managers, not its other
   security boundaries.
2. Property owners use the `external_owner` model and receive read-only access
   to assigned properties by default. Existing owners are not silently migrated
   from their current permissions. New role presets use these defaults.

Remaining implementation details (derive and document conservative mappings
before each affected slice; do not treat the confirmed choices as unresolved):

1. Role presets need exact section levels, not only counts. The ticket names
   sixteen sections but gives different counts without their mapping. Confirm
   Front desk/Housekeeping differences from v1, dashboard sublevels, financial
   and channel Edit meaning, and the former admin's post-transfer role.

## Implementation stack and evidence

### Organization role storage

Migration `0201_organization_role_definitions.sql` adds tenant-owned definitions
with names, descriptions, default permission arrays, immutable security class,
base role key and optional preset identity. Database revisions increase on edits;
the reserved Account admin definition cannot be updated or deleted. Composite
foreign keys keep membership/invitation role references in the same organization.
All existing references remain null and continue using existing authorization.
No roles are seeded or assigned in this schema-only step. Do not populate those
references before the resolver, validated writers and acceptance support ship.
Those successors must validate permission ceilings and base-key consistency,
and define cleanup of historical references before allowing unused-role deletion.

### Booking section permission rollout

Deploy validation support for `booking.addons.read/manage` and
`booking.promos.read/manage` before migrating existing permission overrides.
These are separate section keys with explicit read-before-manage requirements.
The support-only slice changes no route policy or persisted grants. A successor
migration preserves existing Settings-based capabilities and denials before
switching Add-ons and Promos route policies. Confirm the support revision is
running on every API/worker instance before that migration; old validators
would reject the expanded overrides. Existing invalid overrides must remain
invalid rather than being silently repaired into grants.

Migration `0200_booking_addon_promo_permissions.sql` copies existing
Settings-manage role grants and explicit membership/invitation grants or denials
to both new section pairs. Null, malformed and duplicate-containing overrides
are preserved. Add-on catalog and promo-code GET routes then require their own
read key; POST/PATCH/DELETE require their own manage key. General Settings and
the other section provide no fallback. The `/settings/addons` surface continues
to configure Booking Flow; it does not modify the add-on catalog.

Pause permission/invitation configuration writes between migration and route
activation so an older writer cannot overwrite migrated denials. Resume after
verifying both migrated grants and denials. After migration, the rollback floor
is the support-only revision: do not redeploy validators that reject the new
keys. This release sequence has not been executed in a deployed environment.

### Dynamic property scope

Migration `0199_staff_invitation_dynamic_property_scope.sql` permits agency staff
invitations with `propertyAccessMode: "all"`. Both invitation and membership
commands require an empty `propertyIds` array for this mode and store no snapshot
assignments. Acceptance preserves the mode; authorization uses active canonical
organization links from each fresh context. Selected scope still requires at
least one validated property. Explicit HTTP membership scope changes require
the loaded revision, and all-mode commands require it at the repository boundary.
Switching back to selected scope schedules Inbox assignment reconciliation.
External-owner and delegated-staff scope ceilings remain assigned-only.

### Product veto foundation

Migration `0198_membership_product_access.sql` stores independent PMS and Booking
flags on memberships and invitations, defaulting to enabled to preserve existing
access. Apply this additive migration before deploying the resolver. Each hotel
authorization resolution reads the membership flags and removes disabled-product
permissions after member overrides, together with that product's effective
entitlements. Subscription records are unchanged. Missing or malformed flags fail
closed; identity management remains available when both products are disabled.
Saved member configuration includes `productAccess: { pms, booking }`; both
booleans participate in the revision. The combined access PATCH accepts the pair
only with `expectedRevision` and saves it atomically with status, role, overrides
and property assignments. Omission preserves existing flags. Audit captures the
previous and next pair. Disabling PMS schedules Inbox assignment reconciliation;
assignment eligibility and locked Inbox actor checks, including queued provider
delivery, enforce the flag. Invitations accept the same strict pair, defaulting
to enabled when omitted. Acceptance copies both stored flags into new and
existing memberships; replay preserves subsequent edits. The pair participates
in explicit invitation fingerprints and acceptance audit. No UI switch is
exposed yet; remaining background authorization paths require successor coverage.
The existing rejection of unsupported delegated memberships remains in place.

### Configuration read API (first backend slice)

`GET /api/identity/staff/members/:membershipId/access` uses the existing
`identity.staff.manage` policy and active actor/membership/hotel-group checks.
Organization identity comes exclusively from `RequestContext`; query parameters
cannot change it. As with roster and status routes, this identity management
read requires no PMS/Booking subscription or linked product resource.

The uncached response contains `membershipId`, `roleKey`, membership `status`
(`active`/`suspended`), `propertyAccessMode`, stored `propertyIds`, and validated
`permissionOverrides` (`grant`/`deny`). Null overrides mean empty differences
from role defaults. Stored assignments are not the effective all-property list.
Missing, foreign, removed, owner and invitation targets return the same `404`
`staff_member_not_found`. Malformed configuration, unsupported delegation scope,
unlinked assignments or storage failures return generic `500`
`staff_access_read_failed`, without provider details or stored invalid values.
Unauthorized reads return `401`/`403` before repository access.

The read also returns an opaque `revision` covering the persisted membership
configuration, timestamp, assignment rows and current role grants. The existing
membership PATCH accepts `expectedRevision`; mismatches return `409`
`staff_access_revision_conflict` without changing access, status, audit or
idempotency state. A combined save can include `membershipStatus`
(`active`/`suspended`) only with a revision. Role, overrides, assigned properties
and membership status commit together with audit and inbox reconciliation.

The new editor must always send the loaded revision and reload after success or
conflict. An exact idempotent replay reports the original command's success, not
the target's current state. Old callers may omit the revision for compatibility;
they cannot use that path for a combined status/access save. Existing status
commands change the next read's revision. Future role/product/delegation writers
must participate in compatible locking and extend the revision coverage before
those controls ship. Custom roles, product switches and dynamic staff scope
remain successor contracts; this slice changes no permission defaults.

1. This contract and decisions; no runtime changes.
2. Authorized configuration read model and invitation delivery/revision readback.
3. Organization roles: schema, commands, resolver and seeded preset decisions.
4. Product veto and dynamic staff scope: schema/writers, acceptance, resolver,
   manifest and route-policy denial tests in dependency order.
5. Atomic access command and invitation lifecycle adapters.
6. PMS sections, invitation/access/role dialogs and property matrix, using the
   delivered APIs. Preserve current roster/status flows while adding each slice.
7. Admin invariant preflight, provider reauthentication and transfer command/UI.
8. Route coverage audit, browser golden paths and deployed real-account smoke.

Keep PRs near 400 meaningful changed lines and link each predecessor. Test
unauthenticated, missing permission/entitlement, inactive entitlement, malformed
role/overrides, cross-tenant/property denial, valid access, stale revisions,
concurrent edits/transfers, replay and provider ambiguity as applicable.
Add focused cases for Calendar View-to-Edit overrides within a class, forbidden
custom-role/default grants, Housekeeping clones with guest-contact grants, role
edits invalidating member overrides, and self-elevation through shared roles.
Exercise owner PMS OFF with staff PMS ON, next-request denial, independent
Booking access, pending acceptance while OFF, and bounded restoration after ON.
Transfer tests start with restricted agency staff and delegated staff; assert
the complete new/old membership configuration and immediate session behavior.
Reject an external owner with dependents, stale role/member revisions and proof
replays; race transfer against ordinary access edits and inject transactional
failure to prove neither partial promotion nor partial demotion persists.
Verify all sixteen sections in both products and direct APIs, including guest
contact ceilings. Browser coverage includes loading/error/retry, keyboard/mobile,
invite delivery outcomes, role overrides, product OFF, future property scope,
suspension, removal and transfer failure/replay. Mocked browser coverage is not
deployed proof; record deployed revision and bounded synthetic fixture cleanup.
The full ticket stays In Progress until shipped acceptance criteria are verified
and the user explicitly accepts it.

### Role security policy support

The shared role policy validates immutable class/base/preset identity, role
defaults, member overrides and required lower permissions. Staff defaults can
be exceeded by explicit member overrides within the class ceiling. Billing is
excluded; manager authority belongs only to the Agency-manager preset; cloned
Housekeeping roles retain the guest-contact restriction. Account admin uses an
empty immutable definition and trusted live admin grants. This support slice
has no runtime callers or role assignments yet. Nineteen focused policy tests,
backend-auth build/typecheck and independent adversarial review passed.

### Live organization-role authorization support

The authorization scope query reads role references and same-organization
definitions together. Referenced roles resolve live defaults plus member
overrides, verify organization/base-role identity and fail closed with audit
on invalid definitions. NULL references keep legacy authorization. Only the
live non-editable property-manifest baseline survives outside section defaults;
unrelated legacy grants are excluded. Product vetoes still apply afterward.

This requires migration 0201 before runtime deployment. No role references are
populated by this slice. Do not activate assignment writers until role command,
invitation acceptance and background/Inbox authorization parity are delivered.
Validation: 31 selected resolver and PostgreSQL tests; affected typecheck and API
build. Independent review caught and verified the property-manifest baseline fix.

### Role catalog read

`GET /api/identity/staff/roles` uses active hotel-group staff-management
authorization and selects only the current organization. It returns validated
definitions, revision, immutable class ceilings and counts of active/suspended
member references plus unexpired pending invitations. Removed memberships and
expired invitations are excluded. Only Account admin receives the role-management
capability. The response is not cached. No presets or references are created.
Validation: PostgreSQL catalog lifecycle test, 39 staff route tests, backend-auth
build and API typecheck; independent review found no actionable issue.

### Custom-role creation command

The role repository can create or duplicate a role in an audited idempotent
transaction. It locks and revalidates the live Account admin before both writes
and replay. New roles use Staff/hotel_custom; duplicates preserve the source
class/base and lose preset-only management authority. Account-admin duplication
is forbidden. No HTTP writer or role assignment is activated in this slice.
Validation: two PostgreSQL catalog/command lifecycle tests including concurrent
replay, conflicts, protected clones, manager/suspended actor denial and audit
counts; backend-auth build/typecheck. Independent review found no actionable issue.

### Role edit and deletion commands

Role updates/deletion reuse the admin-locked audit/idempotency transaction and
require the current role revision. Edits preserve class/preset and reject invalid
member or pending-invitation overrides. Deletion rejects live references, clears
inactive membership/historical invitation references, and cannot remove Account
admin. Inbox-read loss schedules a separate reconciliation job per member.
Assignment activation still requires background role-aware eligibility checks;
the accepted job reason alone does not provide that parity. Validation: two role
lifecycle tests, 48 staff PostgreSQL regressions, backend-auth build/typecheck,
API typecheck and independent review with no actionable findings.

### Role command routes

POST `/api/identity/staff/roles` and PATCH/DELETE `/roles/:roleId` now expose the
reviewed role commands. All require active hotel-group Account-admin authority,
idempotency, strict fields, and revision for changes. Tenant/actor audit fields
come from authentication; class and preset fields cannot be supplied. Stale or
in-use changes return conflict. These routes do not assign roles to members.
Validation: 65 staff route tests, API typecheck and independent adversarial
review with no actionable findings.

### Inbox role-aware delivery permission checks

Provider actions, queued reply delivery, assistance, quick replies and direct
email now share a role permission reader after locking actor/organization scope.
It locks same-tenant definitions, verifies base identity and resolves live
defaults plus valid overrides. NULL references preserve legacy grants.
Validation: 86 PostgreSQL tests in five affected suites, 12 permission/delivery
unit tests and API typecheck. A queued reply loses delivery eligibility after
assignment to a read-only role and calls no provider. Independent review found
no actionable issues. Other Inbox mutation/assignment/reconciliation guards
still need parity before role assignment activation.

### Remaining Inbox command role checks

Reply, triage, internal notes and assignments now revalidate locked live Inbox
read/reply permissions. Mark-read requires only read. Assignment recipients must
have live Inbox read access and belong to the acting organization. Unit fixtures
now provide actual role fields; PostgreSQL staff fixtures use canonical manager
roles instead of a retired alias with no grants. Validation: 52 PostgreSQL tests
across four suites, 30 command unit tests, API typecheck and independent review
with no actionable findings. Reconciliation parity remains before assignment
activation.

### Inbox assignment reconciliation parity

Queued reconciliation now resolves locked live role permissions, clearing
assignments without Inbox read and retaining them when permission is restored
before execution. Existing member role/override saves also schedule reconciliation
for semantic permission changes. Status/product/property reasons retain precedence.
The safety sweep still discovers status/product/property losses; supported role
writers provide durable jobs for role/override changes. Validation: 11 PostgreSQL
worker tests including member-save-to-cleanup, 48 staff and two role regressions,
backend-auth build and API typecheck. Independent review identified the missing
existing-member enqueue path; fixed and confirmed.

### Saved member role reads

Member access reads include the tenant-scoped saved role definition and configured
permissions from its defaults plus individual overrides. Product, status and
property gates remain separate from this configuration. Role definition changes
invalidate the member access revision. NULL references preserve legacy behavior;
invalid referenced policies fail closed. Until the assignment-aware writer lands,
legacy access writes reject referenced members. Validation: 49 PostgreSQL staff
tests, 65 route tests, backend-auth build, API typecheck and independent review
with no actionable findings.

### Saved role assignment

Account admins can assign saved worker roles with member and selected-role
revision checks. The transaction verifies tenant, base role and permission
hierarchy against locked defaults, records the role reference in the audit, and
schedules Inbox reconciliation when the reference changes. Legacy fingerprints
and exact replays remain compatible. Referenced non-admin actors cannot use legacy
mutation paths until bounded manager authorization lands. Legacy invitation
acceptance rejects already-referenced members rather than overwriting their base
role. Validation: 53 PostgreSQL staff/role tests, 66 route tests, backend-auth build
and typecheck, API typecheck. Independent review found the manager and acceptance
activation gaps; both were fixed and confirmed. Invitation role configuration,
bounded managers, external owners and the Team UI remain pending.

### Invitation role configuration and acceptance

Invitation creation accepts a saved role reference with its expected revision,
validated against the same tenant and immutable policy. Referenced invitation
creation is Account-admin-only pending bounded manager support. Acceptance reads
live role defaults, validates individual overrides, and copies the reference
atomically. Existing referenced members stay protected from invitation overwrite.
Acceptance schedules Inbox reconciliation and records the reference in its audit.
Legacy invitation fingerprints and exact replays remain compatible. Validation:
52 PostgreSQL staff tests, 67 route tests, backend-auth build/typecheck, API
typecheck; independent review found no actionable issues. Resend configuration,
bounded manager support, external owners and the full UI remain pending.
