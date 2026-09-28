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
product rows, pending Financials entitlement, idempotency, and audit; first
currency save atomically writes the setting, categories, entitlement state,
event/outbox evidence, idempotency, and audit. A second connection in the
middle is not equivalent. The Feature Hub command atomically changes the
entitlement and appends audit.

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
| Create property | `hotel_catalog.properties`, locations, contacts, optional source link; `identity.organization_resource_links` and Financials pending entitlement; optional Marketplace profile and Booking settings; idempotency and audit |
| First currency save | `pms.property_pricing_settings`; seven `finance.expense_categories`; only the pending property Financials entitlement; domain event/outbox, idempotency and audit |
| Owner Feature Hub toggle | Only the selected property's Financials entitlement and audit |

The exact grants must be derived from the final route SQL, including optional
branches and row locks. The current shared setup repository also serves reads
and unrelated profile updates from one pool. Route only enumerated commands
through the privileged boundary; ordinary reads must stay on the read
credential. A distinct pool inside the same API narrows accidental callsite
use but alone does not prove tenant or operation scope.

## Security decision before implementation

The command credential must not be able to mutate base PMS entitlements,
global suspensions, another module, or an unrelated property's Financials
setting. It must also be unable to create or edit an unrelated organization's
property, ownership link, Booking/Marketplace row, pricing setting, category,
idempotency record, event, or audit row. The existing entitlement RLS is
permissive for non-Finance worker roles, so table or column grants alone do
not prove this. Review a fixed-command SQL surface or an isolated internal
command service with independent original-session authorization and
transaction-time owner, base-entitlement, and activation-allowlist checks.
Its database privileges and RLS must cover **every** writable relation, not
only entitlements. A separate pool in the ordinary API is insufficient.

Review how the command boundary verifies the authorized organization and
property: a caller-supplied ID or session setting is not itself a trust
boundary. Require database-enforced scope and direct-SQL denial for other
properties. Until the full matrix is reviewed and passes, there is no grant
request.

Avoid making a pricing-prefixed setup role: migration `0422` intentionally
denies those roles direct Identity entitlement UPDATE. Do not weaken that
pricing guard. Keep existing Finance worker policies and product authorization
behavior intact.

## Required release proof

1. Review this command, role, tenant-scope and rollback contract before
   applying grants. Provision a distinct non-owner, non-inheriting login with
   no schema/database CREATE, BYPASSRLS, unreviewed definer execution, or
   unrelated writes or settable role memberships. Map only its named secret to
   the isolated command executor; fail closed if it is absent or equals the
   general runtime URL. Prove `SET ROLE` cannot escalate it.
2. On fresh and upgraded PostgreSQL 16 and 17 schemas, execute the real property-create, first
   currency, replay, rollback, and Owner off/on commands with the actual
   restricted test roles. Prove direct SQL cannot write any other property's
   rows in the full inventory above, forge the pending/ready marker, or mutate
   base/global entitlements. Test revocation between route authorization and
   command, existing-hotel activation denial, no partial writes on failure,
   replay, and no extra grants on the general API login.
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
