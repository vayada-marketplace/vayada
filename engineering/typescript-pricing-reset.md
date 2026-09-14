# TypeScript pricing reset

VAY-1546, 2026-09-07. User confirms the next TypeScript system has no users and
requests deletion before replacement. This decision supersedes the parallel
engine, shadow comparison and per-property migration proposals in VAY-1538.

Remove the existing rate-writing and calculation implementations before building
the product specification. Temporary typed unavailable boundaries may remain so
unrelated modules compile; they must never calculate or return fallback prices.
Existing production Python and shared frontends' legacy paths are outside scope.
Money primitives, property currency, authorization, historical evidence readers,
inventory and provider delivery infrastructure are separate responsibilities.
Do not delete schema migration history, live data or unrelated working changes.

Replacement begins from the pricing product specification in Linear, including
open decisions about children and simultaneous meal offers. Tests of removed
implementations are obsolete; retain shared primitive and unrelated workflow
tests. Verify unavailable boundaries and builds. No runtime deployment or merge
is authorized by this deletion step.

## Removed runtime behavior

- Recurring season/weekend/extra-guest/non-refundable materialization and writes.
- Canonical room-rate writes and dated channel-price reads/writes.
- Nightly room calculations, automatic promotion calculations and new price snapshots.
- Public quote/calendar construction, checkout re-quoting and mixed-room pricing.
- Manual-booking previews, Channex rate provisioning/ARI generation and its automatic schedule.
- Alternate rate seeding during room creation/duplication, and target-base room-move repricing.
- Inventory projection's base-plus-season rate computation: it now only closes
  existing offers and refreshes inventory counts, preserving recorded price columns.

Room creation and duplication temporarily return PRICING_UNAVAILABLE because
those old workflows embedded rate creation. Room moves using target-base repricing
are also unavailable. Other existing-room lifecycle operations remain separately
implemented. Shared frontend files retain production legacy paths; next requests
reach unavailable server boundaries until the replacement UI/API is implemented.

Stored evidence types/readers and generic money primitives remain. These are not
a parallel pricing engine. No database/schema history was removed or migrated.

## Verification

Workspace build and typecheck passed. The Booking-domain suite passed all 142
tests. Focused API checks passed 63 tests, covering unavailable boundaries,
no database writes from removed writers, inventory invalidation, retained
manual-preview authorization and unrelated room lifecycle behavior.

The broader API suite has baseline failures: missing local Finance database/KMS
configuration, a reservation-read SQL expectation, and stale settlement SQL
mocks. Those failures were reproduced on the unchanged base revision
`f37a8b1be`; they are not evidence that the replacement pricing is implemented.
Independent review found and verified fixes for alternate room-creation,
room-move and inventory-projection pricing paths. No live provider smoke was
run because this is an undeployed deletion with pricing deliberately unavailable.
