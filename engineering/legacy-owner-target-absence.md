# Owner setup target absence (VAY-2017)

Narrow prerequisite of [the setup transaction](legacy-owner-setup-command.md).
Each selected owner supplies exactly one canonical JSON artifact with these fields:
`contractVersion`, `normalizationVersion`, `environment`, `targetDatabaseSha256`,
`ownerId`, `normalizedEmailSha256`, `emailScopeSha256`, `observedAt`,
`userIdPresent`, `userEmailPresent`, `externalUserIdPresent`, `externalEmailPresent`.

Versions are `legacy-owner-target-absence.v1` and `legacy-owner-email-index.v1`.
All four presence fields must be literal false. Unknown fields, duplicate/missing
owners or artifacts outside the selected command subset reject. Environment,
database digest and owner ID match the complete signed command exactly.
The eight-email scope digest comes from `planLegacyOwnerEmailIndex` using an
independently approved scope, never values taken from these artifacts.

Hash canonical artifact bytes with `hashLegacyOwnerSetupValue` under the
`target-absence-evidence` domain; compare to that owner's `targetBeforeSha256`.
The complete signed setup command authenticates this reference. No second signer
or generic attestation framework is required. This binds reviewed content, not
proof that an earlier SQL query occurred. `observedAt` is asserted metadata:
exact UTC milliseconds, no later than command issuance and no more than15 minutes
before command expiry. Renewing a signature cannot renew that observation.

Before any SQL, the transaction verifies the signed command and artifact content.
Exact replay still checks integrity and freshness but does not require current
absence. Without a receipt, the existing retained-lock target guard independently
checks absence across all identity providers, including unverified mappings, using
owner IDs/emails from the command. It returns each owner's PostgreSQL-normalized
email hash; compare the complete map with the artifacts before checkpoint writes.
Never use artifact hashes to select which identities to check. The existing index
catalog/visibility/collation checks remain mandatory and unchanged.

Matching digests do not authenticate the actual database connection. Independently
verified target identity, source evidence, approved email scope, runtime privileges
and commit-time freshness remain prerequisites. Reuse protected database-attestation
storage for the connection boundary; do not accept session settings as proof.
This slice adds no CLI, production execution, provider calls or access grants.

Validation covers valid artifacts, altered bytes, wrong scope/identity/version,
noncanonical payloads, missing/extra/duplicate artifacts, false-like values,
observation expiry, mismatched live normalization and replay after preparation.
Real PostgreSQL16/17 tests must exercise comparison before writes and rollback.
