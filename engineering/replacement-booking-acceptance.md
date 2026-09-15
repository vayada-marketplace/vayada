# Replacement booking acceptance (VAY-1543)

Status: durable schema, historical replay, Finance capture, retained inventory/promo
helpers, draft/add-on staging, frozen acceptance mode and the final-time gate are
implemented. The full writer and public submission remain pending. Authority:
[direct pricing consumption](direct-replacement-pricing-consumption.md).
Migration 0210 adds immutable storage without enabling booking submission or payment
execution. The current price preview remains a quote, not a reservation.

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

Booking-owned migration 0210 introduces the append-only
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
   These are all uncommitted writes on the caller connection. The inventory and
   promo composition helpers below now consume trusted, locked pre-mutation
   evidence; the complete writer orchestration remains unimplemented.
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
inventory. The retained-validation owner APIs below address this ordering for the future
writer; accepted-command replay still precedes fresh inventory checks. Do not fix either by
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
called with a fabricated old quote. The retained-owner reservation/promo helpers and draft booking/add-on staging now exist.
Required next slices are replacement lifecycle/revenue projections, receipt and
acceptance persistence, and the complete orchestrator. Finance capture and historical replay
readers below remain internal prerequisites until that composition is verified.

Guest age semantics: retain every actual age 0–17 exactly in the immutable quote.
Booking guest `adultAgeThreshold` classifies those ages; it is not a maximum age
permitted in the actual-age list. This follows Booking admin's existing “Adults
{adultAge}+; children ages 0–{childMaxAge}” setting and the guest selector's labels.
The inspected Python settings/checkout do not provide actual-age threshold
enforcement; this decision does not claim Python parity for a rule it lacks.
When `childrenEnabled` is true, do not reject ages at/above the threshold. When
false, reject ages below the configured threshold; a missing disabled threshold
conservatively rejects any recorded minor. For threshold12, ages12 and17 remain
retained and eligible, while age11 is disallowed when children are disabled.
PMS `children.adultFromAge` remains the separate price-classification owner. Do
not rewrite ages, guest counts, accepted quote identity or price to satisfy this
eligibility check. These rules do not activate booking submission.

Focused final-gate tests verify ordering, cutoff crossed during an authority wait,
exact expiry, future/invalid time, changed policy/timezone/scope, and unchanged
local date. These use mocked SQL responses, not real database concurrency.
The future writer requires real isolated PostgreSQL tests for last-room races,
last promo use, own-mutation validity, changed-command conflict, duplicate quote
acceptance, replay after expiry/repricing/policy edits, and rollback after each
write stage. Test a cutoff/expiry crossed during a held DB lock, and compare exact
accepted evidence after later owner edits. Receipt-only tests are insufficient.

## Durable acceptance schema (0210)

Migration0210 implements the immutable relation above. Scoped foreign keys bind
quote/property/organization, booking/property, and the completed Booking receipt's
property, exact acceptance operation, key hash and command fingerprint. Accepted
receipts cannot later be expired, repurposed or deleted while referenced. The
writer must complete its staged receipt before inserting acceptance evidence;
both still roll back together. Unique quote, booking and receipt references reject
duplicate acceptance. Inserts preserve the exact stored quote JSON and disclosure
bytes/hash; update, delete and truncate are forbidden.

Finance fields use existing `billing_plan_snapshot`, `commission_terms_snapshot`
and `finance_terms_captured_at` representations, supplied explicitly with no
fallback defaults. Empty commission objects are rejected, including for fixed
plans; a legitimate fixed-plan snapshot retains its nominal fee values and
Finance configuration timestamp. Fixed-plan charging is resolved downstream. This schema does not establish owner
capture or verify arbitrary commission object semantics. No Finance capability ID
is substituted for accepted billing/commission values.

Schema tests use a dedicated PostgreSQL database and synthetic storage shapes to
verify scoped references, independent uniqueness, missing/malformed envelopes,
exact evidence retention, immutable history and transaction rollback. They do not
establish a domain-valid PMS reservation or completed checkout. The historical decoder/replay reader and Finance capture below build on this
schema. Add-on capture and staging now exist as internal prerequisites; the complete
acceptance writer and real transactional race coverage remain required. No runtime write or public acceptance route is added by0210.

## Historical acceptance reading

`decodePricingAcceptanceHistory` verifies persisted quote, exact disclosure bytes,
normalized consent command, Finance snapshot values and PMS receipt bundle shapes.
It uses historical guest rules; current time, prices and policies do not invalidate
accepted history. Fixed plans retain the owner's configured nominal percentages,
which may be nonzero; the plan determines their application downstream.
`replayPricingAcceptance` additionally checks current public authority and scoped
quote/booking/complete-receipt links before normalizing a retry against that history.
The receipt result must identify `booking` / `guest_booking` and the accepted booking
with success status200. No receipt means only “no recorded command”; the future
writer must reserve the command/quote keys and repeat the read after any wait.
These readers neither reserve inventory nor create a booking or validate current
PMS occupancy. The immutable bundle retains opaque PMS receipt IDs for its owner.
## Finance capture prerequisite

