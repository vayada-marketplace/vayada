# Pending-owner setup recovery (VAY-2017)

Companion to [verified preparation](legacy-owner-setup-identity-composition.md).
Recovery inspects an uncertain attempt; it does not retry preparation or grant
access. A missing COMMIT acknowledgement is not evidence of rollback. Discard
the uncertain writer connection; do not reuse its transaction or renew artifacts.

`inspectLegacyOwnerSetupRecovery` uses a separate dedicated, independently
authenticated pool with bounded acquisition. It resets any leaked transaction,
begins READ COMMITTED with bounded SQL/lock timeouts, verifies source/request
signatures and actual target identity, then locks current approvals before
reading the exact receipt. The original writer holds these same approval locks:
recovery waits for its completion or fails indeterminate on timeout. No returned
receipt can be the recovery client's own uncommitted preparation.

Capture protected inputs before I/O; preserve signer/executor policy and all
receipt fingerprints. Return only a restricted receipt or `no_receipt_observed`,
always executable:false, after successful rollback of the inspection transaction.
Missing receipts never invoke the checkpoint or authorize retries. Expired,
revoked, mismatched or inaccessible evidence rejects; historical audit of expired
commands needs a separate operation, not a recovery bypass. Cleanup failure
discards the connection and returns a fixed failure, never a success result.

This is an internal inspection entrypoint, not the full production runner. Trusted
endpoint/resource selection, historical provenance and policy configuration remain
runtime prerequisites. A matching receipt proves the recorded checkpoint, not
current user state, access or failover survival. Runtime COMMIT handling, final
freshness/durability settings and infrastructure recovery still need integration.
Tests use actual local commits plus an injected post-COMMIT error; they do not
simulate network packet loss, database crashes, replication or cloud failover.

The dedicated fixture selects `VAY2017_RECOVERY_TEST_DATABASE_URL` (never together
with the verified-target fixture URL), limited to loopback56636/56637 and database
`vay2017_recovery_test`. Create fresh sibling `vay2017_pipeline_auth` and
`vay2017_pipeline_pms` databases in the same disposable cluster. Commit-path rows
are retained until that exact synthetic cluster is removed; no history is erased.
