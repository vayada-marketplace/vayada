# Verified target owner setup composition (VAY-2017)

Stack prerequisite: reviewed identity #2297 and absence #2294 are integrated
without edits. `prepareLegacyOwnerSetupVerifiedTargetTransaction` is the narrow
internal entrypoint joining them; the older transaction/checkpoint helpers remain
lower-level primitives, never standalone runtime authorization.

Capture all request, identity, context, source, policy and absence inputs before
I/O. On one dedicated bounded READ COMMITTED client, retain an outer savepoint
and run protected database identity verification before approval/replay reads.
The required identity digest is independently approved context, not derived from
the submitted artifact; the signed command binds that same context. Environment
must also agree. No optional verification flag or callback exists.

Then reuse source/signature verification, current locked approvals, exact replay,
reviewed absence vs live PostgreSQL normalization/index checks, and atomic pending
users plus receipt. Failures roll back the whole composition; uncertain rollback
requires connection disposal. Success is still uncommitted and confers no access.
Caller retains locks and rechecks freshness immediately before outer commit.

This does not select/authenticate TLS endpoints or registered cloud resources,
establish historical source provenance, approve the eight-email scope, or provide
a CLI/production runner. Same-name/OID clones still need independent resource
fingerprints and trusted connection configuration. Tests use generated signatures
and synthetic current-source evidence, not actual ownership verification.

The new full-path fixture logs in directly as a non-superuser executor, separately
from the administrator creating schema/index/approval fixtures. It reads protected
attestor-owned evidence and cannot modify it. No SET ROLE executor substitution,
production grants, provider calls, memberships or active accounts are introduced.

## Integrated source-to-target synthetic rehearsal

The restricted target fixture now creates separate disposable Auth/PMS source
databases with column-limited direct LOGIN pools. It runs the actual scoped
reader and Ed25519 collector, then supplies those artifacts to the existing
signed-command, approval, target-identity, absence and pending-user transaction.
Synthetic clocks, keys, historical references and target evidence remain fixed
fixture inputs, not production attestations or authenticated historical provenance.

Tests check fresh source suspension/rejection/owner drift/privilege denial before
preparation, eight pending users with one receipt, outer rollback, retry and
same-transaction exact replay. An independent target observer sees no uncommitted
receipt; no organizations, memberships or external identities are created. No
COMMIT is exercised: durability/unknown-commit recovery remains a runner gate.
This does not revoke an already issued still-valid source attestation when a
source changes; such artifacts retain the existing bounded freshness contract.

Run against a disposable PostgreSQL16/17 cluster on loopback56634/56635 containing
fresh `vay2017_verified_target_test`, `vay2017_pipeline_auth` and
`vay2017_pipeline_pms` databases, setting `VAY2017_VERIFIED_TARGET_TEST_DATABASE_URL`
only to the first. The fixture refuses other endpoints. It is not a production
runner or the authorized isolated-restore rehearsal; all cutover gates remain.
