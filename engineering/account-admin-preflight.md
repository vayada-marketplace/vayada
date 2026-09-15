# Account-admin ownership preflight

VAY-1439 requires an exception inventory before introducing the single-admin
invariant. Run this command against an explicitly selected database with the
current identity schema through migration 0198:

```sh
npm --workspace @vayada/backend-migration run target:account-admin:preflight
```

Supply `TARGET_DATABASE_URL` through the environment or an approved secret
helper. Do not put a connection string in shell arguments or commit reports.
The command uses a repeatable-read, read-only transaction with a 30-second
statement timeout. It does not migrate, normalize, demote or delete users.

The JSON report includes organization IDs/statuses and exception counts, without
names, email addresses, provider IDs or credentials. All hotel groups are
inventoried, including inactive groups that could later be activated. Removed
memberships are excluded; suspended owners still count as existing owners.

Exceptions are: zero/multiple current owners; no single active canonical owner
with an active user; legacy `owner`/`operator` aliases; or canonical owners with
property, origin, permission, product or saved-role restrictions. An absent saved
role reference is allowed for legacy canonical owners and is not silently backfilled.

Exit code 0 means the inventory is clear; 1 means exceptions exist or the command
failed. Exceptions need explicit account-level decisions before invariant rollout.
Do not pick a winner automatically. A clear report is a point-in-time prerequisite,
not transfer authorization: the future invariant migration and transfer command
must recheck ownership transactionally. Fresh WorkOS proof remains required.
