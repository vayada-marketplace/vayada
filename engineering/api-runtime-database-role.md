# API runtime database role (VAY-2054)

_Architecture note, 2026-10-07. Records the human decision taken after the
VAY-965 investigation. The grant itself is applied by the platform repo's
owner-checked task; nothing in this document grants anything._

## Decision

The public TypeScript API keeps connecting as the separate, non-owner login
`vayada_next_api_runtime` (`TARGET_DATABASE_URL`). That login gets **ordinary
DML on the product schemas** in one reviewed change, and a **short explicit
protected list** it can never write (and in some cases never read). The
preflight that `tf-apply` runs checks the role posture and the protected list
and fails closed.

What this replaces: the per-table allowlist introduced with the credential
split (VAY-2017, platform `b0948b0`) and repaired one incident at a time since
(20 allowlist commits, 16 hand-written `--grant-*` runner modes, VAY-2038/2039/
2040/2041/2044/2045/2046, VAY-1543, VAY-965). The code assumes it can
lock-then-write: it locks 164 relations and writes about 230; the allowlist
permitted 13 locks.

Explicit non-decisions (need a product decision, not an incident):

- **No per-hotel database credentials** for the ordinary API. Row-level
  security is role-keyed everywhere (222 of 224 policies key on the login);
  tenant isolation stays in application SQL and route authorization.
- **No new hotel-setup native purposes or protected workflows.** The three live
  purposes (creation, logo, profile) stay as deployed.
- **No per-request RLS** (single login plus session-keyed policies). Separate
  decision later.
- The per-service least-privilege split for the identity runtime
  (`AUTH_DATABASE_URL`), the Finance workers, the Channex management worker,
  the pricing command service and the migration owner is unchanged.

## Who connects as what

| Connection                              | Login                                   | Writes                                                  |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `TARGET_DATABASE_URL` (this document)   | `vayada_next_api_runtime`               | product schemas; lock-only on identity                  |
| `AUTH_DATABASE_URL`                     | `vayada_next_identity_runtime`          | identity lifecycle, WorkOS webhooks                     |
| `TARGET_DATABASE_MIGRATION_URL` (child) | `vayada_target_prod_user` (owner)       | migrations, grants                                      |
| Finance expense / export workers        | `vayada_next_finance_*_worker`          | their queue, dispatch and ledger slices                 |
| Channex management worker               | `vayada_next_channex_management_worker` | Channex job, offer and ARI state                        |
| Hotel-setup purposes                    | `vayada_next_hotel_setup_*`             | the setup command transaction they were provisioned for |

## Grant set

Applied by `scripts/run-target-database-runtime-preflight.sh
--grant-runtime-product-dml` (platform repo), owner-checked, idempotent, one
transaction:

```sql
-- product schemas: hotel_catalog, booking, pms, marketplace, distribution, finance, platform
GRANT USAGE ON SCHEMA <s> TO vayada_next_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA <s> TO vayada_next_api_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA <s> TO vayada_next_api_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE <migration owner> IN SCHEMA <s>
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vayada_next_api_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE <migration owner> IN SCHEMA <s>
  GRANT USAGE, SELECT ON SEQUENCES TO vayada_next_api_runtime;
-- then, in the same transaction, the protected list below is REVOKEd and re-verified
```

Views and materialized views are covered by `ALL TABLES`. There are no
sequences in the target schema today (all keys are UUIDs); the sequence grant
is there so a future `serial` column does not start the incident cycle again.
`TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`, grant options, DDL, ownership,
role memberships, `BYPASSRLS`, temporary tables and `SECURITY DEFINER`
execution stay forbidden and are asserted by the preflight.

### Narrowings inside the product schemas

| Relation                        | Granted          | Why                                                            |
| ------------------------------- | ---------------- | -------------------------------------------------------------- |
| `platform.product_audit_events` | `SELECT, INSERT` | append-only audit sink; no code updates or deletes it          |
| `platform.domain_events`        | `SELECT, INSERT` | append-only event log; no code updates or deletes it           |
| `hotel_catalog.properties`      | no `DELETE`      | no code path deletes a property; deleting one is unrecoverable |

## Protected list

The role must never write these. "no read" means it must not have `SELECT`
either (table or column level, including PUBLIC or inherited grants).

