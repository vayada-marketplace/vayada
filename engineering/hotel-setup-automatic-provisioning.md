# Automatic internal hotel setup — VAY-965

Implementation contract. This document grants no production authority. The
Owners enter their real hotel details; credential provisioning is internal work.
Predecessors: [atomic first Save](hotel-setup-initial-settings.md),
[native credential lifecycle](hotel-setup-command-credential-lifecycle.md), and
platform main `f80426ff29b95f0a3188df96c775788241938a1f`.

## Outcome and scope

An active hotel-group organization receives its native creation credential before
first Save. After the Owner saves a canonical property, the system prepares its
Hotel Operations credentials. No Owner must ask an operator to enable them.
This does not create hotel facts, choose pricing currency, activate a business
module, or complete the Owner's remaining product tasks.

Reuse the native role inventories and property stage/activation/publication
helpers. A bounded periodic reconciler discovers committed canonical scopes;
there is no privileged HTTP provisioner, new event bus or general job queue.
Missing readiness produces an uncached, recoverable setup-unavailable response
and preserves the Owner's current form, creation key and canonical property UUID.
The initial scheduling interval is five minutes; the UI explains preparation and
allows retry without duplicate creation. This is an internal wait, not an Owner
activation task.

## Discovery and authority

Discovery is a hint, never permission to provision. Find active `hotel_group`
organizations with a current active Owner who can manage shared setup. Include
Creator Marketplace-only groups for the shared creation capability. Property
discovery additionally requires the same organization's current active canonical
catalog/PMS owner links, persisted Hotel Operations selection and current product
access. Prepare only `launch_settings`, `currency_ready` and `feature_hub`, the
purposes consumed by current serving adapters. Do not stage unused `currency`
merely because the manual bootstrap supports it.

Do not infer the actor, organization or property from an email, client payload or
secret name. A bounded batch orders by immutable scope ID and takes a per-scope
advisory lock. Multiple qualified Owners are valid; choose a deterministic current
candidate for proof, using effective permissions and property scope rather than
requiring a unique Owner or trusting a raw role key. Before every staging,
activation and readiness commit, lock and
recheck current authority using the existing membership, property scope,
permission, entitlement, billing and suspension rules. A revoked Owner or changed
binding invalidates the attempt. Discovery must not silently substitute another
actor during a partly completed attempt.

## Per-assignment readiness

Add nullable `credential_role_oid`, `credential_secret_version` and
`credential_ready_at` to both native assignment tables. All three are absent for
a pending assignment and present together for a ready one. Only the isolated
publisher may write them; serving readers receive exact SELECT columns only.
Assignment `active` continues to support native proof and scope authorization;
it is not proof of publication readiness.

The private credential resolver requires a ready assignment matching its exact
organization, property and adapter-selected purpose. It checks the recorded OID
against the current native role identity and reads the immutable secret version
using `GetSecretValue(SecretId, VersionId)`. The exact two-field native secret
shape and verified TLS endpoint checks remain. Add a native-only, read-only
secret reader; do not change OAuth-vault latest-version behavior or introduce
secret-write methods into serving code.

Every native command still locks and checks current authority in its write
transaction. A resolver result is not authorization; a transfer/revocation after
resolution must deny the next command, including a pooled connection. The worker
does not rotate or transfer existing assignments. Those lifecycle paths retain
their separate drain, switch and recovery contracts.

Clearing readiness alone is not revocation: a request may already hold a native
URL. Property withdrawal clears readiness and sets `active=false` under the
assignment lock, then disables the exact verified role and terminates its sessions.
Organization withdrawal removes its assignment under the organization/assignment
locks and disables the exact verified role. A command already holding these locks
may finish before withdrawal; the next command must fail even if its credential
was resolved earlier. No cached URL or broad fallback is allowed.

## First publication protocol

