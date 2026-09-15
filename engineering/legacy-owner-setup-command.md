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