| Relation                                                                                                                                                                                                                              | Read                         | Why                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `platform.hotel_setup_property_scopes`, `platform.hotel_setup_creation_scopes`, `platform.hotel_setup_linked_properties`, `platform.hotel_setup_reconciliation_cursors`, `hotel_catalog.hotel_setup_effective_creation_scopes` (view) | no                           | hotel-setup credential scope evidence, private to the setup authority                        |
| `platform.identity_migration_provenance`, `platform.legacy_historical_binding_transitions`                                                                                                                                            | no                           | migration before/after evidence                                                              |
| `platform.finance_expense_worker_properties`, `platform.finance_export_worker_properties`                                                                                                                                             | no                           | owner-managed Finance worker allowlists                                                      |
| `marketplace.affiliate_click_quota_windows`                                                                                                                                                                                           | no                           | state of the guarded affiliate quota command                                                 |
| `pms.inventory_coverage_validation_queue`                                                                                                                                                                                             | no                           | managed only by `SECURITY DEFINER` inventory routines                                        |
| `platform.legacy_owner_bootstrap_receipts`                                                                                                                                                                                            | `owner_user_ids` column only | legacy Owner bootstrap authority                                                             |
| `vayada_migration_evidence.*` (schema)                                                                                                                                                                                                | no                           | migration attestations                                                                       |
| `platform.schema_migrations`                                                                                                                                                                                                          | yes                          | migration ledger                                                                             |
| `platform.pricing_runtime_property_scopes`, `platform.channex_management_worker_properties`                                                                                                                                           | yes                          | owner-managed credential scope tables                                                        |
| `platform.legacy_owner_approval_records`, `platform.legacy_owner_approval_revocations`                                                                                                                                                | yes                          | approval registry                                                                            |
| `platform.channex_adoption_*` (6), `platform.production_*` (12), `platform.source_extraction_*` (3)                                                                                                                                   | yes                          | cutover and migration evidence                                                               |
| `booking.pricing_authority_heads`, `booking.pricing_authority_revisions`, `booking.pricing_quotes`, `booking.pricing_runtime_effective_*` (views)                                                                                     | yes                          | pricing authority and quote ledger, reserved for the pricing command service (VAY-1543)      |
| `marketplace.affiliate_click_occurrences`, `booking.affiliate_click_contexts`, `booking.affiliate_click_admissions`, `booking.affiliate_original_booking_bindings`                                                                    | yes                          | affiliate evidence; written only through the guarded `SECURITY DEFINER` commands (0417–0419) |
| `finance.expense_generation_dispatches`                                                                                                                                                                                               | yes                          | Finance worker discovery state, written by source-writer triggers and the worker             |
| `pms.channex_room_availability_attempts`, `pms.channex_room_availability_receipts`, `pms.channex_room_availability_reconciliation_attestations`, `pms.channex_ari_schedule_sources`                                                   | yes                          | Channex management worker-only state                                                         |

Name patterns are a safety net for future tables: in `platform`, anything
matching `^(production_|source_extraction_|legacy_|channex_adoption_|hotel_setup_|identity_migration_)`
is write-protected, and `^(hotel_setup_|identity_migration_|legacy_historical_binding_)`
or `^finance_.*_worker_properties$` is also read-protected (the Channex worker
allowlist stays readable: the API reads it today). The grant task revokes by
list and pattern; the preflight asserts both.

## Identity: lock capability only

The ordinary API never writes identity rows; identity writes go through
`AUTH_DATABASE_URL`. It does take `FOR SHARE` / `FOR KEY SHARE` / `FOR UPDATE`
locks on six identity tables (the shared scope-lock clause in 13 files, the
onboarding draft path, pricing authorization, creator self-service), and
PostgreSQL requires `UPDATE` privilege on at least one column for that.

- App migration `0475_api_runtime_identity_lock_only.sql` adds the existing
  lock-only RLS pattern (0413/0421/0422/0446) for `vayada_next_api_runtime` on
  `identity.organizations`, `identity.users`, `identity.organization_memberships`,
  `identity.role_permission_grants`, `identity.membership_property_assignments`
  and `identity.organization_roles`: a `RESTRICTIVE FOR UPDATE` policy with
  `USING (true)` and `WITH CHECK (current_user <> 'vayada_next_api_runtime' AND
session_user <> 'vayada_next_api_runtime')`. Row locks pass; any real
  `UPDATE` by the role fails with SQLSTATE 42501.
