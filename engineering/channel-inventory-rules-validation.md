# VAY-1531 validation

Local verification on 2026-09-07, based on main
`fda046c6c000c2494a1ba0631647aee54abfd701`.

## Passed

- Root `npm run build` and `npm run typecheck`.
- Standalone `npm run build:pms-web` with the shared Channex package's compiled
  output removed first; PMS prebuild compiles that dependency successfully.
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

## Real Booking.com staging verification — 2026-09-08

Compiled Vayada reconciliation ran against Channex and sanctioned Booking.com
hotel 5868189. Channel logs contain OTA_HotelAvailNotifRQ BookingLimit values
and HTTP200 OTA_HotelAvailNotifRS Success acknowledgements:

- Offset2: 10 → 8, 2 → 0; inventory changing to10 sent8.
- Cap3: 10 → 3, 2 → 2; inventory1 sent1, then inventory10 sent3.
- Close-out: all selected dates sent0; removal restored10 and2.
- Rule edits retained provider identity. Dates were bounded to October13–16;
  the only canonical provider inventory change was October15, restored to2.
- Final readback confirms baseline10/2, empty rules, active channel and unchanged
  weekday stop-sell. No reservation, payment or message was submitted.

Sanitized evidence: local `vayada-testing/evidence/vay1531-channex/delivery-results.json`.
Events cda1ee98 (offset), 3f00c66d (cap), 184e8ff8/b500ebd7 (inventory changes),
e3eb5c44 (close-out), 071ed0eb (restoration) each received Success.

This verifies provider delivery and acknowledgement, not Booking.com storefront
presentation, a sales-quota scenario using bookings, or a second active OTA.
Deployed PMS UI/queue/worker smoke remains a post-merge acceptance check.