1. Claim only a scope with no assignment and no earlier staged identity. Use a
   deterministic scope/purpose role prefix for organizations as well as properties
   so a lost staging COMMIT cannot spawn another role on the next sweep. Existing
   unready assignments or staged roles are inspection-required, not adoptable.
2. Stage a random disabled role with the exact native inventory and no readiness.
   Preserve its OID and scope. Activate its password/LOGIN and assignment in a
   guarded transaction; commit before opening the native proof connection.
3. Run actual primary and compatible rollback native preflights against the
   committed assignment, without any business command. Serving resolution remains
   denied because readiness is absent. A lost or failed proof leaves it denied.
4. Create a fresh native secret without overwriting an existing secret or version.
   Reread exactly the returned immutable version and compare its two-field value.
   Organization bootstrap must prove before publishing, unlike its current offline
   script. Secret prefixes and task roles remain separate by purpose.
5. In a new transaction, recheck locked current authority, exact role OID/password
   verifier and unchanged assignment. Store that secret version, OID and ready
   timestamp together. Commit is the admission point. Native proof and publication
   receipts alone do not admit the credential.
6. On any uncertain result, fail closed. Reconnect only to inspect this attempt's
   exact identity; never retarget, adopt, republish or remove another attempt.
   Known failure cleanup disables only the verified attempt, revokes its
   assignment and terminates its sessions. Ambiguous readiness COMMIT first
   requires inspection of the exact ready row; do not disable an admitted role
   blindly. Keep durable sanitized inspection evidence and stop retrying that
   scope automatically.

Ready scopes are skipped on subsequent sweeps after checking the current binding;
reconciliation never repairs or replaces them implicitly. A safe failure before
any identity is committed may retry. The deterministic staged prefix and existing
assignment provide durable failure detection; no duplicate property or role may
be created to make a failed step appear successful.

## Operational isolation and rollout

A separate main-only operational workflow performs two bounded ephemeral passes
using the existing disjoint organization and property native-bootstrap task roles.
Only its execution identity injects the administrative database credential and
pinned CA. Neither serving API can assume these identities. Add only exact native
prefix `DescribeSecret` where create-only publication needs it; no reader/token,
OAuth, unrelated secret or broad secret-write grant.

The online workflow shares the production mutation queue. Before administrative
writes, inspect every physical serving private task and prove it uses an approved
readiness-aware immutable image with the reviewed reader grants, secret reader,
primary/rollback contract and fixed endpoint. No older resolver may coexist with
online publication. A concurrent deployment must not change this condition during
the pass. The workflow never stops or updates a serving service. Schedule enable
requires a machine-operated protected environment; a human approval per run would
reintroduce the manual dependency.

The existing manual bootstrap keeps its blocked-caller/zero-private-task contract.
Do not delete those gates or add an online flag to bypass them. Before the first
readiness-aware cutover, block/drain once and explicitly prove/backfill only the
already approved organization assignments under the protected offline procedure.
Do not automatically adopt other existing identities. New runtime startup must
attest the readiness schema and exact reader ACLs before admission. Rollback while
online provisioning is enabled may use only an approved readiness-aware image;
disable/drain the reconciler before reverting to the older manual release.

## Verification and implementation slices

Keep review questions separate: this contract; readiness schema/resolver and
pinned secret reads; organization first-publication helper; property helper
readiness commit; bounded discovery/reconciliation; isolated platform runner; and
reviewed images/cutover. Each implementation slice links this contract and is
independently reviewed before the next release dependency is enabled.

Owned PostgreSQL 16/17 fixtures must prove organization and property first setup,
ready replay, no duplicate identities, pending serving denial, revoked authority,
cross-property/purpose denial, extra/missing/grant-option ACL rejection and actual
primary/rollback TLS proof. Inject failures after staging, assignment COMMIT,
proof, secret publication and readiness COMMIT; uncertain attempts must neither
admit unproved credentials nor duplicate or clean up a different identity.
Runner tests prove incompatible/draining private tasks and changed release state
prevent writes, and organization/property secret identities remain disjoint.
Resolve-before-withdrawal tests must prove the subsequent native command denies.

