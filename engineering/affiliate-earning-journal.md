# Durable affiliate earning calculation journal

VAY-1510. Implementation boundary following [earning rules](affiliate-earning-settlement.md).
Finance owns this append-only calculation history, separate from existing payout
and payment-evidence records. A journal entry never authorizes a transfer.

The canonical journal key is property + booking + exact stay item. Do not include
creator/agreement/policy in that key: changing them must not open a second earning
stream for the same item. Retain that full scope in each record and reject scope
changes for an existing stream pending explicit reconciliation. Provider aliases,
group/item overlap and attribution corrections must be resolved before intake;
this slice does not discover aliases or move earnings between creators.

A trusted evidence resolver must establish exact scope, historical accepted policy,
classified amounts, completeness and a monotonically increasing positive safe-integer
revision from the canonical reconciliation projection. This is not raw provider
revision ordering or receive time. Hotel form input cannot supply verified evidence.
No real resolver or public route is wired in this slice.

The internal hotel-management command requires fresh context, Marketplace permission,
entitlement and persisted enabled-property owner/operator access even for replay.
Its input selects canonical item and source revision; no calculated totals or previous
balance are accepted. The resolver must authenticate and resolve that exact revision
through owning-domain boundaries and return null when unavailable. Resolve within
the transaction using consistent local records, not network calls or public flags.

Serialize by locked property scope. For a repeated source revision, same canonical
input digest returns its original journal result; changed facts conflict. Retain
keys indefinitely with journal history. A previously unseen older source revision
is rejected once a newer revision was recorded. Concurrent deliveries cannot create
duplicate revisions or compute against an obsolete previous total.

Load the previous calculated total internally and pass it to the pure calculator.
Append pending/review outcomes too: a newer unresolved revision must hide the older
calculated result as the current status without erasing its historical amount.
The next calculated revision compares against the last calculated total, not zero.
Consumers must inspect the latest overall outcome, never just the latest successful
calculation. Unavailable resolver results do not certify freshness; any future
eligibility consumer must also check current evidence/reconciliation readiness.

Store the normalized calculator input and digest, full outcome, source revision,
local journal revision and author/request time atomically in one append-only row.
An entry's correction is an amount difference, not a payment or offset instruction.
No payout, balance, creator agreement, rate-policy or provider record is changed.
No migration backfill or reinterpretation of legacy affiliate payouts is allowed.

Required verification: exact-revision replay after newer versions, conflicting facts,
stale revision rejection, concurrent duplicates/corrections, pending then recovery,
previous scope mismatch, fresh authorization on retry, immutable records and rollback.
