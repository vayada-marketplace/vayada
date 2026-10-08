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
ALTER DEFAULT PRIVILEGES IN SCHEMA <s>   -- for the executing migration owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vayada_next_api_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA <s>
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

| Relation                                                                                                                                                                                                                                                                   | Granted          | Why                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform.product_audit_events`                                                                                                                                                                                                                                            | `SELECT, INSERT` | append-only audit sink; no code updates or deletes it                                                                                            |
| `platform.domain_events`                                                                                                                                                                                                                                                   | `SELECT, INSERT` | append-only event log; no code updates or deletes it                                                                                             |
| `hotel_catalog.properties`                                                                                                                                                                                                                                                 | no `DELETE`      | no code path deletes a property; deleting one is unrecoverable                                                                                   |
| `booking.addon_revenue_evidence`, `pms.channex_offer_ari_receipts`, `pms.channex_offer_create_receipts`, `pms.channex_offer_target_versions`, `finance.commission_rate_changes`, `distribution.external_api_usage_events`, `finance.affiliate_percentage_policy_approvals` | `SELECT, INSERT` | insert-only evidence without database-enforced immutability (`finance.ota_commission_evidence` keeps `UPDATE` only because the API row-locks it) |

Default privileges are set by and for the executing migration owner, which the
grant task requires to own every product schema and relation. A table created
by any other role is not covered and shows up as `runtime_product_dml_missing`
until the grant mode is re-run.

Tables where the role's `UPDATE` exists only so row locks work (the API inserts
or reads them but never updates them): `pms.channel_rate_plan_mappings`,
`pms.channel_binding_claims`, `marketplace.affiliate_agreement_lifecycle_events`,
and the identity lock set below.

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
| `pms.channex_room_availability_attempts`, `pms.channex_room_availability_receipts`, `pms.channex_room_availability_reconciliation_attestations`, `pms.channex_ari_schedule_sources`, `pms.channel_sync_status`                        | yes                          | Channex management worker-only state                                                         |
| `booking.affiliate_referral_production_preflight_revocations`                                                                                                                                                                         | yes                          | revocation evidence with no API writer                                                       |

Name patterns are a safety net for future tables: in `platform`, anything
matching `^(production_|source_extraction_|legacy_|channex_adoption_|hotel_setup_|identity_migration_)`
is write-protected, and `^(hotel_setup_|identity_migration_|legacy_historical_binding_)`
or `^finance_.*_worker_properties$` is also read-protected (the Channex worker
allowlist stays readable: the API reads it today). Outside `platform`,
`^booking\.pricing_authority_`, `^pms\.channex_room_availability_`,
`^pms\.channex_ari_schedule_`, `^(marketplace|booking)\.affiliate_click_` and
`^finance\.expense_generation_` are write-protected. The grant task revokes by
list and pattern; the preflight asserts both.

## Identity: lock capability only

The ordinary API never writes identity rows; identity writes go through
`AUTH_DATABASE_URL`. It does take `FOR SHARE` / `FOR KEY SHARE` / `FOR UPDATE`
locks on six identity tables (the shared scope-lock clause in 13 files, the
onboarding draft path, pricing authorization, creator self-service), and
PostgreSQL requires an `UPDATE` privilege on at least one column for that.

- The grant task grants `UPDATE (created_at)` on `identity.organizations`,
  `identity.users`, `identity.organization_memberships`,
  `identity.role_permission_grants`, `identity.membership_property_assignments`
  and `identity.organization_roles` (platform #240 precedent, which granted
  `UPDATE (id)` on `hotel_catalog.properties` for the same reason). The audit
  timestamp carries no authorization meaning; every other column stays
  read-only for the login and a real `UPDATE` fails with SQLSTATE 42501.
- Why not the lock-only RLS pattern (0413/0421/0422/0446): the hotel-setup
  native preflights pin an md5 of every policy **and** trigger on exactly these
  tables (`hotelSetupCreationPrivileges.ts`, `hotelSetupCurrencyPrivileges.ts`,
  `hotelSetupLaunchSettingsPrivileges.ts`, `hotelSetupLogoPrivileges.ts`). A new
  policy or trigger would stop the live creation, logo and profile purposes
  until every pinned image is re-released, which is the protected-workflow
  churn this decision ends. Adding the policy stays possible together with the
  next hotel-setup digest re-pin. VAY-2056 decommission step 3 removes those
  preflights from the app, so the step-6 migration can add it
  ([hotel-setup-ordinary-login.md](hotel-setup-ordinary-login.md) §12).
- `identity.product_entitlements` and `identity.organization_resource_links`
  are product-link tables, not users, memberships or roles. They keep the
  VAY-965 setup-track column matrix and, in the product DML posture only, gain
  the columns the ordinary API really writes (human decision 2026-10-07):
  `product_entitlements` gets `INSERT (resource_product, resource_type,
resource_id)` and `UPDATE (metadata)` for Financials module activation
  (`routes/pmsModuleActivations.ts`) and the new-hotel Financials default
  (`platform/sharedHotelSetupStatusReadModel.ts`); `organization_resource_links`
  gets `UPDATE (status, updated_at)` for marketplace offer operator grant and
  archive (`platform/marketplaceOfferIdentityAccess.ts`). No `DELETE`, no other
  identity table gains a write, and the revoke scope restores the VAY-965
  matrix exactly. The matrix's `UPDATE (id)` on `organization_resource_links`
  is a live production grant that only serves locks; narrowing it to
  `created_at` is a candidate for the follow-up that re-pins the hotel-setup
  digests.

## What stays on SECURITY DEFINER functions

**VAY-2056 update (2026-10-08).** Hotel creation, profile edits, launch
settings, the first currency, Feature Hub Financials and the logo now run on this
login ([hotel-setup-ordinary-login.md](hotel-setup-ordinary-login.md)) with **no
new grant and no `SECURITY DEFINER` exception**: every hotel-setup definer function
is bound to its native login, so the Owner re-check runs in application SQL inside
each write transaction. The rule below is unchanged; the native hotel-setup
logins in "Who connects as what" retire with the VAY-2056 decommission steps.

Nothing moves. The role keeps **no** `EXECUTE` on any `SECURITY DEFINER`
routine (preflight `runtime_security_definer_execute_forbidden`). The guarded
affiliate commands (`marketplace.capture_affiliate_click`,
`booking.admit_affiliate_click`, `booking.bind_live_affiliate_original`,
`marketplace.consume_affiliate_click_quota`), the inventory coverage routines
and the hotel-setup scope helpers remain owner- or purpose-role-only.

## Accepted trade-offs

- `UPDATE (created_at)` is a real, low-value write on six identity tables
  (`identity.organization_roles` has no restrictive policy for this login);
  accepted until the next hotel-setup digest re-pin can add the lock-only
  policy.
- The revoke scope restores the legacy-permitted superset (required plus
  staged grants), not the exact live subset.
- The grant task grants `USAGE` on `identity` without an ownership check on
  that schema; the identity tables it touches are ownership-checked.
- The runner guard inspects the local checkout; the operator runs from `main`.
- The grant task runs the preflight's global posture checks (destructive
  privileges, foreign default privileges, SECURITY DEFINER execute, ownership,
  memberships, PUBLIC grants included) inside its transaction, so drift is
  never committed together with the grant.

## Preflight contract

`scripts/target-database-runtime-preflight.mjs` (platform) recognises two
postures from `pg_default_acl` for the migration owner in the seven product
schemas:

- **legacy**: no default privileges for the role; the historical allowlist is
  asserted as before, with one deliberate tightening: the no-read list, the
  name patterns and `vayada_migration_evidence` are unreadable in both
  postures (`pms.inventory_coverage_validation_queue` was only exempt from the
  required reads before). Production passed this read-only on 2026-10-07.
- **product DML**: default privileges exist in all seven schemas; the preflight
  then requires `SELECT, INSERT, UPDATE, DELETE` on every non-protected
  relation in those schemas (`runtime_product_dml_missing`), the narrowings,
  the protected list and patterns (`runtime_protected_relation_write_forbidden`,
  `*_read_forbidden`), the `created_at` lock column on the six identity tables
  (`runtime_identity_lock_column_missing`), no identity table-level writes and
  no identity column writes outside the matrix plus that lock column, zero role
  memberships, and all the existing posture checks.

A partial state (some schemas) fails closed
(`runtime_product_dml_posture_partial`). `--preflight-runtime-product-dml`
(env `VAYADA_DB_REQUIRE_PRODUCT_DML=1`) refuses the legacy posture; plain
`preflight`, which `tf-apply` runs, accepts both until a follow-up removes the
legacy branch.

## Transition plan (never breaks `tf-apply`)

1. App: merge this architecture note (no migration is needed).
2. Platform: merge the grant mode, then the preflight that accepts both
   postures, then the retirement of the per-incident modes. Every ordinary
   apply keeps passing because production is still in the legacy posture.
3. Operator Mac, `--profile vayada`: run
   `scripts/run-target-database-runtime-preflight.sh --inspect-runtime-product-dml`
   (dry run: applies, verifies, rolls back), then
   `scripts/run-target-database-runtime-preflight.sh --grant-runtime-product-dml`
   (owner-checked ECS task, migration-owner secret only). It applies the grant
   set, revokes the protected list, re-verifies, and commits or rolls back as a
   whole.
4. Run `scripts/run-target-database-runtime-preflight.sh --preflight-runtime-product-dml`
   (must PASS) and watch `/ecs/vayada-next-api` for `permission denied`.
5. Onboarding smoke: an original Owner saves "Present your hotel" through
   "Review" without a 42501.
6. Follow-up platform PR: drop the legacy branch from the preflight so the
   product posture is the only accepted state.

Rollback is `--revoke-runtime-product-dml`: it revokes the schema-wide DML,
default privileges and the identity lock column, and re-grants the legacy
allowlist, returning to the posture the legacy preflight branch accepts.

## Conventions for new tables

- A new product table needs nothing: default privileges cover it.
- A new protected-class table (credential scope, migration evidence, worker
  allowlist, guarded-command state) must be added to the protected list in the
  preflight **and** its migration should `REVOKE ALL ... FROM vayada_next_api_runtime`
  so the preflight never sees it writable. Prefer the existing name prefixes so
  the pattern net catches it anyway.
- A new identity table the API must lock is added to the lock list in the grant
  mode and the preflight (`UPDATE (created_at)` only); it never gets real
  identity writes through `TARGET_DATABASE_URL`.
