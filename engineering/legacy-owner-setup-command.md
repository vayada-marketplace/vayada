# Internal owner setup command (VAY-2017)

Wire contract for the [internal-only setup](legacy-owner-account-setup.md), not
an approved manifest or executor. No provider, membership or access operations.

The protected command is canonical JSON with exactly `contractVersion`,
`commandId`, `environment`, `issuedAt`, `expiresAt`, `targetDatabaseSha256`,
`sourceRunId`, `sourceLedgerSha256` and `owners`. Version is
`legacy-owner-internal-setup.v1`; environment is local/staging/preprod/production.
The whole canonical string is hashed with SHA256 after the fixed UTF8 prefix
`vayada:legacy-owner-internal-setup:v1\0command\0`. Use this derived digest as the
signature verifier's expected command digest; never copy the envelope's digest.
The eventual consumer must also match envelope command ID/environment/times.

`owners` contains one to eight entries, strictly sorted by owner UUID. Each has
exactly `ownerId`, `hotelId`, `userOrdinal`, `hotelOrdinal`, `userSha256`,
`hotelSha256`, `email`, `name`, `status`, `expectedTarget`,
`targetBeforeSha256`, `currentEvidenceSha256` and `observedAt`.
Status is literally `pending`, expected target is literally `absent`; name
is null or nonempty text, never fabricated. Email is preserved exactly, not
silently trimmed/lowercased; this initial format rejects surrounding whitespace.
Contact/name strings reject NUL and invalid Unicode; email length is at most 254,
name at most 256. Future inserts use issuedAt for both created_at and updated_at,
not legacy account timestamps. Unknown fields at either level reject, including activation,
email verification, passwords, memberships and provider identifiers.

Trusted context is supplied separately: environment, target database identity
digest and the independently approved eight owner/hotel source references.
Each selected entry must match that exact owner's hotel, source ordinals and
row hashes. Source run/ledger must match. The two protected QA/staging hotel IDs
are excluded, including from the trusted cohort. Source references are historical
only: matching them does not establish present ownership.

`targetDatabaseSha256` identifies a separately authenticated protected database
identity artifact; `targetBeforeSha256` identifies that owner's complete reviewed
absence/conflict evidence; `currentEvidenceSha256` identifies separately verified
current ownership/restriction evidence. These are references, not self-attesting
proof. The parser checks digest syntax/binding, not artifact contents, signatures,
provenance, SQL visibility or live state. Missing artifact verification blocks the
future consumer even if parsing succeeds. A newly signed hash of old snapshot
data cannot satisfy the current-evidence requirement.

All times are exact UTC millisecond ISO strings. Require observedAt <= issuedAt
<= now < expiresAt and at most 15 minutes from every observation to expiry. No
timestamp renewal or normalization occurs. Future locked checks must refresh
these observations and independently verify source contact values, target
absence, external-identity conflicts and PostgreSQL email normalization/index
coverage. JavaScript case-fold comparisons are not database collision evidence.

Parsing returns the protected command and digest with `executable: false`.
Errors are sanitized; never log commands or contacts.

`verifyLegacyOwnerSetupRequest` composes parsing with signature verification.
It derives the expected digest from the complete command bytes and also requires
exact envelope/command ID, environment, issuedAt and expiresAt agreement. A valid
signature over inconsistent metadata still rejects; signing a new envelope does
not renew expired command evidence. The result includes protected parsed values
and always `executable: false`, with fixed `LEGACY_OWNER_SETUP_REQUEST_INVALID`
errors. It does not read approval records, authenticate evidence artifacts or
acquire locks. The future consumer must pass these exact bound bytes/digest to
the locked registry check and reverify fresh evidence before any write.

## Final storage stage

`writeLegacyOwnerSetupCheckpoint` is an internal persistence primitive, not the
complete authorized executor. No runtime/CLI calls it. Its caller must first
authenticate evidence, verify the bound request and locked approvals, check
receipt replay and fresh conflicts, and hold the verified email-index/DDL guard.
Supplying syntactically valid audit hashes is not proof of those prerequisites.

It requires an outer transaction, reparses the protected command, and inserts
only the exact UUID/email/name rows with explicit pending status and issuedAt
timestamps. One SQL statement writes all selected users and their receipt. It
checks the returned rows before recording success; partial/skipped/changed
inserts or receipt failure roll back to the helper's savepoint. No upserts,
replacement IDs, organization/membership/provider writes or automatic commits.
On uncertain rollback the caller must discard the connection, not commit.

