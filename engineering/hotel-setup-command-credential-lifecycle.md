# Hotel setup command credentials (VAY-1092)

_Review contract. No service, login, secret, grant, or hotel is activated by this file._

## Scope

The ordinary API keeps its current `TARGET_DATABASE_URL` for reads and unrelated
commands. A private hotel setup command service verifies the original WorkOS
session and current Vayada authorization itself. It accepts only the existing
property-create, currency-save, and Owner Financials-toggle contracts. It has
no generic SQL or impersonation endpoint. The ordinary API forwards the
original bearer token and a fixed internal authentication token, never a
claimed actor, organization, property scope, or database URL.

The private service selects a native PostgreSQL login from a database-owned
assignment after it verifies the actor. An organization-bound login creates a
property; a property-bound login saves currency. Financials activation and
Feature Hub changes need separate capabilities unavailable to that currency
login. The login is checked again on the same connection inside each write
transaction.
The required table policies and direct-SQL denial matrix are in
[new-hotel-financials-runtime-boundary.md](new-hotel-financials-runtime-boundary.md).

## Provisioning

### Disabled reader role staging

`stageHotelSetupReaderRole` is the first reader-only provisioning step. A separate
provisioner supplies explicit administrative connection configuration; the helper
opens and closes its own connection and transaction. It creates the fixed reader
with `NOLOGIN`, no password or parent-role memberships, current-database CONNECT and only the
canonical reader/audit column grants. Existing roles are rejected without adoption
or repair; a failed grant (including PostgreSQL insufficient-grant warnings) rolls
back role creation and every grant. It changes no
assignment, secret, hotel or PUBLIC privileges. This is not complete credential
provisioning: inherited/PUBLIC access, ownership and exact catalog checks, verified
TLS native authentication, password/secret publication and activation remain
separate release gates. PostgreSQL may grant the role's creator administration rights;
that is provisioner control, not a parent role inherited by the reader. Ambiguous
transport/commit outcomes require inspection of the still-disabled role; never
adopt or activate it on retry. The service never receives the admin credential.

### First reader login verification

A separate provisioner retains the role OID returned by successful staging; it
must not look up a new OID by name on retry. It may activate only that exact role
OID, with NOLOGIN, no password, safe attributes, no parent memberships or object
ownership. This is first setup only, not rotation or adoption. Hold the reader
activation advisory lock through commit and the actual native TLS preflight;
the reviewed release window must exclude other administrative role changes.
Set the supplied random password and LOGIN in one transaction, then use the
real native reader preflight after commit. No secret is published by activation.
On failure, disable and clear only the same OID with the exact password verifier
this attempt installed. A changed role/verifier or unavailable connection
requires inspection; never repair or disable another attempt's credential.
Only success allows the separate secret-candidate helper to run. Secret
publication, rotation, current live IAM and service release remain separate gates.

### Verified reader secret candidate

A separate provisioner may call `stageVerifiedHotelSetupReaderSecret` only after
reader password setup and LOGIN activation have their own reviewed proof. It
reuses the real TLS/native reader preflight and requires the exact live reader
container to have no versions, including deprecated versions from
`ListSecretVersionIds(IncludeDeprecated=true)` with no unexamined next page.
The helper creates a separate random
`hotel-setup-command/prod/reader-candidate/<uuid>` container, stores the raw URL,
and reads back its exact immutable version before returning non-secret references.
The OAuth vault JSON-encodes values and updates the live secret; it cannot implement
this raw ECS-injected URL contract.

[AWS automatically labels the first version AWSCURRENT](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html),
even when custom stages are supplied. Therefore this candidate must be separate
from `hotel-setup-command/prod/reader-database-url`. Private execution/task IAM
permits only the exact live injected secrets and native purpose prefixes; it must
have no access to the candidate prefix. Candidate creation is not publication.
The helper never writes or relabels the live reader container, changes a database
login or service mapping, or deletes/retries an uncertain candidate. Inspection is
required after an uncertain write. The provisioner supplies its own admin Secrets
Manager client; no writer is wired into the command service. Copying the verified
value into the live container, credential lifecycle, exact live IAM, private
readiness and release approval remain separate gates.

