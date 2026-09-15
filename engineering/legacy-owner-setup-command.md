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
