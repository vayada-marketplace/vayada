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

This read does not yet supply an atomic-save revision, custom roles or product
settings; those are successor contracts. No new editor may save through it until
the atomic command and revision contract are delivered.

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