Receipt source evidence hashes canonical `{ledger, owners}` with contacts,
status, expectedTarget and targetBeforeSha256 omitted from each owner; all other
source/current references remain. Before-state hashes canonical sorted
`{ownerId,targetBeforeSha256}` entries. Their domains are the setup prefix plus
NUL, `source-evidence`/`target-before`, NUL. After-state hashes UTF8
`vayada:legacy-owner-internal-setup:v1:target-after`, NUL, and PostgreSQL's
`jsonb_agg(jsonb_build_object(...returned fields...) ORDER BY id)::text` bytes.
Fields are exactly id/email/name/status/created_at/updated_at, with both timestamps
rendered as UTC millisecond ISO strings independent of session timezone. These are storage fingerprints,
not evidence authentication. A duplicate command rejects here; approved exact
replay must be resolved by the future consumer before this insert-only stage.

# Write-time target absence guard (VAY-2017)

`lockAndCheckLegacyOwnerSetupTargets` is a guard, not an executable approval.
After independent database/evidence/scope authentication and approval locking,
the eventual executor resolves authorized exact replay before invoking it. A
dedicated READ COMMITTED transaction with nonzero lock and statement timeouts is
required. It retains SHARE ROW EXCLUSIVE locks on external identities then users
through the later checkpoint and outer commit. Acquisition uses NOWAIT and failure
immediately rolls back its savepoint, releasing partial locks: existing writers
use different table orders and must not deadlock with this guard. A rollback
failure requires discarding the connection. Successful acquisition blocks ordinary
identity writes and index DDL; production needs a reviewed short lock window.
Use the same connection throughout, never roll back to an earlier savepoint, and
roll back the entire transaction after any failure. Acquire no provider resources
or network responses while holding these locks.

The guard verifies the installed eight-email index and full RLS visibility,
normalizes command emails with PostgreSQL's exact index expression, rejects
duplicate/out-of-scope hashes, and checks existing user IDs, user emails and
external identity user IDs/provider emails regardless of status or verification.
It rechecks command expiry after waits. It neither authenticates evidence hashes
nor compares fresh evidence artifacts, grants access, writes users, nor implements
replay. The caller still must authenticate those artifacts and check expiry
immediately before the eventual write. Local synthetic PostgreSQL tests compose
this guard with the checkpoint and prove retained locks using blocking PIDs;
they are not production or complete executor evidence.

# Request/registry-before-receipt composition

`inspectLegacyOwnerSetupReplay` verifies the complete signed request and locks
current migration/security approvals before any receipt lookup. Callers must
first authenticate evidence artifacts, target database and trusted policy; this
helper does not implement those prerequisites. It requires the same dedicated,
bounded READ COMMITTED transaction used by later conflict checks and writes.
Immutable command/authority uniqueness makes same-command requests use the same
approval rows, serializing retries. Preserve those locks until outer completion.

It derives audit hashes from the exact envelope and configured executor principal
(canonical JSON under `vayada:legacy-owner-internal-setup:v1\0executor-principal\0`).
Receipt matching checks every command-derived fingerprint, exact owners, operation,
environment, checkpoint and intended after-state. It never infers completion from
current user rows or creates/repairs anything. A missing receipt still requires
evidence/target checks; a matching receipt returns only its restricted reference,
not permission to write or grant access. A caller can see its own uncommitted
receipt: the result alone is not proof of durability. Expired/revoked requests deny
even for a matching receipt; later historical audit access is a separate operation.
The helper rejects active receipt RLS and rechecks request expiry after reads.
Failure rolls back its own savepoint; the caller must roll back all, or discard the
connection if rollback failed. No runtime/CLI is wired and VAY-2017 remains open.

## Uncommitted transaction composition

`prepareLegacyOwnerSetupTransaction` captures protected inputs before I/O and
verifies current-source signatures before any SQL. In one caller-owned savepoint
it runs locked approval/replay inspection, then (only without a receipt) the
target/index guard and atomic pending-user checkpoint. Source/request expiry is
checked again before persistence and afterward; post-write expiry rolls back both
users and receipt. Exact replay returns the restricted receipt without requiring
the now-existing users to be absent. Errors contain no contacts or SQL details.

This is an internal composition, not the authorized runner: it inherits the
requirement to independently authenticate historical ledger/rows, actual target
database identity, reviewed target-before artifacts and the eight-email scope.
No boolean/callback can waive those missing runtime integrations. Reuse the scoped
historical source reader in a separate read-only transaction; do not read source
databases or call providers while target locks are held. Exact target identity and
before-state artifact contracts still need implementation before runtime wiring.

The caller owns a dedicated bounded READ COMMITTED transaction and must retain
all locks until completion, recheck freshness immediately before committing and
roll back the entire transaction on failure. Rollback failure requires discarding
the connection. A checkpoint result is uncommitted; a matching receipt can also
be visible inside the caller's own uncommitted transaction. Neither is proof of
durability, provider preparation, hotel access or production readiness.
