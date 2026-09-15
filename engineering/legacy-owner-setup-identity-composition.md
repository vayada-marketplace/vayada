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
