# VAY-965: separate fresh-role staging from helper ownership

Live protected inspection 37222554294 verified that the two helper functions are
owned by vayada_target_prod_user (OID 28700). That owner cannot create roles and
has no ADMIN membership on the setup scope role. Conversely the existing
vayada_admin bootstrap connection can stage roles but cannot grant these helpers.

Production operational CLIs must therefore use two secret-injected connections:
vayada_admin for fresh NOLOGIN role staging, and vayada_target_prod_user for
exact nongrantable EXECUTE edges on the two canonical invoker helpers. The owner
URL is validated against the fixed production host, /vayada_target_prod database,
principal and TLS shape; only sslmode=require is normalized to verify-full.
Neither credential is available to an ordinary serving task.

Create and commit the fresh disabled role before the owner connection grants
permissions, because another connection cannot observe an uncommitted role.
A coordinator connection holds advisory lock 8734516 in shared mode throughout
staging, owner grants and activation; the migration lock is exclusive. The owner
connection checks the coordinator's existing lock rather than reacquiring it.
Activation also takes a nonblocking shared session lock on its own connection
and checks the coordinator before altering the role. That same connection holds
the lock through native proof, secret publication and readiness commit; it does
not queue behind an exclusive migrator waiting on the coordinator.
Both commits distinguish attempted and confirmed outcomes; an ambiguous staging
commit stops before owner grants. Grant failures report nonsecret role OID/name,
phase and bounded catalog classification (unchanged, exact_granted, unexpected,
or unavailable). Deadlines and connection closure remain bounded.

Before granting, validate the exact returned role OID/name, disabled posture,
reserved scope prefix/membership (including only the expected ADMIN-only creator
edge, with no incoming inheriting or SET memberships), absence of assignments, both helper bodies/definitions/owners and ACLs.
After granting, preserve all existing ACL edges and every other catalog field.
Only then return staging success and proceed through the existing independent
primary/rollback native proofs and secret publication gates.

A grant, connection or uncertain-commit failure leaves the staged role NOLOGIN
and reports inspection required. Prefix detection prevents automatic adoption.
No password, assignment, published secret, hotel facts or product activation is
created by this intermediate phase. Existing activation rereads current owner
and scope authority before enabling a login or publishing credentials.

The separate platform change must grant the private operational execution role
access only to the existing owner SSM
parameter. The public service retains its present secrets and privileges. No
GRANT OPTION, role-owner membership or helper function body change is introduced.
Online setup stays disabled until this path has native PostgreSQL 16/17 proof,
immutable primary/rollback package proof and a reviewed deployment.

The protected offline readiness inspection, reader grants and approved legacy
backfill take the exclusive session lock on `8734516` on their administrative
connection. A live shared provisioning lock causes immediate refusal before
catalog inspection or grants. The backfill lock lasts through native proofs,
secret/version verification and readiness commit; uncertain-commit inspection
reacquires it on a fresh connection. Read-only inspection releases its lock before
Secrets Manager metadata reads; apply independently rechecks the frozen identities
and versions under its own lock. Role OID, flags, membership and verifier
checks remain exact catalog reads. They do not row-lock `pg_authid`, which would
require catalog UPDATE privileges unavailable to the production administrator.
No catalog write privileges are added.
