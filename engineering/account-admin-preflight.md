# Account-admin ownership preflight

VAY-1439 requires an exception inventory before introducing the single-admin
invariant. Run this command against an explicitly selected database with the
current identity schema through migration 0203:

```sh
npm --workspace @vayada/backend-migration run target:account-admin:preflight
```

Supply `TARGET_DATABASE_URL` through the environment or an approved secret
helper. Do not put a connection string in shell arguments or commit reports.
The command uses a repeatable-read, read-only transaction with a 30-second
statement timeout. It does not migrate, normalize, demote or delete users.

The JSON report includes organization IDs/statuses and exception counts, without
names, email addresses, provider IDs or credentials. All hotel groups are
inventoried, including inactive groups that could later be activated. All owner-role rows count, including inactive memberships: inactivation revokes
access but does not choose or remove ownership. Historical owner rows require
explicit remediation before enrollment.

Exceptions are: zero/multiple current owners; no single active canonical owner
with an active user; legacy `owner`/`operator` aliases; or canonical owners with
property, origin, permission, product or saved-role restrictions. An absent saved
role reference is allowed for legacy canonical owners and is not silently backfilled.

Exit code 0 means the inventory is clear; 1 means exceptions exist or the command
failed. Exceptions need explicit account-level decisions before invariant rollout.
Do not pick a winner automatically. A clear report is a point-in-time prerequisite,
not transfer authorization: the future invariant migration and transfer command
must recheck ownership transactionally. Fresh WorkOS proof remains required.

## Guard rollout

Migration `0204_account_admin_guards.sql` adds explicit, permanent enrollment.
It does not enroll existing accounts. A future transfer command must acquire the
organization lock, validate current ownership, enroll, and swap roles atomically.
The deferred constraint rejects a second owner, legacy alias, or deletion of the
sole owner; provider inactivation can still revoke access without erasing ownership.
Account deletion removes its guard through the organization foreign key cascade.

The VAY-1439 stack currently overlaps main's migration numbers 0193–0197.
Renumber and rebase the complete stack before merge; 0204 is reserved for this
guard after the six preceding VAY-1439 migrations are assigned 0198–0203.
Do not apply the combined branch/main migration history before that reconciliation.