The private executable is `npm --workspace vayada-api run start:hotel-setup-command`
(default port 8011). It requires its own `HOTEL_SETUP_COMMAND_*` configuration;
it cannot use `TARGET_DATABASE_URL` or the ordinary API's WorkOS configuration.
Its reader/assignment credential must name `vayada_next_hotel_setup_reader`, use
TLS `verify-full`, and target the same host/database as the password-free command
endpoint. Startup rejects role membership, ownership, inheritance and elevated
role attributes. This role-posture check is **not** an exact ACL preflight.
The launcher also checks effective column privileges (including PUBLIC/inherited
grants), matching only the columns used by canonical session/authorization,
registry and Feature Hub readers. The only permitted write is column-limited
rejected-permission-override audit INSERT, with audit-key/product SELECT for the
canonical conflict clause. Entitlement, registry, currency and business writes
are forbidden. CREATE, destructive table privileges (including PG17 MAINTAIN),
sequence access and application SECURITY DEFINER execution are rejected.
The companion audit preflight pins the full reviewed policy set, invoker
predicate and audit trigger bodies on PG16/17. Audit grants alone are not
permission to release: exact live RLS, credentials and IAM still need proof.
The reader's restrictive audit policy must permit only the canonical
`identity.staff.permission_override.rejected` INSERT: organization scope, the
actor's own current active membership in that organization, fixed security and
confidential labels, no private or linked business evidence, and the exact
redacted issue-code/request metadata shape. It grants no login or privilege.
Only matching rejection-audit keys are readable for the canonical repository's
`ON CONFLICT DO NOTHING`; audit UPDATE/DELETE stays denied. Existing callers keep their
policies. Startup must reject missing/changed RLS and INSERT-trigger definitions;
the local real-repository test must prove successful rejection audit, conflict
replay, cross-membership/organization and other-action denials, with no
Financials or pricing side effect.
The original actor comes from the private service's verified WorkOS context.
This shared reader's database policy checks membership/organization consistency;
it does not cryptographically bind an audit to a WorkOS token. Its audit INSERT
cannot authorize or invoke a business command.
Before release, platform must review/prove its exact canonical authorization,
entitlement and assignment reads. Canonical authorization also appends rejected
permission-override audit events; preserve that narrow rejection-audit contract
without granting entitlement, registry or Financials writes. Missing audit access
must fail closed. No reader role or grant is provisioned by this launcher.
Secrets Manager access is `GetSecretValue` only within the reviewed setup prefix;
the command adapters receive no secret-write methods. Exact live ACL/RLS/IAM,
private ingress, primary/rollback tasks and credential provisioning remain release
gates. Feature Hub writes use only the native purpose-specific command adapter;
the reader repository's general entitlement writer is never wired into this service.

1. A separate provisioner accepts only a command authenticated by the private
   service and independently checks the current database-owned organization
   or property assignment. It does not accept a caller-supplied login name or
   SQL. Its admin credential and Secrets Manager write permission are
   unavailable to the API and command service.
2. For an active hotel-group organization, create a random, non-owner
   `NOINHERIT NOBYPASSRLS NOCREATEROLE NOCREATEDB` login whose name matches
   `vayada_next_hotel_setup_org_*`. Grant only the reviewed non-settable
   `vayada_next_hotel_setup_scope` membership and exact command ACLs. Store
   its assignment in `platform.hotel_setup_creation_scopes` and its password
   in an organization-scoped secret. Reject unexpected existing roles, memberships,
   object ownership, default privileges, `SET ROLE` capability, and grants.
3. After property creation commits, create a distinct
   `vayada_next_hotel_setup_property_*` login. Bind it to the current active
   PMS owner and property in `platform.hotel_setup_property_scopes`, grant only
   the reviewed non-settable property scope membership and command ACLs, and
   store its password in a separate secret. Do not infer scope from a secret
   name or a client-provided property ID.
4. The command service obtains only the selected login's secret. It checks
   `session_user = current_user`, the expected role name, the database-owned
   assignment, current Owner link, and exact relation/function privileges
   before writing. Missing secret, mismatched assignment, unsafe role, failed
   preflight, or a URL equal to the general API URL returns a resumable setup
   failure. There is no fallback connection.

