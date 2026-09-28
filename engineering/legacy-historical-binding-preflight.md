# Historical binding preflight

VAY-2017 pure preflight slice of [ownership restoration](legacy-pms-ownership-restoration.md).
It compares supplied evidence for one original hotel/Channex pair. It performs
no database read, signature verification, owner eligibility check or mutation.
Even matching inputs return `supplied_binding_matches_requires_owner_eligibility`;
this is not authenticated evidence, approval, current readiness or an executable
transition. Do not expose the helper as a request-controlled authorization gate.

## Input boundary

The separate expected input identifies the exact source run, original hotel,
source connection/external ID, source ordinal/checksum, canonical property and
claim/connection fingerprints. Observations contain all source connections
matching hotel OR external ID, all claims matching property OR external ID,
and all target connections matching property OR live/retained external ID.
The evaluator rejects extra/duplicate rows instead of filtering them away.

A future trusted reader must independently verify source environment/revision,
complete immutable ledger and raw checksums, canonical source/ownership links,
full physical target-row hashes and exhaustive competing-row enumeration.
Matching caller-supplied hashes cannot prove those facts. Missing rows omitted
by a caller cannot be detected by this pure helper. A future consumer must bind
all evidence to its distinct signed transition contract and reread under locks;
neither this preflight nor the owner-only envelope authorizes transition.

## Classification

Require one exact original source connection with a true source-active flag,
one exact historical migration claim, and the exact nonempty target connection
set. Every target connection must preserve the original external ID in retained
metadata, match the source run, and remain disconnected with null live external
ID. False source-active receives `source_inactive_requires_explicit_disposition`;
unknown flags fail closed. There is no inactive override in this slice.

Preserve the original pair and claim UUID. Reject mismatched source/run/hash,
claim state/source/provider/pair, connection sets, live bindings and either key
of the protected Next-native import-QA or shared staging pair. Do not reinterpret
hotel lifecycle status as connection activity. Seven synthetic source-active
shapes may match; the eighth source-inactive shape remains held independently
of later owner setup. No result activates room/rate/booking mappings.

Tests exercise supplied-data comparisons and immutability only, not PostgreSQL,
current owners or provider state. Schema-correct readers, fresh eligibility,
approvals, transition ledger/consumer, replay, revocation, compensation and
PG16/17 concurrency/atomicity tests are separate next slices. Clean-claim
adoption remains unchanged and continues rejecting every historical claim.

## Target-only snapshot reader

`readLegacyHistoricalBindingTargetSnapshot` now owns a dedicated pool client,
REPEATABLE READ READ ONLY transaction and rollback/release. It takes ACCESS SHARE
table locks before requiring whole-table SELECT and disabled RLS on properties,
claims and connections. This prevents partial privileges or policy-filtered rows
from masquerading as exhaustive evidence and holds relation definitions stable.
Locks do not fence GRANT/REVOKE. Binding fingerprints compare the visible column
list with unfiltered `pg_attribute` names before explicitly SELECTing every
column; privilege loss cannot silently turn a full-row hash into a partial hash.

It reads `profile_status`, `claim_state` and `claim_source` directly and returns
all Channex claims matching property OR external ID, and all Channex connections
matching property OR live external ID OR retained legacy external ID. Other
providers are outside this Channex-only set. No LIMIT, status filter or matching
row selection hides competing history. Empty sets remain empty; missing property
fails. Full physical-row fingerprints reuse the existing lossless normalization;
only typed identifiers/statuses and hashes leave the reader, never raw metadata.
Malformed retained identifiers and unsupported/lossy JSON values fail closed.

Output rows/arrays are frozen. The snapshot does not establish property
eligibility, ownership, source provenance or approval. Source observations must
be independently verified; combining them does not make two reads atomic. A
future executor needs its own locked combined verification, not cached output.
Synthetic tests use parent-migrated disposable PG16/17 databases; no production
read, provider call, claim transition or clean-adoption boundary change is added.

## Immutable connection source proof

`readLegacyHistoricalBindingSourceProof` owns a separate read-only repeatable-read
snapshot over source ledgers/staging only. It binds run, environment, inventory
revision, recomputed ledger hash and hashed PMS snapshot tag to independently
authenticated expected evidence. It does not verify a signature itself; an
untrusted caller choosing its own expected hashes gains no authority.

Use a dedicated, independently authenticated pool with bounded acquisition. The
reader rolls back any leaked transaction before opening its snapshot, fixes its
catalog search path and sets nonzero lock/query timeouts. Policy-filtered reads
reject rather than silently hiding evidence. All seven relations must be ordinary
tables without RLS or inheritance; relation locks retain that representation.
These controls do not turn historical records into live ownership evidence.

It uses the real default PMS snapshot reader and its identity/inventory validator:
four-source/table ledger completeness, source aggregates, tag/ordinal continuity
and raw PostgreSQL JSON row/table checksums are recomputed. Source table is fixed
to `pms.public.channex_connections`. Exact connection UUID, ordinal, checksum,
original hotel/external pair and a real boolean activity value must match.
Hotel OR external-ID enumeration rejects missing or competing connection rows.
False activity is retained for the preflight's explicit inactive hold, not
converted to true or treated as automatic transition eligibility.

Only frozen identifiers, hashes and boolean source state are returned. Source
proof neither verifies hotel-owner identity nor consults mutable canonical state.
Source/target readers still take separate snapshots; a locked combined verifier,
fresh owner eligibility and distinct signed transition authority remain unwired.

## Evidence-only assessment composition

`readLegacyHistoricalBindingEvidenceSnapshot` assembles one original-pair
assessment from the actual source and target readers and the existing evaluator.
Its expected input contains the source-proof request, binding expectation and
property fingerprint. The caller must independently authenticate that entire
expected input and configure the correct source/target pools; this composer
implements no authentication, signature, trusted flag, approval or environment
attestation. Do not expose it as a request-controlled authorization endpoint.

It clones expectations before awaiting, rejects inconsistent source/run/pair
or property identities and protected keys before reads, and compares the full
property fingerprint in addition to claim/connection fingerprints. Returned
reader observations are retained exactly, without filtering competing rows.
The result is frozen and always `executable: false`, including a matching
assessment. Inactive-source and protected-fixture denials remain unchanged.
Reader failures propagate; they cannot become an absent-row fallback or match.

This is diagnostic assembly before a distinct signed transition verifier, not
a current-owner check or atomic source/target snapshot. Both readers still own
separate read-only transactions. Fresh canonical ownership/eligibility, signed
transition authorities, revocation and combined locked revalidation remain
required. No clean-adoption consumer, provider, writer or runtime route is wired.
Composition tests mock reader modules and use the real evaluator; they do not
add PostgreSQL or production evidence beyond the separate reader suites.
