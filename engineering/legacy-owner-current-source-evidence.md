# Current source evidence for internal setup (VAY-2017)

Dependency of [the setup runner](legacy-owner-setup-command.md), not an access
decision. The September15 diagnostic retained no contacts and cannot supply
the exact protected values required here. No live read, signer or CLI is added.

One canonical JSON artifact per selected owner contains exactly:
`contractVersion`, `environment`, `sourceRunId`, `sourceLedgerSha256`, `ownerId`,
`hotelId`, `authDatabaseSha256`, `pmsDatabaseSha256`, `authObservedAt`,
`pmsObservedAt`, `sourceStatus`, `email`, `name`, `signingKeyId`.
Version is `legacy-owner-current-source.v1`. The exact source run/ledger, pair,
email and nullable name must match the signed setup command. No normalization.

This artifact attests both exact rows exist, Auth type is hotel, the PMS owner
matches, and its status/contact fields came from scoped live reads. A collector
must not issue it for missing/ambiguous rows, unknown status or changed ownership.
Only pending/verified source status is admitted for internal preparation; target
status remains pending. It does not attest legal ownership or email control.

Both observation times are exact UTC millisecond strings captured before each
independent live read, no later than command issuedAt. Their minimum must equal
that owner's command observedAt. The command's maximum15-minute window and
expiry apply. Do not substitute account updatedAt or signing time. These are
separate observations, not a cross-database atomic snapshot.

The command's currentEvidenceSha256 hashes canonical artifact bytes under UTF8
`vayada:legacy-owner-internal-setup:v1\0current-source-evidence\0`. Its detached
Ed25519 signature covers the same bytes under UTF8
`vayada:legacy-owner-internal-setup:v1\0current-source-attestation\0`.
Noncanonical payloads, unknown fields/domains/keys and altered signatures deny.

Independent trusted configuration pins the operation environment, both live
database identity hashes and public keys specifically authorized for live-source
attestation. Never derive them from the artifact or command. Snapshot collectors
and setup signers are not implicitly authorized source attestors. A signature
authenticates a trusted collector's statement, not its actual query execution;
reviewed collector endpoint/visibility/projection enforcement and secure signing
remain operational prerequisites. No production attestor key is introduced here.

The pure verifier first verifies the signed setup request, then exactly one
artifact per selected owner with no extras/duplicates. It returns no contacts
and executable:false. Errors are sanitized. The runner still needs historical
ledger and target artifact authentication, approved index scope, locked current
approvals, replay, fresh target checks and final expiry checks before any write.
Synthetic tests must cover altered bindings, status, keys/signatures, scope,
observation freshness and output privacy. This does not enable execution.

## Current-source read adapter

`readLegacyOwnerCurrentSources` reads exactly eight independently approved pairs
from separately pinned live Auth/PMS databases. Dedicated read pools must use
authenticated TLS/resource configuration outside request control. Name/OID checks
on each acquired client do not distinguish identically cloned databases.
Pool connection acquisition must have its own finite timeout; elapsed-time checks
reject late completion but cannot interrupt a hung connection attempt.
The helper resets a leaked reader transaction, begins a fresh REPEATABLE READ,
READ ONLY snapshot, applies bounded timeouts and a safe search path, and uses an
empty ID projection to retain ACCESS SHARE without table-wide SELECT grants.
It rejects RLS/inheritance/type/column-visibility drift before business reads.

Only scoped ID/type/status/email/name and PMS owner-association columns are read.
Missing/duplicate rows, restricted accounts or changed ownership reject without
partial contacts. Observation times precede snapshot acquisition; wall-clock
rollback/jumps and monotonic elapsed time are bounded. Both snapshots must finish
and roll back successfully before protected in-memory observations return;
uncertain cleanup discards the connection. No logs, signing keys, grants or DDL.
This is not a cross-database atomic snapshot, legal ownership/email-control proof,
signed evidence, a configured live collector or a production invocation.
