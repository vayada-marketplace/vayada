# Replacement booking acceptance (VAY-1543)

Status: implementation design and final-time prerequisite only. Authority:
[direct pricing consumption](direct-replacement-pricing-consumption.md).
No public booking submission, payment execution or new migration is enabled here.
The current price preview remains a quote, not a reservation.

## Command and persistence decisions

The future internal writer is
`acceptCurrentPricingQuote(client, slug, input): Promise<{ bookingId, replayed }>`.
The caller owns READ COMMITTED, commits only complete success, and rolls back
all writes on any rejection. Input remains `booking-quote-acceptance.v1` from
`parseBookingQuoteAcceptanceInput`; do not introduce another posted money format.

Use existing `platform.idempotency_keys`, property tenant scope and Booking
operation scope, with a distinct operation `booking.pricing_quote.accept`.
`key_hash` is lowercase SHA-256 hex of the exact validated request ID.
`request_fingerprint_hash` is the parser's normalized command fingerprint with
its `sha256:` prefix removed. Never reuse the legacy checkout operation.
Same request ID with different normalized input conflicts. Different request IDs
must not create two bookings from one quote.

A required future Booking-owned migration must introduce an append-only
`booking.pricing_quote_acceptances` relation with:

- `id` (UUID), `property_id`, `organization_id`, `pricing_quote_id`,
  `guest_booking_id`, `command_receipt_id`, and database `accepted_at`.
- Unique `pricing_quote_id`, `guest_booking_id`, and `command_receipt_id`.
  Composite scoped foreign keys must bind quote and booking to the same property;
  quote organization must agree too. Add the required referenced uniqueness to
  `pricing_quotes` in that migration, rather than trusting JSON scope.
- The exact existing `stored-pricing-quote.v1` JSON, the exact serialized
  `booking.quote-guest-disclosure.v1` string and its policy source revision/hash,
  normalized acceptance command and fingerprint, and PMS reservation bundle.
  These reuse existing decoder formats; this document creates no new snapshot DTO.
- Finance billing/commission snapshot references and accepted values, once the
  authorized caller-transaction Finance capture port is implemented.
- Update/delete/truncate prevention consistent with other append-only evidence.

Do not place a replacement quote ID in `guest_bookings.quote_session_id`:
that foreign key references the retired `quote_sessions` representation. The new
acceptance relation supplies the replacement link. `booking_metadata.pricingQuoteId`
may be populated for the existing promo adapter, but metadata is not the unique
acceptance authority. Historical confirmation must read the immutable acceptance
relation; booking edits must never overwrite it.

The complete stored quote already preserves per-room/night amounts, terms,
revisions, payment method, total/due-now/due-later minor strings and Finance
capability evidence. Persist it exactly, without recalculation or Number conversion.
Preserve exact disclosure bytes rather than reserializing them during replay.
Existing booking/add-on/promo decimal columns are `numeric(15,2)`; the writer must
reject amounts not exactly representable there until downstream schema and
consumers support them. No rounding, clamping, fabricated zero or FX fallback.
Add-on persistence must retain participant selection and current ownership and
partner commission snapshots; quote amount lines alone do not establish ownership.

## Transaction order and replay

1. Resolve and lock current public property/organization authority. Reserve the
   property-scoped command receipt and quote-acceptance uniqueness lock. A complete
   prior receipt replays before fresh pricing, policy, expiry or inventory checks.
   Decode its stored accepted quote/disclosure/command and normalize retry input
   against that historical evidence, never today's policies. Verify fingerprint,
   persisted booking/acceptance linkage and current authorization before returning.
   A receipt without a corresponding complete acceptance is corruption, not success.
2. For a fresh command, load the exact immutable quote. Obtain one complete current
   revalidation and current guest disclosure, validate consent/guest input and
   fingerprint, and retain owner locks through commit. A changed quote or policy
   requires a new quote and renewed consent. Confirm the quote has no acceptance
   under another request ID after the uniqueness wait.
3. Capture Finance billing-plan and commission terms through its authorized owner
   port on this same connection, and prepare exact booking/add-on/revenue/lifecycle
   projections. Finance payment capability IDs alone are not these snapshots.
   Lock every row or uniqueness scope required for subsequent mutations. Reject
   unsupported payment execution or lifecycle compositions before effects.
