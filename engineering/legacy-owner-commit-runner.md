# Pending-owner commit boundary (VAY-2017)

This internal transaction owner composes the existing
[verified preparation](legacy-owner-setup-identity-composition.md) and
[recovery contract](legacy-owner-setup-recovery.md). It is not a production CLI.
The trusted runtime must authenticate the dedicated bounded pool, historical
provenance, exact email scope and policy configuration before invocation.

Capture all protected inputs before acquisition, verify source/signatures, reset
leaked transactions, then begin READ COMMITTED with bounded SQL/lock timeouts,
safe search path, policy-filtered-read rejection and synchronous_commit=on.
Use the existing identity/approval/absence/checkpoint composition without optional
verification callbacks. Recheck locked approvals/receipt and source/command freshness immediately before COMMIT
while approvals and target locks remain held. No provider I/O or access grants.

Before COMMIT dispatch, failure means no commit was attempted: roll back and discard
if cleanup is uncertain. `NOT_COMMITTED` describes this attempt, not absence of
an earlier committed receipt. Once dispatched, any error or non-COMMIT command tag is
indeterminate. Discard that connection, never retry or automatically compensate,
and use the separate recovery inspector with the original evidence. A successful
acknowledgement reports committed checkpoint evidence, not current access or
continued evidence validity; do not turn post-commit expiry into a rollback claim.
Always discard this dedicated writer connection after the attempt so session
state and uncertain transactions never return to another caller.

Synchronous commit acknowledges local PostgreSQL durability under the deployed
server configuration. It does not prove storage durability, replication/failover
survival, or approval at every instant during commit. The runner checks validity
at dispatch; operational deployment and isolated-restore rehearsal remain gated.

The actual PostgreSQL16/17 fixture uses `VAY2017_COMMIT_TEST_DATABASE_URL`, restricted
to loopback56644/56645 and fresh `vay2017_commit_test`, with sibling databases
`vay2017_pipeline_auth` and `vay2017_pipeline_pms`. Run the existing
`legacyOwnerSetupCheckpoint.integration.test.ts` with only this fixture URL set.
Lost acknowledgement is injected after actual COMMIT, not simulated packet loss.
