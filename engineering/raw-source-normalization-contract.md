# VAY-2042 raw source normalization contract

This is an additive contract for the isolated, real-row rehearsal. It does not change the applied VAY-1350 source-inventory revision or authorize production migration.

## Source boundary

The VAY-2043 verified, metadata-only inventory (Linear attachment `67321703-434d-412f-84fa-8442c3defec5b3a`, SHA-256 `eff705e7526160363618ad5550958d3a74ba066c77ffae2e15b366a16e2fb15e`) found exactly four legacy databases and 83 tables:

| Physical database   | Migration source | Tables | Raw staging schema             |
| ------------------- | ---------------- | -----: | ------------------------------ |
| `postgres`          | `marketplace`    |     16 | `migration_source_marketplace` |
| `vayada_auth_db`    | `auth`           |     13 | `migration_source_auth`        |
| `vayada_booking_db` | `booking`        |      7 | `migration_source_booking`     |
| `vayada_pms_db`     | `pms`            |     47 | `migration_source_pms`         |

The 77 `active` table entries in `packages/backend-migration/source-inventory.tsv` retain their existing target owner, fixture case, parity category, and retention disposition. The six additional PMS tables have **proposed** historical-only dispositions in `packages/backend-migration/raw-source-dispositions.tsv`. The two files together account for all 83 observed table names, but the extractor currently reads only `source-inventory.tsv` and therefore does **not** extract those six tables. Integrating the six dispositions into extraction and verifying their row counts/checksums is a hard gate before the real-row rehearsal; this contract alone does not preserve them. Neither `vayada_pms_staging` nor any `target_*` database is a legacy source.

The VAY-2043 inventory proves schemas and counts, **not** row values, owner relationships, account-status distributions, WorkOS links, or whether the nine public and nine archived automation sends overlap. The adapter must reject an unknown source table, column/type drift, unsupported value, ambiguous hotel owner, duplicate external binding, or unproven cross-system join before any domain writer runs. It must never manufacture an active state from table existence.

## Normalization boundary

`migration_source_*.snapshot_rows` holds immutable source JSON with run ID, source schema/table, ordinal, checksum, and snapshot identifier. The `migration_source_*` tables in `fixtures/cases/*/*.sql` are **normalized test inputs**, not raw dumps. Their synthetic IDs, WorkOS links, hotel ownership, and denormalized JSON cannot be copied from a single raw table. A normalizer must be bound to one verified extraction run and fresh target; only the target credential may write normalized inputs. Grouped counts/checksums and source-to-output provenance must be recorded before target-domain transforms.

First safe slice: `vayada_auth_db.public.users` → `migration_source_auth.users`. Copy only `id`, `email`, `name`, `type`, `status`, `email_verified`, `created_at`, and `updated_at` after validating their raw types and allowed status values. Set `workos_user_id` to `NULL` unless a separately verified identity link proves it. Never copy `password_hash`, token, OTP, recovery-code, or MFA material into normalized inputs. Preserve `pending` as pending: no organization membership, PMS access, or Marketplace entitlement follows from an Auth user row alone. Join and materialize those only after the canonical owner/property binding is independently proven.

The remaining domain adapters consume the same reviewed canonical owner/property mapping: Booking (`vayada_booking_db` plus booking records in PMS), Marketplace (`postgres` plus relevant PMS records), and PMS operations (`vayada_pms_db`). They must not derive a new hotel from a name/email match or duplicate an existing Channex binding. Finance, consent, audit, media, and retired-source dispositions remain governed by the source inventory and their target-domain contracts; this document does not silently promote snapshot-only records into target state.

Archived inbox prototype definitions/templates and public automation records are historical evidence only. The existing encrypted RDS source snapshot retains them, but row extraction does not yet. The extractor must preserve their rows under the approved rollback retention before rehearsal; do not load them as runnable schedules, templates, outbound queue entries, or sends. Compare public/archive send IDs and lineage before deduplication or parity counting. No provider call or message replay is part of normalization.

Production use remains gated on a fresh isolated rehearsal with the exact snapshot/target/run binding, source read-only and target-only writer privileges, PG16/PG17 tests, grouped parity, ownership/status checks, Channex uniqueness, finance totals, and public-PII checks. A metadata count is not a passed real-row migration.