Finally exercise a test Owner's real Save/reload, automatic readiness and native
first currency, preserving Owner-off/billing/global restrictions. Production
rollout needs its separate reviewed release receipts. The two real Owners' later
Save/reload results remain acceptance work; local fixtures do not establish their
accounts as recovered.

## Restricted operator authority (RDS)

Superuser fixtures cannot show what the production operator may do. Read-only
protected inspections (platform runs 37436890909 and 37216169103) establish
the production shape that the online passes must work under:

- PostgreSQL 17.9. `vayada_admin` is `NOSUPERUSER CREATEROLE`, a member of
  `rds_superuser`, `NOBYPASSRLS`, and has no `pg_authid` SELECT or UPDATE.
- Roles it creates get no creator membership edge. Their parent-scope edge is
  recorded by the RDS bootstrap superuser. Vanilla PostgreSQL 16+ instead gives
  a non-superuser creator an ADMIN-only edge.
- Tables and the setup RLS helpers are owned by `vayada_target_prod_user`. The
  Channex RLS helpers are not PUBLIC-executable, yet the operator reads identity
  rows through those policies.

The helper-owner grant previously required the vanilla creator edge. Under the
RDS shape it would have stopped every automatic staging before activation. It
now accepts no incoming edge or exactly that single ADMIN-only creator edge.

`hotelSetupAutomaticRdsOperator.fixture.ts` mirrors this posture on owned
PostgreSQL 16/17. Only three whole statements borrow a fixture superuser role
to reproduce the RDS edge shape: fresh role creation, its parent grant and
LOGIN-password activation. The restricted operator performs every other read,
row lock, ACL grant, RLS-checked query and assignment write. Helper EXECUTE
grants go through the non-superuser owner connection. Native proofs
authenticate as the new role.

The required CI job runs the whole reconciler with primary and
serving-rollback (`3efb2195a`) proofs. Faults hit one hotel while an unrelated
hotel is in the same pass. Coverage:

- organization and property first setup, replay and serving admission;
- lost-before-COMMIT staging (the only retried case);
- lost staging, helper-grant, activation and readiness COMMIT acknowledgements;
- rollback proof failure;
- failed, lost and mismatched secret publication;
- Owner revocation before readiness, then reinstatement without adoption;
- cross-property credential denial and revoked-Owner command denial.

A helper-grant inspection aborts its pass by design. The next pass skips the
inspected scope and continues with other hotels. No case adopts or cleans up an
earlier identity, reads `pg_authid`, or creates a second role.

The fixture grants the operator broad grantable ACLs. This is an emulation, not
proof of RDS internals. Before enabling the schedule, a protected read-only
production inspection must confirm all of the following for `vayada_admin`:

- **Discovery and authority:**
  - SELECT on `identity.organizations`, `organization_memberships`,
    `membership_property_assignments`, `users`, `organization_roles`,
    `role_permission_grants`, `product_entitlements` and
    `organization_resource_links`, on `hotel_catalog.properties` and
    `organization_setup_track_intents`, and on `finance.billing_entitlements`;
  - UPDATE on at least one column of each row it locks;
  - EXECUTE on every function their RLS policies initialize, including both
    Channex helpers.
- **Assignment state:** INSERT/SELECT/UPDATE on
  `platform.hotel_setup_creation_scopes` and `hotel_setup_property_scopes`,
  and SELECT/UPDATE on `hotel_setup_reconciliation_cursors`.
- **Native grants:**
  - grantable column privileges for the creation, `launch_settings`,
    `currency_ready` and `feature_hub` inventories, plus grantable DELETE on
    `hotel_catalog.property_contact_channels`;
  - grantable CONNECT and schema USAGE.
- **Roles:** the ability to grant the setup scope roles and to alter roles it
  created.
- **Helper owner:** `vayada_target_prod_user` owns both Channex helpers.