- The grant task then grants `UPDATE (id)` on those six tables (platform #240
  precedent) and refuses to do so unless the policy is present.
- `identity.product_entitlements` and `identity.organization_resource_links`
  keep the exact VAY-965 setup-track column matrix (`INSERT`/`UPDATE` on named
  columns); any column `UPDATE` already permits the locks. No lock-only denial
  is added there because `PUT /api/hotel-setup/tracks` really writes them.
- No other identity `INSERT`/`UPDATE`/`DELETE` is granted. The inventory found
  three call sites reachable from `TARGET_DATABASE_URL` code whose columns
  exceed that matrix (`platform/marketplaceOfferIdentityAccess.ts`,
  `platform/sharedHotelSetupStatusReadModel.ts`, `routes/pmsModuleActivations.ts`);
  they stay blocked until a separate decision moves them to the identity
  runtime or extends the matrix.

## What stays on SECURITY DEFINER functions

Nothing moves. The role keeps **no** `EXECUTE` on any `SECURITY DEFINER`
routine (preflight `runtime_security_definer_execute_forbidden`). The guarded
affiliate commands (`marketplace.capture_affiliate_click`,
`booking.admit_affiliate_click`, `booking.bind_live_affiliate_original`,
`marketplace.consume_affiliate_click_quota`), the inventory coverage routines
and the hotel-setup scope helpers remain owner- or purpose-role-only.

## Preflight contract

`scripts/target-database-runtime-preflight.mjs` (platform) recognises two
postures from `pg_default_acl` for the migration owner in the seven product
schemas:

- **legacy**: no default privileges for the role; the historical allowlist is
  asserted exactly as before.
- **product DML**: default privileges exist in all seven schemas; the preflight
  then requires `SELECT, INSERT, UPDATE, DELETE` on every non-protected
  relation in those schemas (`runtime_product_dml_missing`), the narrowings,
  the protected list and patterns (`runtime_protected_relation_write_forbidden`,
  `*_read_forbidden`), the identity lock-only policy on the six tables
  (`runtime_identity_lock_only_policy_missing`), no identity table-level writes
  and no identity column writes outside the matrix, zero role memberships, and
  all the existing posture checks.

A partial state (some schemas) fails closed
(`runtime_product_dml_posture_partial`). `--preflight-runtime-product-dml`
(env `VAYADA_DB_REQUIRE_PRODUCT_DML=1`) refuses the legacy posture; plain
`preflight`, which `tf-apply` runs, accepts both until a follow-up removes the
legacy branch.

## Transition plan (never breaks `tf-apply`)

1. App: merge and deploy `0475` (lock-only policies). Harmless before the
   grant: the policies only deny updates the role cannot make anyway.
2. Platform: merge the preflight that accepts both postures, then the grant
   mode, then the retirement of the per-incident modes. Every ordinary apply
   keeps passing because production is still in the legacy posture.
3. Operator Mac, `--profile vayada`: run
   `scripts/run-target-database-runtime-preflight.sh --grant-runtime-product-dml`
   (owner-checked ECS task, migration-owner secret only). It verifies the lock-only
   policy, applies the grant set, revokes the protected list, re-verifies, and
   commits or rolls back as a whole.
4. Run `scripts/run-target-database-runtime-preflight.sh --preflight-runtime-product-dml`
   (must PASS) and watch `/ecs/vayada-next-api` for `permission denied`.
5. Onboarding smoke: an original Owner saves "Present your hotel" through
   "Review" without a 42501.
6. Follow-up platform PR: drop the legacy branch from the preflight so the
   product posture is the only accepted state.

Rollback is `--revoke-runtime-product-dml`: it revokes the schema-wide DML and
default privileges and re-grants the legacy allowlist, returning to the posture
the legacy preflight branch accepts. It does not touch the app migration.

## Conventions for new tables

- A new product table needs nothing: default privileges cover it.
- A new protected-class table (credential scope, migration evidence, worker
  allowlist, guarded-command state) must be added to the protected list in the
  preflight **and** its migration should `REVOKE ALL ... FROM vayada_next_api_runtime`
  so the preflight never sees it writable. Prefer the existing name prefixes so
  the pattern net catches it anyway.
- A new identity table the API must lock gets the lock-only policy in its own
  migration and `UPDATE (id)` through the grant mode; it never gets real
  identity writes through `TARGET_DATABASE_URL`.