The first currency command needs a second property-bound login with the
currency/category permissions and a distinct readiness capability. That login
runs the currency, category, and pending-to-ready writes on one connection and
one transaction. The ordinary property login cannot use the readiness
capability. The assignment schema must allow one active login per property and
operation class, including a separate Feature Hub class, without allowing any
login to cross properties. The readiness login's own direct SQL still cannot
complete an invalid transition.
The first-currency transaction also keeps the existing idempotency reservation,
pricing source event/outbox, currency audit, and Financials activation audit.
A standalone database function that can activate from an existing currency row
or skip those records is not a valid replacement. The database boundary must
check the same supported currency vocabulary as the PMS command.
Do not make the first currency command a two-connection workflow.

Provisioning is idempotent for the same immutable organization or property
assignment. A retry may finish a partly created role or secret only after
checking every existing attribute; it must not adopt an arbitrary role or
retarget an existing login. A property-create retry reuses its original
idempotency key. The property stays pending until its currency command and
Financials readiness transition succeed.

## Rotation and transfer

Rotation must keep setup commands blocked for the affected assignment until the
replacement has passed its native check:

1. Block new commands and drain in-flight commands. Create a new random login
   and secret; verify its attributes, exact privileges and denials while its
   assignment is inactive.
2. Lock and recheck the current assignment and Owner link. In one transaction,
   deactivate the old assignment, activate the new one and commit the switch.
3. While commands remain blocked, run the positive exact-scope preflight from
   the replacement's actual native service connection. A different connection
   cannot see an uncommitted assignment; an admin connection cannot substitute
   for native `session_user = current_user` proof. Unblock only after success.
4. On failure, keep commands blocked. A compensating transaction may restore
   the prior assignment only after locking and verifying that the replacement
   is still the expected active assignment and current ownership is unchanged.
   If either has changed, require recovery against the current owner instead.
   After a valid restore, require the old login's native preflight to pass
   before unblocking. Do not treat a secret rollback as assignment recovery.
5. Only after the replacement is active, its native preflight succeeds and old
   connections drain, disable and retire the old login. A successful recovery
   must retain the restored old login; retire the failed replacement only under
   separately reviewed cleanup. Secret replacement alone cannot revoke a pooled
   session.

The separate provisioner must enforce and test this command block, switch and
recovery procedure; this contract does not implement it.

Ownership transfer changes the current owner link and active property-login
assignment in one transaction. Both transfer and setup commands lock the same
assignment and owner rows. An already connected old login must fail its next
command, including a command racing with transfer. A new owner receives a new
login and secret; the old organization's creation login never gains the
transferred property's command scope.
Keep affected setup commands blocked through the transfer and the new owner's
post-commit native preflight. A failed check must not restore the former owner's
access after ownership has changed.

## Activation and release gate

The property login may save currency and insert the seven starter categories,
but cannot directly write `identity.product_entitlements`. The pending-to-ready
transition needs a distinct capability, unavailable to that login, which
checks current currency, all seven unarchived system categories, pending marker,
current Owner link, base PMS entitlement, billing status, and global suspension
in the write transaction. It updates only that property's Financials row.
Revocation of an existing entitlement or billing row and insertion of a new
suspension must serialize with this check. Use a shared lock protocol that both
the command and those mutation paths obey, and test both commit orders; a
serializable snapshot taken before a conflicting lock is not enough.
The native setup scope takes the organization's `FOR UPDATE` lock before
entitlement checks, serializing FK-backed entitlement inserts. Locked reads of
existing entitlements must also serialize their revocations. The scope requires
`READ COMMITTED` so checks after a wait see committed changes; older-snapshot
isolation fails closed. Hold that
lock through the complete command and test both commit orders before release.
The private service must reverify the original actor before invoking it. A
separate property-bound Feature Hub capability must update only that property's
Financials entitlement and append its audit in one transaction; neither
currency login can directly toggle it. Inside the transaction, reload and
lock the current membership, canonical role/override permission, active Owner
link, base PMS entitlement, billing/global suspension, and selected Financials
row. Do not rely on the route's earlier authorization snapshot. The isolated
service supplies the verified actor identity; no SQL function trusts an actor
ID or session setting supplied by its caller.