`lockFinancePricingAcceptanceTerms(client, slug)` resolves public scope itself,
locks the property and its exact organization billing entitlement and Finance
onboarding commission rule, then rechecks authority and database time. It reuses
the existing Finance billing mapper after strict validation. Missing configuration,
unselected/invalid plans, malformed present fees and expired evidence fail closed.
For a real onboarding rule, absent optional fees retain Finance's existing rules:
channel fee equals the nominal rate and affiliate fee is zero. This is different
from inventing missing Finance configuration. Fixed-plan snapshots retain nominal
fees (currently5); downstream plan semantics determine whether a fee is charged.

The result supplies existing billing/commission/capture timestamp fields and the
earliest `validUntil`. Retain all locks and check this deadline again at final
acceptance after later waits. The current quote-time gate alone does not enforce
Finance expiration. This helper creates no acceptance record, does not execute
payments and does not substitute payment capability evidence for billing terms.

Capture/replay tests currently mock SQL boundaries. Before activation, exercise
real subscription-update versus capture lock ordering and transaction retries,
in addition to the inventory/promo/receipt races above. Unit ordering assertions
are not evidence that competing owner transactions cannot deadlock.

## Combined final deadline gate

`finishPricingAcceptance(client, slug, current, finance)` combines the existing
quote/time/authority gate with the captured Finance deadline. Both evidence inputs
must originate on this retained transaction before mutations. It compares the
exact property/organization/authority revision, then uses the final gate's database
time after all waits to require capture <= time < validUntil (null is unbounded).
The writer must stage every blocking write first and roll back on rejection.
No additional database work follows inside this helper; it returns time only.

## Promo mutation from retained validation

`redeemLockedCurrentQuotePromo(client, slug, current, guestBookingId)` reuses the
existing redemption algorithm with the successful pre-mutation revalidation from
this same retained transaction. It checks public scope and booking evidence, then
consumes only a positive applied code amount atomically. A locked replay must
match the captured promo definition, code, source revision and exact discount.
The standalone `redeemCurrentQuotePromo` keeps its fresh-validation behavior.
Neither path completes booking acceptance. Final deadline checks and full rollback
remain mandatory. A real PostgreSQL regression verifies that own consumption
invalidates fresh repricing, retained validation still replays the same application,
and rollback restores both usage count and absence of the application.

## Inventory composition prerequisite

`reserveRevalidatedQuoteInventory(client, slug, current)` reuses a successful
pre-mutation `lockCurrentQuoteRevalidation` result from that exact retained
READ COMMITTED transaction. It verifies current public scope and exact immutable
stored quote binding, then calls the existing PMS reservation implementation.
The PMS callback checks retained public scope instead of recalculating prices;
PMS replay/fingerprint/status, calendar, capacity, day locks and rollback behavior
remain intact. `reserveCurrentQuoteInventory` keeps its fresh-revalidation path.
Evidence from a prior transaction or client request cannot use this internal
contract. This is an inventory hold, not accepted-booking replay or final acceptance;
the caller still owns final quote/Finance timing and atomic rollback of all effects.

## Draft booking and captured add-on staging

`projectPricingBookingAddons` maps retained pre-mutation add-on owner evidence to
exact service-date rows, preserving selections, ownership and partner commission.
It refuses amounts that existing numeric(15,2) columns cannot represent exactly.
`persistPricingBookingAddons` locks the scoped draft booking and checks its quote,
stay, currency, total and edit revision. Identical existing rows replay; conflicting
rows or historical revisions fail. It never recaptures or reprices an add-on.

`stagePricingBookingDraft` stages a draft/unpaid pay-at-property booking, the
normalized booker, and those captured add-on rows on the caller's retained
connection. It binds the stored quote, exact disclosure and consent command to
the current public scope and supplied Finance capture. The caller allocates the
booking ID/reference, retains owner locks, and rolls back every write on failure.
This is an internal staging step: it does not confirm a booking, issue a receipt,
write accepted history, collect a deposit, or activate public submission. The
complete orchestrator still owns final freshness after all blocking writes.

## Frozen acceptance mode

Following [VAY-1274](booking-acceptance-mode-contract.md), new replacement quotes
capture `acceptanceMode` from the locked Booking settings row at issuance. Only
`instant` and `request` are valid; missing settings do not imply instant booking.
The additive field remains absent in older historical records, which still decode
without mutation. Fresh draft staging refuses those older quotes and requires a
new quote; it never fills in today's setting as a substitute.

Price revalidation and issuance replay retain the original quote's mode after a
settings edit. New quotes capture the new mode. The exact quote/disclosure hash
binds the frozen value, and draft booking metadata preserves it for downstream
lifecycle handling. Both modes still stage only a draft here. Public presentation
of confirmation versus property approval, request deadlines and actual lifecycle
transitions remain required before submission can be enabled.
