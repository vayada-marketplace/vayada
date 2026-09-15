# Team, roles & permissions: VAY-1439 implementation contract

Status: proposed extension; unresolved product choices are listed below. This
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
organization, validate the current admin again, and change old/new roles in one
transaction under a database-enforced invariant. Explicitly define the former
admin's resulting staff role and scope. Reconcile coarse WorkOS roles through
durable retryable work; provider events cannot restore the previous Vayada role.

## Product decisions still required

1. Agency manager: the mockup implies team management, while v1 forbids it.
   Recommendation: permit managing workers only, retaining admin-only billing,
   transfer, admin mutation and privilege/role ceilings.
2. Property owner: recommendation is the existing `external_owner` identity
   model with read-only defaults; its current defaults include operations writes.
   Do not convert existing owners or bypass delegation through a renamed staff
   role. Confirm the exact six view-only sections before seeding the new preset.
3. Role presets need exact section levels, not only counts. The ticket names
   sixteen sections but gives different counts without their mapping. Confirm
   Front desk/Housekeeping differences from v1, dashboard sublevels, financial
   and channel Edit meaning, and the former admin's post-transfer role.

## Implementation stack and evidence

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
Verify all sixteen sections in both products and direct APIs, including guest
contact ceilings. Browser coverage includes loading/error/retry, keyboard/mobile,
invite delivery outcomes, role overrides, product OFF, future property scope,
suspension, removal and transfer failure/replay. Mocked browser coverage is not
deployed proof; record deployed revision and bounded synthetic fixture cleanup.
The full ticket stays In Progress until shipped acceptance criteria are verified
and the user explicitly accepts it.