Reuse backend-authorization's canonical role-permission resolution for those
locked rows, including saved team-role defaults and membership overrides. Its
pure result does not authorize a command by itself: the transaction must also
check product access, property assignment, owner links and entitlements. Invalid
configuration returns no permissions; the ordinary request resolver retains its
existing rejection audit. Currency credentials do not gain Identity audit writes.
The native currency preparation and write transactions now apply a live membership
veto with locked role defaults, grants and target-property assignments. The existing
pricing Owner/base-entitlement checks remain required. This does not complete the
broader entitlement/activation contract or its exact production grants.
Native currency saves must reuse canonical PMS entitlement alias/suspension
resolution over locked current rows, evaluated with the database clock after
lock waits. Request timestamps cannot decide whether billing access is current.
This check does not activate the Financials module or authorize a Feature Hub toggle.
Entitlement routing updates must take the destination organization's `FOR KEY SHARE`
lock, including changes of organization, product, key or resource scope. A database
trigger enforces this for every writer; it returns the unchanged candidate row and
grants no entitlement mutation or function-call capability. The trigger remains
enabled for replication sessions. Unchanged routing uses existing entitlement row
locks; inserts use the organization FK lock. This covers unrelated rows hidden by
property RLS without exposing them to setup credentials.
Writers should lock the destination organization before updating routing. If a
writer already holds a row needed by setup, the opposite lock order can deadlock;
PostgreSQL must abort one whole transaction, never allow stale authorization to
commit. Retry the whole command with fresh authorization, not only its last SQL.
Verify both commit orders and the enforced trigger before runtime release.

Both currency and Feature Hub commands require Identity row locks. Provide
and test lock-only policies and exact privileges for those `FOR SHARE` reads
without permitting direct `UPDATE` of the locked rows. PostgreSQL `FOR SHARE`
requires UPDATE privilege and UPDATE-policy visibility. If any separate
capability cannot preserve its transaction or denial proof, keep automatic
activation and Feature Hub writes blocked.

### First-currency readiness completion

Use a deferred constraint trigger on the actual INSERT of
`pms.property_pricing_settings`, only for the distinct native `currency_ready`
assignment. Ordinary currency logins cannot activate Financials. No caller can
invoke a standalone activation function or directly update the pending row.
The trigger runs inside the existing command transaction after its final
idempotency write; failure rolls back currency, categories and all evidence.
An UPDATE or replay cannot turn Financials back on after the Owner switches it off.

At completion, lock and prove the current exact assignment, active organization,
both Owner links, one suspended/pending Financials row, current base PMS access,
absence of applicable billing/global suspensions and seven unarchived system
categories. Use the database clock after waits. Require the inserted currency
and revision to remain unchanged, and the same supported V1 currency vocabulary
as the native command. Require a completed successful first-currency idempotency
record, its currency audit and pricing event, and both matching pricing outbox
destinations from this transaction. Existing evidence cannot be reused.
Native evidence triggers overwrite a reserved metadata stamp with PostgreSQL's
full transaction ID on INSERT and idempotency UPDATE; caller timestamps, supplied
stamps and wrapping 32-bit tuple IDs are not completion proof. Activation records
the same database transaction ID in the protected entitlement metadata. Immediate
guards reject subsequent currency or idempotency updates in that transaction,
including after `SET CONSTRAINTS ALL IMMEDIATE`. Append-only evidence and category
mutation denials protect the remaining prerequisites. Later currency commands
and cached replay do not reactivate an Owner-disabled module.

The original actor is verified by the isolated service and canonical current
membership checks in the native currency repository, before writing. Completion
derives its actor and correlation from that command's matching audit/event evidence;
it accepts no actor parameter or caller session setting. The database purpose
credential remains available only to that service. The completion trigger updates
only the locked pending Financials row to active/ready and appends one linked
Financials activation audit, with no entitlement mutation policy or additional
UPDATE grant for either currency login. Its fixed-search-path definer function is trigger-only and not executable
by runtime roles. Live trigger/function ownership and exact ACL preflight remain
release gates.

Currency evidence is limited to `pms.pricing_currency.upsert` idempotency and
audit rows, property-pricing source events, and their two pricing-source outbox
destinations. Native logins cannot change event/audit/outbox rows, delete retry
records, or attach another hotel's evidence. Preserve existing shared-table
policies and ACL-backed callers; exact grants and the remaining currency read
inventory still need the full handler/platform preflight.

### Owner Feature Hub command

