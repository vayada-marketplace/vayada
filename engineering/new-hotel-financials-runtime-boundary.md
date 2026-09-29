# New hotel Financials setup write boundary (VAY-1092)

_Review proposal, 2026-09-28. This document grants no privileges, maps no
credential, and activates no hotel._

## Decision requested

New PMS hotels should get Financials after their first currency save creates
seven starter categories. The Owner can then switch it off or on in Feature
Hub. Existing hotels keep their separate rollout path. App PR
[#2692](https://github.com/vayada-marketplace/vayada/pull/2692) implements that
behavior but remains draft: its admin-connection tests do not prove the live
restricted runtime can execute it.

Use a separately reviewed **hotel setup command boundary** for property
creation, currency setup, and the Financials Feature Hub command. Keep
`TARGET_DATABASE_URL` unchanged and do not grant its general API role
unrestricted `identity.product_entitlements` mutation. Do not reuse the
pricing, Identity, Finance worker, migration, or database-owner credential.

The implementation must preserve each existing transaction on one connection:
property creation atomically writes its canonical property, links, optional
product rows, idempotency, and audit; only a PMS-linked property gets a pending
Financials entitlement. First currency save atomically writes the setting,
categories, entitlement state, event/outbox evidence, idempotency, and audit.
Later currency edits use the same command path and also need its scoped
`pms.property_pricing_settings` UPDATE and existing blocker/revision checks. A
second connection in the middle is not equivalent. The Feature Hub command
atomically changes the entitlement and appends audit.

## Evidence and write inventory

A read-only isolated ECS task using the serving next API runtime secret
reported `current_user=vayada_next_api_runtime`. It had SELECT but no INSERT
or UPDATE on `hotel_catalog.properties`,
`identity.organization_resource_links`, `identity.product_entitlements`,
`marketplace.marketplace_hotel_profiles`, `booking.booking_settings`, or
`pms.property_pricing_settings`. It also lacked INSERT on
`platform.domain_events` and `platform.outbox_events`. It had category INSERT,
idempotency writes, and audit INSERT. No hotel data changed. This proves that
the live login cannot complete the proposed path; it is not a full ACL audit.

| Command | Intentional writes to inventory before granting |
| --- | --- |
| Create property | `hotel_catalog.properties`, locations, contacts, optional source link; `identity.organization_resource_links` and, only for a PMS-linked property, Financials pending entitlement; optional Marketplace profile and Booking settings; idempotency and audit |
| Currency save | `pms.property_pricing_settings` INSERT or guarded UPDATE; first save also writes seven `finance.expense_categories` and only the pending property Financials entitlement; domain event/outbox, idempotency and audit |
| Owner Feature Hub toggle | Only the selected property's Financials entitlement and audit |

The exact grants must be derived from the final route SQL, including optional
branches and row locks. The current shared setup repository also serves reads
and unrelated profile updates from one pool. Route only enumerated commands
through the privileged boundary; ordinary reads must stay on the read
credential. A distinct pool inside the same API narrows accidental callsite
use but alone does not prove tenant or operation scope. The PMS currency
repository also serves unrelated pricing mutators: isolate its currency
command rather than giving every pricing route the setup credential, and prove
those sibling routes keep their prior credential.

## Security decision before implementation

The command credential must not be able to mutate base PMS entitlements,
global suspensions, another module, or an unrelated property's Financials
setting. It must also be unable to create or edit an unrelated organization's
property, ownership link, Booking/Marketplace row, pricing setting, category,
idempotency record, event, or audit row. The existing entitlement RLS is
permissive for non-Finance worker roles, so table or column grants alone do
not prove this. Use an isolated internal command service that verifies the
original session itself, repeats owner/base-entitlement checks in the command
transaction, and holds credentials unavailable to the ordinary API. Native
database logins must be bound to their organization for property creation and
to their property for currency and Feature Hub commands. Database-owned
assignments and restrictive policies must cover **every** writable relation,
not only entitlements. A separate pool in the ordinary API is insufficient.

The existing pricing service proposal has a property-login precedent, but
does not provision one for every new hotel. This proposal also needs an
automatic lifecycle for organization login creation, property-login creation,
rotation, owner transfer, and rollback before it can meet the product promise
that every eligible new hotel gets Financials without an operator step.
Property creation is the bootstrap case: its organization login must already
exist before the first property command. Property creation must fail closed
if that provisioning is unavailable. A single shared setup
login, caller-supplied ID, or session setting cannot pass the direct-SQL
cross-organization denial test. Review this provisioning lifecycle and the
service's separate original-session verification before any grant request.

The base `hotel_catalog.properties` row currently has no organization column
and is inserted before its owner link. An organization login therefore cannot
be scoped on that first INSERT by the existing schema. Add a nullable
creation-organization reference for new setup-created properties; the setup
role's INSERT policy must compare it with a database-owned `session_user`
assignment. Give that role no UPDATE privilege on the reference and reject
changes to it through every setup command. This reference scopes the first
property INSERT only. Later property commands must use the current active
owner link and a current database-owned property-login assignment, so an
ownership transfer does not depend on the original organization. Legacy rows
may stay null, but the setup role must not create null rows or use another
organization's value.
Prove this with direct SQL from two organization logins before granting any
production privilege. If a column conflicts with catalog ownership, replace
it with an equally testable database-owned property reservation; a
caller-provided property ID alone is insufficient.

The current property-create SQL places the property INSERT and dependent
owner-link/product writes in sibling data-modifying CTEs. Their shared
PostgreSQL statement snapshot may hide the new property from a dependent RLS
policy. Split the base INSERT and dependent writes into successive statements
on the **same transaction and connection**, or prove an equivalent mechanism
with the real restricted-role command on PostgreSQL 16 and 17. The generated
property ID cannot conflict with an existing owner link, so remove the
owner-link `ON CONFLICT DO UPDATE` arms rather than granting the creation role
UPDATE that could reactivate a suspended link.

The command service must support both Owner-created hotels and platform-admin
provisioning. It verifies the actual admin actor and target organization for
the latter; it must not impersonate the target Owner. Provision the organization
login before its first property command and the property login before the first
currency command. If either provisioner fails, reject the affected command
without a partial Financials activation, surface a resumable setup state, and
reuse the same idempotency key on retry. On transfer, change the database-owned
active assignment in the ownership-transfer transaction. Every write policy
must check that assignment, including for an already connected session using
the old login; credential rotation alone does not terminate pooled sessions.
Serialize transfer and in-flight setup writes by locking the same assignment
or owner row in both paths; an unlocked policy lookup may see the old value in
a concurrent statement snapshot. Prove stale-session denial concurrently
with a new-owner command.

Property-scope RLS alone does not protect the pending-to-ready transition.
The property login could otherwise directly update its own Financials
entitlement to `active` or forge `newHotelFinancialsDefault=ready` without
saving currency or creating categories. Put that transition behind a
separate command capability unavailable to the ordinary property login; an
SQL function granted to that login is directly callable and cannot trust a
caller-supplied actor ID or session setting. The capability must verify the current currency,
seven starter categories, pending marker, owner, and billing state in the same
transaction, and only update the selected property's Financials row. Prove
direct UPDATE cannot forge ready, and that the isolated service verifies the
original actor before accessing the separate command credential. A direct
call using that credential must still fail for another property or invalid
transition. If this cannot preserve one transaction, keep auto-activation
blocked.

The Feature Hub command must reload and resolve current Owner permission with
the canonical team-role and override rules, property link, and base PMS
entitlement inside its write transaction. Activation must also recheck
billing/global suspension and the activation allowlist or completed new-hotel
marker there. Deactivation remains available during a suspension. Lock the
membership, role definition or grant, ownership link, and entitlement rows
whose revocation must serialize with the update. The current route-level check
is insufficient, and a second hand-written permission rule is not acceptable.
Currency commands also lock Identity rows with `FOR SHARE`, which needs UPDATE
privilege in PostgreSQL. Add setup-role-specific lock-only policies and prove
direct UPDATE denial on each locked relation; pricing-role policies do not
apply to the setup role.

Avoid making a pricing-prefixed setup role: migration `0422` intentionally
denies those roles direct Identity entitlement UPDATE. Do not weaken that
pricing guard. Keep existing Finance worker policies and product authorization
behavior intact.

## Required release proof

1. Review this command, role, tenant-scope and rollback contract before
   applying grants. Provision distinct non-owner `NOINHERIT` logins. A login may
   inherit only a reviewed, non-settable `NOLOGIN` scope role for its own command;
   it must have no schema/database CREATE, BYPASSRLS, unreviewed definer execution,
   unrelated writes, or settable role memberships. Map only its named secret to
   the isolated command executor; fail closed if it is absent or equals the
   general runtime URL. Prove `SET ROLE` cannot escalate it.
2. On fresh and upgraded PostgreSQL 16 and 17 schemas, execute the real PMS
   and non-PMS property-create, first and later currency, replay, rollback,
   and Owner off/on commands with the actual
   restricted test roles. Prove direct SQL cannot write any other property's
   rows in the full inventory above, forge the pending/ready marker, or mutate
   base/global entitlements. Test revocation between route authorization and
   command, existing-hotel activation denial, exactly one pending entitlement
   for PMS creation and none for non-PMS creation, currency blocker/revision
   behavior, no partial writes on failure, replay, and no extra grants on the
   general API login. Test provisioning absence, rotation, owner transfer,
   already-connected stale-login denial, admin-created PMS hotels without Owner impersonation,
   and recovery after a failed provisioner run. Test revocation between
   Feature Hub route admission and its locked command write.
3. Add an exact-role platform preflight for allowed and denied relation,
   column, function, and RLS access. Review the rendered primary and rollback
   task definitions and the immutable app image before deployment. Keep new
   Financials auto-activation unavailable until both the credential and
   preflight pass; do not silently fall back to the migration URL.
4. After reviewed deployment, use one synthetic new hotel: create it through
   the normal authorized route, save currency once, verify seven categories
   and Financials access, switch off/on as Owner, verify Front Desk and
   Housekeeping denial, and verify existing hotels remain unchanged. No real
   reservation or payment.

Related design precedent:
`engineering/pricing-runtime-role-boundary.md` distinguishes a dedicated
credential from a database-enforced write boundary. The same distinction
applies here.
