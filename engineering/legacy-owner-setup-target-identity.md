# Owner setup target identity

VAY-2017; prerequisite for `legacy-owner-setup-command.md`, not an executor.

`verifyLegacyOwnerSetupTargetIdentity` consumes a strict canonical artifact:
`contractVersion=legacy-owner-setup-target-identity.v1`, environment, registered
`targetIdentitySha256`, exact databaseName and positive uint32 databaseOid.
The required independently approved digest is `hashLegacyOwnerSetupValue` with
kind `target-database-identity`. Never calculate the expected digest from an
untrusted command or submitted artifact. Verified setup context and its signed
command must bind the same independently supplied digest. No new signer system.

The caller opens a dedicated bounded transaction on an independently authenticated
connection. This helper uses a savepoint, fixes search_path to pg_catalog, retains
an ACCESS SHARE NOWAIT lock on the exact evidence table and reuses
`readDatabaseAttestationTable`. Missing/unsafe storage is denied, with no database
settings fallback. Protected environment/fingerprint and current_database/OID
must match. Failures are sanitized; rollback failure requires discarding the
connection. Keep the same client/transaction through subsequent target locks and
checkpoint; its result never authorizes preparation or releases access.

SQL does not prove an AWS endpoint, certificate or RDS resource ID. The trusted
runtime must select and authenticate the exact TLS endpoint and independently
registered resource binding outside request-controlled inputs. An identical
clone with the same database name/OID and copied fingerprint is indistinguishable
by this SQL. Provisioning a clone therefore requires a distinct trusted resource
fingerprint and approved connection configuration. This prerequisite remains
explicit and unimplemented here; no opaque hash is claimed as endpoint proof.

The protected attestor is the existing controlled database authority, not the
executor. No production grants, attestation rows, database settings, SQL migrations
or provider calls are created by this slice. Synthetic tests use a separate login
reader and the existing attestor-owned table contract on PostgreSQL 16/17.