The API's opt-in `HOTEL_SETUP_COMMAND_ORIGIN` and matching internal token route
currency PUT, module-list GET and Financials PATCH to the private service.
Other pricing commands and retired affiliate writes retain their existing behavior.
With no configuration, existing API behavior remains. Partial configuration fails
startup; an enabled service failure never retries through the local repository.
Only the original bearer, internal token, JSON body and currency idempotency key
are forwarded, with fixed operation paths, no redirects and a bounded timeout.
Caller identity/context headers and query overrides cannot reach the private service.
This transport is an explicit route-policy exception: the private adapters enforce
the canonical policies and original session themselves, including Owner off during
billing suspension. The transport never treats a forwarded API context as authority.
TLS is required except for local loopback tests. Production network isolation,
independent task IAM/DB access and exact live ACL preflights remain release gates.

The private service verifies the original Owner session. Its native `feature_hub`
transaction repeats canonical current membership/role/override and property-access
checks for `pms.finance.manage`. It appends only the existing Financials on/off audit
shape. A trigger-only definer derives the actor from that audit and the organization
from the native assignment; it accepts no standalone actor or organization argument.
It locks the current own Financials row and all applicable base/module entitlements,
then atomically changes that row and stamps the linked audit. Direct entitlement
UPDATE, other modules/properties, pricing/category writes and currency evidence
remain denied to this login.

Native activation requires the completed new-hotel marker, configured supported
currency, current base access, valid entitlement dates and no applicable suspension.
Existing-hotel activation stays on its separate reviewed rollout path. Deactivation
does not require active billing/base access, and never clears dates or deletes data.
Only a transition from active to Owner-disabled records an Owner-off marker.
Every other entitlement writer invalidates that marker; repeated off cannot turn a
billing suspension into Owner-off. Activation of a suspended row requires that
uninvalidated marker. Currency completion and replays cannot undo Owner-off.
Feature Hub must keep a completed new hotel visible after off so its Owner can
switch it back on. Route eligibility reads never replace the locked write checks.

Before any release: test the real handlers and native logins on fresh and
upgraded PostgreSQL 16 and 17, including two organizations, cross-property
denials, replay, failed provisioning, rotation, transfer with an already
connected session, Owner off/on, revoked permission, and admin-created hotels.
The platform preflight must use the exact live roles and verify allowed and
denied ACLs, RLS, functions, schema/database CREATE, and role membership.
Review primary and rollback task definitions, immutable image, and the
synthetic-hotel smoke. New hotels remain off until all gates pass; existing
hotels use their separate rollout path.

## Read-only reader release check

Run `node apps/api/dist/cli/hotelSetupReaderPreflight.js` inside the exact reviewed
private image, with only `HOTEL_SETUP_COMMAND_READER_DATABASE_URL`, the matching
password-free `HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT`, and the reviewed RDS CA
through `NODE_EXTRA_CA_CERTS`. The command needs no internal token, WorkOS secret,
admin connection or Secrets Manager write access. Supply the credential through
secret injection, never command arguments or logs.

It authenticates as the fixed native reader over verified TLS, reuses the
launcher's role/column/audit checks, and rejects effective access to other
connectable databases, database CREATE/TEMP, or replication-trigger bypass.
Catalog checks share one read-only repeatable-read transaction which is always
rolled back. Output is a fixed PASS/FAIL record; failure details and credentials
are not logged. Ambient PG connection options cannot replace its explicit
endpoint, TLS or read-only settings.

This proves reader credentials and catalog posture only. It provisions no role,
grant or secret and writes no hotel/audit data. Native command ACLs, real audit
row denial tests, function ownership, lifecycle/transfer, IAM and authenticated
private-service readiness remain separate gates. Do not add a digest to the
platform image inventory until the composed image and rollback are reviewed.

## Native Feature Hub column contract

`HOTEL_SETUP_FEATURE_HUB_PRIVILEGES` is the fixed column inventory for the native
`feature_hub` purpose. The real off/on handler is tested with these grants on
PostgreSQL 16 and 17. UPDATE of one key column permits authorization row locks;
reviewed RLS denies even no-op updates. Only the narrow Financials audit INSERT
can request the trigger's protected entitlement transition. No pricing/category,
private audit payload, setup registry, or direct entitlement status write is granted.

`assertHotelSetupFeatureHubPrivileges` runs inside a successfully begun native
Feature Hub scope and checks effective column access, inherited/PUBLIC grants,
unsafe capabilities, reviewed function bodies/posture, full policy sets and audit
triggers. It is a catalog check, not actor authorization or a provisioner. This
slice exports the contract and proves the handler; it does not wire a new release
CLI or run a check on every switch. Verified connection/endpoint/database isolation,
exact owner identities/posture, credential lifecycle and live deployment remain
separate release gates.