4. Reserve the PMS inventory bundle using the already validated immutable quote,
   write booking/booker/add-ons and immutable acceptance evidence, consume only a
   positive applied promo discount and stage status/read-model/outbox effects.
   These are all uncommitted writes on the caller connection. The existing helpers
   require refactoring to consume trusted, locked pre-mutation evidence before
   they can be composed here; the orchestration is not implemented by this design.
5. Stage the command receipt's complete result and every potentially blocking
   insert/update, including FK, unique-index and receipt locks. Run the final-time
   gate below. The append-only acceptance record keeps its database insertion
   timestamp; this final validation timestamp need not mutate that evidence. If
   any further blocking work occurs, repeat the gate after it and before commit.
   No incomplete receipt, inventory hold or promo use survives rollback.

A critical ordering constraint: `redeemCurrentQuotePromo` currently invokes full
revalidation. Its own `current_uses` increment changes the promo source fingerprint;
revalidating afterward would reject the command's own mutation. Similarly, a
fresh availability check after its own PMS reservation can observe reduced free
inventory. The future writer needs owner APIs accepting the previously locked
validation, or explicit reservation-credit-aware checks. Do not fix either by
ignoring arbitrary source changes, refunding/re-reserving, or skipping authority.
Reuse the existing PMS inventory and Booking promo mutation algorithms after
separating their pre-mutation validation; do not introduce parallel calculators.

All effects, including PMS reconciliation/outbox and receipt state, roll back
with the booking. External payment and notification actions remain in their
established command/outbox boundaries; this writer must not call providers.

## Final database time prerequisite

`finishCurrentQuoteAcceptanceTime(client, slug, current)` accepts the successful
`lockCurrentQuoteRevalidation` result from before mutations on the same retained
READ COMMITTED transaction. It returns only an ISO timestamp, never a booking or
acceptance receipt. Caller-supplied or unlocked evidence is not authorization.

It locks the existing `booking.same_day_booking_policies` and Catalog location,
requires the earlier policy revision/timezone, then rechecks public scope. Only
after those waits does it read `clock_timestamp()`. It checks issuance/expiry,
unchanged property-local pricing date, non-past check-in and same-day cutoff via
`evaluateSameDayBooking`. It preserves the current owner's absent-policy defaults;
malformed present policy or missing/changed timezone fails closed. It does not
recalculate prices after this command's inventory/promo changes.

The caller must acquire and stage all later write locks first. Reading the clock
before a blocking acceptance INSERT, receipt UPSERT, foreign-key wait or commit
preparation is insufficient. If additional blocking work is unavoidable, run this
gate again afterward. A rejected gate requires full transaction rollback.

## Remaining blockers and validation

The legacy `createTargetGuestBooking` converts `quote_sessions`, constructs legacy
selected-offer/policy snapshots and numeric amount projections, and performs
lifecycle/read-model work. It is not a replacement writer and cannot safely be
called with a fabricated old quote. Required next slices are the scoped immutable
acceptance migration/decoder and replay repository, owner-preserving reservation/
promo composition, same-transaction Finance/add-on capture and replacement
booking/lifecycle/revenue projections, then the complete orchestrator.

There is also an unresolved age contract: the browser retains all actual ages
0–17 and room pricing uses its own `children.adultFromAge`; acceptance currently
rejects any child age at or above Booking guest `adultAgeThreshold`. A lower
property threshold therefore permits a quote that cannot be accepted. Decide and
implement classification versus eligibility semantics consistently before route
activation. Never drop ages or silently convert selections to satisfy the parser.

Focused final-gate tests verify ordering, cutoff crossed during an authority wait,
exact expiry, future/invalid time, changed policy/timezone/scope, and unchanged
local date. These use mocked SQL responses, not real database concurrency.
The future writer requires real isolated PostgreSQL tests for last-room races,
last promo use, own-mutation validity, changed-command conflict, duplicate quote
acceptance, replay after expiry/repricing/policy edits, and rollback after each
write stage. Test a cutoff/expiry crossed during a held DB lock, and compare exact
accepted evidence after later owner edits. Receipt-only tests are insufficient.
