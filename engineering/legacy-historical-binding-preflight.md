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
