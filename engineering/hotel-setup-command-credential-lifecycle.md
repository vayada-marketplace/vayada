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

Rotation creates a new random login and secret and verifies its attributes and
denials. In one transaction, deactivate the old assignment, activate the new
one, run the replacement's positive exact-scope preflight, and commit only on
success. The 0441 scope helper rejects an inactive login, so a positive test
before this transaction cannot work. Run the post-switch preflight again from
the real service connection before serving a command.
Only after old connections drain may the old login be disabled and retired.
Secret replacement alone cannot revoke a pooled session.

Ownership transfer changes the current owner link and active property-login
assignment in one transaction. Both transfer and setup commands lock the same
assignment and owner rows. An already connected old login must fail its next
command, including a command racing with transfer. A new owner receives a new
login and secret; the old organization's creation login never gains the
transferred property's command scope.

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

Both currency and Feature Hub commands require Identity row locks. Provide
and test lock-only policies and exact privileges for those `FOR SHARE` reads
without permitting direct `UPDATE` of the locked rows. PostgreSQL `FOR SHARE`
requires UPDATE privilege and UPDATE-policy visibility. If any separate
capability cannot preserve its transaction or denial proof, keep automatic
activation and Feature Hub writes blocked.

Currency evidence is limited to `pms.pricing_currency.upsert` idempotency and
audit rows, property-pricing source events, and their two pricing-source outbox
destinations. Native logins cannot change event/audit/outbox rows, delete retry
records, or attach another hotel's evidence. Preserve existing shared-table
policies and ACL-backed callers; exact grants and the remaining currency read
inventory still need the full handler/platform preflight.

Before any release: test the real handlers and native logins on fresh and
upgraded PostgreSQL 16 and 17, including two organizations, cross-property
denials, replay, failed provisioning, rotation, transfer with an already
connected session, Owner off/on, revoked permission, and admin-created hotels.
The platform preflight must use the exact live roles and verify allowed and
denied ACLs, RLS, functions, schema/database CREATE, and role membership.
Review primary and rollback task definitions, immutable image, and the
synthetic-hotel smoke. New hotels remain off until all gates pass; existing
hotels use their separate rollout path.
