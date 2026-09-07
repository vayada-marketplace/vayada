# VAY-1531 validation

Local verification on 2026-09-07, based on main
`fda046c6c000c2494a1ba0631647aee54abfd701`.

## Passed

- Root `npm run build` and `npm run typecheck`.
- PMS `npm run lint:pms-web`: no errors; 60 pre-existing warnings.
- 43 `@vayada/domain-pms-channex` tests, including invalid inputs and inclusive
  date/weekday overlap boundaries.
- 75 focused API tests across command routes, property validation, provider
  reconciliation, plans, read model and management workers. These include the
  authorization denial matrix, lost-create-response recovery, all three provider
  payloads, unmanaged conflict rejection and intermediate scope-swap rejection.
- A disposable local Postgres 16 database migrated through 0163 exercised the
  actual command store, worker, provider plan and snapshot. It verified atomic
  enqueue, idempotent replay, stale-edit rejection and older queued work reading
  the latest desired removal. Channex HTTP was mocked. This exposed missing
  explicit JSON parameter casts in the existing command store; those are fixed.
- Three existing channel-manager Playwright checks and the new inventory-rules
  browser flow passed at an isolated portless PMS URL. The new flow exercised
  offsets, excluded-channel copy, cap copy, queued polling, persistent provider
  failure after reload, retry, close-out editing and removal. API responses were
  mocked; the rendered result was visually inspected.
- Independent adversarial review: the scope-swap finding was fixed and retested;
  final review found no remaining actionable issues. Ponytail complexity pass
  retained the existing queue, metadata, permission and UI patterns with no new
  external dependency.

## Not yet verified

No Channex staging API credentials or designated synthetic provider property were
available in the configured local environment. Provider acceptance, offset
clamping, inventory-driven updates, cap replenishment and removal restoration
have **not** been observed against Channex or a connected OTA. The official API
and behavior guides establish the intended contract, not live enforcement.

The normal local launcher stopped because existing Docker containers belong to
another checkout. Those containers and reusable next-environment accounts,
property and bookings were not changed. The browser used a separate portless
process; the Postgres test used its own disposable container.

Keep the stack in draft until bounded Channex staging verification records all
three rule types at 10 and 2 available rooms, inventory changes, editing/removal
and restoration. Use synthetic staging inventory only and restore test rules;
do not create real reservations or make production provider changes.
