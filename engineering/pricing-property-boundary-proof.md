# VAY-1543: database property scope feasibility

Local proof, 2026-09-21. This is not a production migration or rollout approval.
It continues the approved database-protection direction in
`pricing-runtime-role-boundary.md`; existing app pool PRs #2548/#2551 are merged.

## Result and reproduction

```sh
python3 scripts/pricing-property-boundary-proof.py /opt/homebrew/opt/postgresql@17/bin
```

The script creates its own private temporary, socket-only PostgreSQL cluster.
It applies the checked-out target SQL migrations (including runner ledger DDL
and no-transaction directives), uses synthetic data, then stops and deletes only
that cluster. No supplied database URL, existing cluster, shared test fixture,
credential, or AWS resource is used. This is schema loading for a proof, not a
test of migration-ledger execution or deployed upgrades.

Passed on PostgreSQL 17.5 and independently rerun by the rollout owner on PostgreSQL 16.15 and 17.5: all 252 migrations through
`0405_booking_affiliate_original_bindings.sql`, source `13fe24d76`.
Four separate SCRAM-authenticated, non-owner, NOBYPASSRLS logins represent
owner authority and public quote execution for two properties in an
owner-managed property/organization mapping. Policies use `session_user`,
not a supplied property setting. The real tables retain their constraints and
triggers:

- Public logins can insert their own quotes; owner logins can insert their own
  authority revision/head and advance the head. Neither class can perform the
  other's intentional writes. Public roles retain head locking but cannot
  update authority, including through SET ROLE.
- Wrong-organization quote insertion and selecting a head revision belonging
  to another organization fail, despite valid foreign keys.
- Cross-property quote/revision insertion and head update fail with SQLSTATE 42501. A forged `app.property_id`, `row_security=off`, `SET ROLE`, and
  `SET SESSION AUTHORIZATION` do not bypass scope.
- The login cannot change the assignment map or disable RLS. It cannot mutate
  quotes/revisions or delete authority heads.
- The head grant is **UPDATE(revision)**, not table-wide UPDATE. A specific
  regression removes A's head, then tries moving B's head to A with a valid A
  revision. It fails on privileges, with no uniqueness conflict masking the
  attack. B's original head remains unchanged.
- Head `FOR SHARE` still returns the other property for the existing public
  read/lock use case. This deliberately does not promise tenant read isolation.
- A forbidden write rolls back an earlier allowed write in the same transaction.
  Removing the owner-managed assignment denies subsequent writes.

The restrictive INSERT/UPDATE checks compose with permissive visibility. They
do not rely on checks/FKs to establish authorization. Broadening UPDATE back to
all head columns would invalidate the reparenting protection and must fail any
future privilege preflight.

## What this means for production

The database can enforce scope when it has an identity the pricing SQL client
cannot choose. The existing single `PRICING_DATABASE_URL` has one authenticated
identity for every hotel; adding `SET app.property_id` would not establish that
boundary. There is no verified property-capability issuer in this proof.

The follow-up `pricing-command-service-contract.md` selects a private command
service with native logins and defines its concrete integration/provisioning
boundary; the options below describe the preceding feasibility assessment.

The smallest native PostgreSQL implementation is a property-bound login with a
DB-owned assignment and the policies demonstrated here. **It is not sufficient
to put every hotel's credential into the same API process and let it choose.**
That would limit an already selected SQL connection, but an API credential leak
or arbitrary role-selection bug could still acquire the other hotel's login.
Static property assignment also does not prove which staff member may change
authority, organization/actor consistency, or current entitlement.

Recommended integration decision: keep request authentication and scope issuance
outside the pricing executor's SQL trust boundary. A trusted authorizer verifies
the WorkOS session and live membership/property/permission before providing the
bounded execution context; public quoting uses a different capability that can
only issue a quote for the resolved currently published property. Owner authority
permission must never follow from the public quote capability. The executor must
not possess the issuer's credential/key or a way to mint arbitrary scopes.

Two concrete implementation choices remain:

1. A trusted connection broker supplies a property-bound database connection.
   This reuses native role identity and the tested policy primitive, but requires
   login/credential lifecycle, pooling limits, and a separately isolated broker.
2. A trusted issuer creates short-lived, operation-specific capabilities that
   the database verifies. This preserves one executor pool, but adds token
   verification, expiry/replay semantics, revocation, key rotation, and careful
   transaction binding. A function accepting an unsigned property/user ID is
   not this option.

Prefer the broker/native identity path for a deliberately bounded first release;
do not silently create one credential per property across the platform. If the
required threat model is only SQL injection on an already authorized connection,
that limitation must be explicit; neither option prevents compromise of its
trusted authorizer itself.

## Reviewable implementation sequence

1. Prepare a concrete issuer contract and proposed first-release property scope,
   including owner-vs-public operations and which principal can acquire each
   context. The user's approved plan authorizes this preparation. VAY-2038
   identity, platform/database, and release owners review the actual design
   before it becomes a production identity or provisioning change.
2. Build that narrow issuer/connection contract and negative tests for forged
   identity, unauthorized hotel, revoked membership, public-to-owner escalation,
   and unavailable issuer. Keep one caller-owned transaction and lock order.
3. Add a separate migration/ACL slice for the exact real route inventory. Prove
   lock-only denial on every non-write table; bind organization and actor fields;
   grant only revision-column updates on heads. Preserve existing roles and
   quote/authority immutability. Run actual-role route, revocation, concurrency,
   optional-branch and cross-property tests on PostgreSQL 16 and 17.
4. Review platform role/secret mappings and exact ACL/RLS preflight; deploy only
   after that review and the VAY-2029 gates. Then run one coordinated synthetic
   owner/public offer/no-payment quote smoke.

Not yet proven: full app routes and joined row-lock inventory,
cross-domain trigger effects, live role membership/definer reachability, actor
binding, live organization ownership reconciliation, real session/entitlement admission, revocation during a
running transaction, secret/broker isolation, deployment or product smoke.
The pricing rollout blocker remains open. No implementation PR, grant, merge,
deployment, authority selection, live quote or reservation occurred.

The selected command-service contract makes the verifier, authorizer and native
credential selector one trusted service, separate from the ordinary API. Earlier
issuer/executor wording describes the SQL-connection boundary, not an additional
process inside that service. Service compromise or credential-selector defects
remain outside this database proof; wrong-property SQL on an already selected
connection and ordinary-API forged scope are the intended boundaries.
