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
and versions under its own lock.

Approved offline recovery reads role OIDs, flags, memberships, settings and
ownership through `pg_roles` and the existing accessible catalogs. Production
inspection confirmed that its administrator has neither SELECT nor UPDATE on
`pg_authid`; recovery must not add those permissions or use its masked password
field as evidence. Before granting, a fresh connection must authenticate the
pinned credential as the exact session/effective login and OID. After the grant,
fresh primary and rollback connections prove the exact own-organization scope.
Repeat both fresh proofs and immutable-current secret readback immediately before
reacquiring current authority and exact assignment/xmin locks for readiness commit.
Network proofs run outside SQL transactions; the exclusive provisioning session
fence remains held throughout.

An ambiguous commit requires a fresh administrative connection and the same fence,
exact committed readiness/xmin observation, fresh primary/rollback authentication
and secret readback, then another exact authority/readiness observation. Missing
or failed evidence remains recovery-required. This proves approved credential
usability and authority at the observed checkpoints, not uninterrupted stored
password-verifier continuity. Uncoordinated administrator changes between the
last check and commit remain outside the provisioning lock protocol. The procedure
never rotates passwords, expands catalog privileges, or changes hotel facts or
product activation. Fixtures must run without catalog SELECT or UPDATE and cover
password, role-OID, authority/version drift and lost commit acknowledgement.

## Fresh automatic credentials without password-catalog access

The production `vayada_admin` cannot SELECT `pg_authid`. The online fixture's
superuser creator therefore does not establish production compatibility for
organization/property activation or secret publication. Keep fresh provisioning
disabled until the replacement and its real authority gate pass.

For newly staged candidates, bind activation to the exact frozen role OID,
canonical accessible `pg_roles` metadata, current Owner authority and pending
assignment. Commit generated-password LOGIN activation and that assignment
atomically. This path never resets an existing published credential.

Before create-only secret publication and again after exact pinned payload
readback, authenticate separate fresh primary and rollback connections. Each
must match both session/effective login and OID and pass its actual scoped native
proof. Require the sole immutable AWSCURRENT version, then recheck current
catalog identity, authority and pending assignment before readiness COMMIT.
Keep external proofs and SDK calls outside SQL row-lock transactions; retain the
coordinator and assignment fences throughout.

After a failed or uncertain committed activation/publication, preserve the
candidate for recovery inspection. Do not clear its password, delete its
assignment, retry a remote write, adopt it or provision a replacement. Pending
LOGIN is not disabled or revoked: it remains unavailable through the actual
serving credential providers because readiness is NULL. Prove that denial before
publication, after publication, and after each fault. No serving-success receipt
may be emitted for an uncertain outcome.

Owned PostgreSQL 16/17 fixtures must exercise the compiled modules with a
nonsuperuser creator lacking password-catalog SELECT/UPDATE and possessing only
the separately verified creation, ALTER, parent ADMIN and required grant
capabilities. Helper-owner authority remains separate. Production authority and
Owner Save/reload are independent gates; synthetic fixture success proves
neither. Observed fresh-authentication checkpoints do not promise uninterrupted
verifier continuity against uncoordinated administrative changes.