## Currency dependency reads

Migration 0451 restricts native property logins' room types, rate plans, rate
rules and recurring pricing sources to the assigned hotel and the `currency`
or `currency_ready` purpose. These reads check existing pricing before the
currency command writes. Feature Hub, unassigned and revoked logins see no rows,
including through an unfiltered query. Native writes remain denied despite broad
fixture grants; existing ACL-backed callers keep their prior policy behavior.
This stages the read boundary; exact currency column grants and catalog preflight
follow separately. No live role, secret or grant is created.

## Native currency column contracts

The fixed currency inventory permits pricing currency writes and their retry,
event, outbox and audit evidence only. The separate `currency_ready` inventory
adds seven starter-category inserts. Ordinary currency credentials cannot write
categories. Identity key UPDATE grants supply authorization locks without edits.
Dependency reads include the active flags required by existing pricing triggers.

`assertHotelSetupCurrencyPrivileges` reuses the native helper/ACL/audit checks,
pins each purpose’s full policy and trigger/function catalog, and rejects trigger
or owner drift. Both purposes run the real currency handler with these column
grants on PostgreSQL 16/17; first-save completion, replay and later currency update
are covered. This stages contracts and catalog proof, not a new release CLI,
per-request check or provisioner. Verified credentials, TLS/database isolation,
exact live owners, lifecycle/transfer, private readiness and deployment remain gates.

## Native property credential release check

After the reviewed migrations through 0453, run `node apps/api/dist/cli/hotelSetupPropertyPreflight.js`
inside the reviewed image. Inject `HOTEL_SETUP_COMMAND_DATABASE_URL` as a secret;
set the password-free `HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT`, exact
`HOTEL_SETUP_COMMAND_DATABASE_LOGIN`, `HOTEL_SETUP_COMMAND_PROPERTY_ID`,
`HOTEL_SETUP_COMMAND_ORGANIZATION_ID`, and `HOTEL_SETUP_COMMAND_OPERATION`
(`currency`, `currency_ready`, or `feature_hub`). Supply the reviewed CA through
`NODE_EXTRA_CA_CERTS`. No admin credential or internal token is needed.

The CLI reuses verified reader TLS and database isolation checks, then validates
that purpose's column, policy and trigger catalogs in a rolled-back read-only
transaction. A second READ COMMITTED transaction calls the existing assignment
and current Owner check, takes its authorization locks, and always rolls back.
It invokes no business command and saves no currency, category, entitlement or
audit. Wrong assignment, purpose, credentials, TLS or inherited access fails with
a fixed sanitized record. Migration 0452 separates UPDATE-only trigger reads
from INSERT plans; Feature Hub still receives no entitlement metadata read grant.

PASS is a credential/catalog snapshot. Exact live owner identities, lifecycle,
IAM, authenticated private-service readiness, composed image/rollback review and
release approval remain gates. This command neither provisions nor deploys.

## Compiled-image credential rehearsal

The existing local credential fixtures can run the same reader and three native
purposes against `apps/api/dist/cli/*Preflight.js` in a candidate image built with
`apps/api/Dockerfile` (Node 24, `linux/amd64`). Set `HOTEL_SETUP_PREFLIGHT_IMAGE`,
`HOTEL_SETUP_PREFLIGHT_NETWORK`, `HOTEL_SETUP_PREFLIGHT_DATABASE_HOST`, and the
local public CA in `NODE_EXTRA_CA_CERTS`. The test runner only injects preflight
configuration, never AWS/admin/internal-token credentials. Passwords stay in the
child environment. It maps the local endpoint to the owned PostgreSQL container;
bad credentials and missing CA still reach the real compiled executable.

Run `hotelSetupPropertyFinancialsScope.integration.test.ts` and
`cli/hotelSetupReaderPreflight.test.ts` serially per owned cluster, with
`TEST_DATABASE_URL` and `HOTEL_SETUP_READER_PREFLIGHT_TEST_DATABASE_URL` pointing
to a loopback `/vay1092_` migrated fixture. These tests temporarily change PUBLIC
database ACLs, restore them and remove their synthetic roles. Use only a dedicated
local cluster. CI uses its own `vay1092_setup_credential_test` database for
native scope tests and the shared fixture for source CLI rejection tests. This
local rehearsal does not populate the
platform's reviewed image inventory or verify live credentials.
