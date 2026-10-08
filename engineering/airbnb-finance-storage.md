# Airbnb provider amounts in Finance

VAY-1551, 2026-09-14. Builds on `airbnb-financial-snapshots.md` and PR #2213.

## Accounting boundary

Finance owns immutable provider financial snapshots for Airbnb. Booking continues
to own gross nightly revenue evidence. A payout or guest-paid total is not inserted
into `gross_room_amount`, and a provider commission is not fed into the existing
percentage-rule commission generator. These snapshots are provider evidence, not
expense postings, payments, refunds or a replacement for the general revenue ledger.

One snapshot contains the entire current stay, all provider nightly amounts, room
totals/taxes and the single booking-level commission total. Current Finance views
select only the latest snapshot per property/booking. Thus a shortened stay removes
old nights from the current view and commission is represented once per booking,
without deleting audit history or joining it onto every nightly row.

## Persistence contract

- Accept only the scoped reader's full replacement for an authoritative modified
  Airbnb revision, or a cancellation replacement retaining explicit or unknown provider totals. Validate the local booking's property, provider source reference,
  currency and lifecycle in the same transaction. Full-stay replacements require
  confirmed status and matching updated dates/room count/total. Cancellations
  require canceled status; the supplied provider total is retained separately
  from the canonical pre-cancellation stay and amount.
- The caller must establish provider acceptance, channel/binding ownership, room
  mapping, revision freshness and the channel settings applicable to that revision.
  Supply a revision-bound settings evidence reference; current channel metadata alone
  is insufficient. No implicit channel-setting changes or defaults.
- Require READ COMMITTED isolation and serialize through the booking row lock, so
  a waiter sees the committed successor after acquiring the lock. Reject snapshot
  isolation modes rather than comparing against stale Finance state.
  Require the expected previous financial
  revision (null only for initial capture). Reject older/equal provider timestamps,
  competing successors and changes to provider/channel identity or amount basis.
  Preserve microsecond timestamps; opaque revision IDs do not define ordering.
- Exact replay of any stored revision is a no-op, even after later revisions.
  Different normalized content under that identity is a conflict. Never replace a
  newer snapshot with an older one. Booking mutation and Finance capture share the
  caller-owned transaction; a failure rolls both back.
- Store only the normalized allowlist. No notes, guest details or card information.

The schema is additive and the writer has no automatic job registration. Existing
gross reporting and expense projection do not consume these provider totals. Their
eventual integration needs an explicit gross/expense mapping and settings-evidence
coordinator. Keep alteration Finance guards and runtime switches until that work is
complete. Real Airbnb E2E remains SKIPPED; isolated PostgreSQL tests validate storage.

## Import integration

The booking worker accepts an optional internal `airbnbFinanceSettings` evidence
port. It is not wired in server composition and cannot be supplied by a webhook
or guest request. Its implementation must read verified durable settings evidence
for the exact local property, connection and binding generation, provider property,
booking, channel, revision ID and provider timestamp. No network decision or inferred
historical setting belongs in that lookup. Missing/mismatched evidence rejects the
transaction. A current channel settings read is not a valid implementation.

When this port is provided, an authoritative accepted alteration calls the Finance
writer after canonical dates, total, room mapping and inventory update but before
request completion. All changes and provider-revision bookkeeping share one
transaction. Provider ACK occurs only after commit. Database failure rolls back
Finance with the booking, inventory and request; duplicate delivery produces no
new snapshot. Gross revenue/payment/folio safeguards remain in place.

Once a booking has provider financial history, importing a new revision without the
port is rejected. Ordinary modified revisions use the existing assignment conflict
and availability checks, then append a full provider snapshot in the same transaction.
They bypass the generic provider-amount-as-gross importer. The Finance capture also
uses `appendChannexNightlyRevenueEvidence` with unknown gross nightly amounts and
`appendExternalNightlyRevenueEconomics`, so Booking corrections and linked Finance
commission corrections share the transaction. Provider commission remains separate
from the rule-based commission evidence; it is never deducted from payout again.

The coordinator locks the Hotel Catalog property and location and verifies that
the latest operating calendar uses that exact profile revision and timezone. It
supplies this provenance to the economics writer. A stale/missing profile or timezone
rejects the entire import. Existing revenue is eligible only when every OTA revenue
entry has its original linked commission evidence. Missing links, manual revenue,
existing retained charges, payments and folios remain unsupported. Corrections reuse
the original commission rule; they never reconstruct a historical rule from today's
configuration. Staff decision preflight remains conservative until the production
settings resolver and this coordinator can be guaranteed before a provider send.

Cancellation revisions with currency, provider/channel identity
and verified settings append a `replacement: cancellation` snapshot. Commission is
stored only when supplied; missing total and commission remain null. Current nightly rows
become empty while historical snapshots remain immutable. The provider total is not
interpreted as a retained charge or refund. Missing rooms and totals are allowed;
malformed totals reject the transaction. An unknown provider total leaves the canonical
booking amount unchanged and is explicitly null in the current provider view. Inventory cancellation and provider ACK use
the existing transactional workflow. No cancellation amount is copied from an older
snapshot or fabricated as zero. Untracked bookings retain their existing path.

Live activation still requires the verified evidence-port implementation and a
reviewed cutover. This hook is not registered in server composition.

## Reconciliation checkpoint — 2026-09-16

The four open PRs (#2213, #2226, #2231, #2239) remain one dependency chain;
the import hook is already implemented. No superseding implementation was found
on main `b72b54a57`. Retain these review boundaries rather than adding more PRs
for scaffolding: reader, storage, writer, and transactional import each have a
distinct contract. Further import support belongs in the existing import PR.

The remaining dependencies prevent production activation:

- **Revision-specific settings provenance.** Channex's support reply explains
  the amount basis but does not attest which settings applied to an individual
  revision. The channel reader retains current settings only. A persisted copy
  of that read, an arbitrary receipt reference, or matching revision IDs cannot
  establish historical applicability. The resolver needs an authoritative
  revision-specific attestation or a reviewed settings-history guarantee before
  it can return verified evidence. Do not implement a resolver that silently
  promotes current settings into that guarantee.
- **Financial reconciliation.** Ordinary
  tracked modifications and cancellations, including unknown provider totals, have
  a transactional path described above. Bookings with revenue evidence lacking
  linked commission history, retained charges, payments or folios remain guarded.
  Linked OTA revenue can now be corrected through the atomic economics writer.
  Missing cancellation totals are stored as unknown, never
  zero or a refund. Do not enable the
  feature generally until the guarded cases have an operational resolution path.

The Finance/add-on and OTA availability owners confirmed no overlapping edits
at this checkpoint. Real Airbnb validation remains waived; local synthetic tests
do not resolve either provider-evidence dependency. All runtime and Finance
activation guards remain required.

## Activation design review — 2026-09-16

This is a proposed successor contract, not implemented behavior or authorization
for activation. Review of the current [Channel API](https://docs.channex.io/api-v.1-documentation/channel-api)
and [Bookings Collection](https://docs.channex.io/api-v.1-documentation/bookings-collection)
found current channel settings and booking revisions, but no documented API tying
historical amount settings to each revision. This is a documentation finding, not
proof that Channex has no private mechanism. The supplied support reply explains
amount semantics without providing that historical guarantee. Further resolver
scaffolding cannot supply the missing evidence.

### Proposed path without historical settings evidence

Keep accepting authoritative provider evidence while explicitly representing an
unverified amount basis. Do not classify it as payout, guest-paid total, or gross
revenue. A current settings observation may be retained as an observation, never
as historical proof. Known and unknown classifications need explicit replay and
successor rules; immutable historical snapshots must not be relabeled in place.

This alone does **not** make acceptance ready. The current alteration writer and
ordinary booking worker copy provider amounts into `booking.guest_bookings.total_amount`
and, for unpaid bookings, `balance_amount`. The PMS operations read model exposes
those fields as booking money. An unknown provider basis therefore also needs an
explicit canonical money state and consumer behavior. Retaining an older total
without marking it stale is not sufficient; new bookings cannot use a fabricated
zero. This concern also applies to a verified payout amount: knowing that it is
payout does not establish a guest receivable.

Before implementing this alternative, establish these acceptance criteria across
Booking, Finance, and the PMS display:

1. Preserve raw provider totals, taxes, commission and allocated nights separately;
   unknown basis remains visibly unverified and never enters gross revenue.
2. Authoritative stay/occupancy changes do not silently replace guest receivables.
   Existing and newly imported bookings expose explicit unknown/stale monetary
   state, and PMS/API consumers do not display it as a payable balance.
3. Snapshot validation compares identity, currency, lifecycle, dates and room scope;
   provider-total equality is not used as proof of canonical guest money.
4. Staff acceptance checks that the production import coordinator supports the
   booking before sending. Linked OTA revenue can use the implemented correction
   path; payments, folios, retained charges and unsupported revenue remain blocked.
   Decline remains available when acceptance is blocked.
5. Accepted-provider/import-failure recovery is visible and retryable without a
   second provider decision. Test delayed revisions, basis changes, historical
   replay and rollback, as well as unpaid, paid and invoiced bookings.
6. Initial Airbnb imports and subsequent ordinary modifications use the same
   monetary-state contract; fixing alterations alone leaves inconsistent data.

A smaller first release can expose requests and Decline while keeping Accept
unavailable. It still needs deliberate runtime composition and rollout verification;
this document does not turn on subscriptions, workers or staff actions. Neither
alternative removes the current payment/folio guards or constitutes a merged,
deployed or live-provider-tested feature.

### Implemented monetary separation and display contract

The supported tracked Airbnb alteration/import path preserves canonical
`total_amount` and `balance_amount`, and writes
`booking_metadata.airbnbMoneyStatus = "unverified"` in the same transaction as
provider snapshots and inventory changes. These retained numbers are historical
stored values, not newly verified receivables. The snapshot writer validates
provider identity, currency and updated stay independently of the canonical total.

The operational reservation API adds `pricing.amountStatus` with values `recorded`
and `unverified`. `recorded` means ordinary existing storage semantics, not an
additional verification guarantee. Only explicitly marked records are projected as `unverified`, regardless of
channel. Older/untracked records retain existing `recorded` semantics; this does
not establish that their provider amounts are verified receivables. Initial-import
classification remains a separate activation prerequisite. Numeric fields remain for
wire compatibility; updated PMS consumers must suppress payable/total calculations
when the status is unverified, and show an amount-unverified explanation.

An explicit unverified marker blocks a new staff acceptance with the existing
finance-reconciliation error and releases unsent intent so Decline remains possible.
The manual Mark paid command also rejects explicitly unverified money before
writing a payment or clearing the balance. Already-sent decisions still reconcile
through provider readback. This does not
establish readiness for unmarked bookings or allow unsupported financial histories.

These changes do not implement unknown provider-basis storage, an authoritative
settings resolver, or initial-import canonical unknown money. Generic untracked
imports retain their prior behavior. All activation gates remain off pending the
remaining contract and rollout work above.

### Initial import quarantine and downstream consumers

Initial Airbnb imports now carry the same explicit unverified marker. While the
canonical numeric columns remain non-null for compatibility, their first values
are the supplied provider amount held as unverified legacy data, **not established
guest receivables**. No fabricated zero is inserted. Later Airbnb revisions keep
those original numeric values and replace a small `airbnbProviderAmount` observation
in metadata (amount, currency, revision ID/time, null amount basis). This observation
is neither an immutable financial snapshot nor historical settings evidence.
Missing initial amounts still reject import. A later cancellation can report an
unknown amount without erasing the stored historical numbers.

Every supported Airbnb generic import sends null nightly gross to the atomic
Booking/Finance evidence writer, preserving provider slices outside gross revenue.
It requires current Hotel Catalog timezone/profile provenance matching the operating
calendar. Existing manual revenue, payments/folios, retained charges or revenue
without linked commission history remain guarded instead of being reinterpreted.
Currency changes are rejected rather than relabeling preserved numbers. An enabled
alteration applier without its Finance coordinator fails before mutation. Replay
and stale deliveries cannot replace the current observation. A later write
failure rolls back the booking, marker, observation, inventory and economic evidence.

Consumer rules accompany this import behavior: direct Finance manual settlement
rejects unverified balances; booking email creation/resend and delivery of previously
queued monetary emails are blocked; delivery holds a booking share lock through
sending so a concurrent import cannot commit the marker between the check and send; the direct-booking guest lookup returns its
existing not-found result for explicitly unverified records. Legacy booking/admin
read APIs preserve reservation rows but return null monetary values and an explicit
status, and their screens show Amount unverified. Dashboard booking/occupancy counts
remain intact; monetary sums and currency selection omit unverified records and report incomplete coverage
rather than presenting their provider amounts as revenue.

This supersedes the prior statement that all untracked Airbnb imports retain their
old monetary behavior. Existing unsafe historical revenue is not automatically
backfilled. Verified-basis snapshots still require their settings evidence port;
unknown-basis financial snapshot storage and production activation remain separate.

### Supported unverified approval contract

The internal `allowUnverifiedAirbnbAlterations` capability is off by default. A
reviewed composition must supply it consistently to the decision handler, revision
worker and staff presentation. It is not a request parameter or a verification of
provider money. It permits operational approval only for a quarantined Channex PMS
booking with an exact source reference, no verified-basis snapshot history, no
payments/folios, unpaid payment status, no retained charges and no unsupported revenue evidence. The
shared preflight runs under the booking lock and requires current canonical property timezone
provenance. Availability and request/binding freshness checks still apply. An
unsent unsupported approval releases its intent so Decline remains available.

The authoritative accepted revision updates the stay and inventory and appends
linked Booking/Finance evidence with unknown gross amounts in one transaction.
Canonical money stays frozen and unverified; provider observations remain separate.
Known-basis financial history still requires its verified settings resolver. An
accepted response alone never changes the booking, and retry/readback never sends
a second decision. No production registration or activation is implied.

### Property-scoped runtime composition

`AIRBNB_ALTERATIONS_ENABLED` defaults to false. Enabling requires an explicit
`AIRBNB_ALTERATION_PROPERTY_IDS` scope (1–100 UUIDs or `*` for all connected hotels), authenticated target PMS, target booking
mutation ownership, mutating booking sync/webhooks, background and Channex workers,
and valid provider credentials. Listing import does not enable request decisions.
The wildcard includes future connected hotels without maintaining a UUID list. Empty
or missing scope remains invalid. Bounded scan batches retain active binding claims
and connection checks. One runtime supplies the same scope to staff actions, webhook promotion, periodic
intake, status readback and authoritative alteration application. Other properties
retain ordinary booking import behavior and have no new alteration actions.

The runtime reserves a distinct journal pool using a dedicated application name
and statement timeout, preserving physical separation under the server pool-sharing
layer (eight shared general connections plus one journal connection). It prevents overlapping scans,
and drains in-flight work before closing its pools. A bounded periodic scan finds
requests missed by webhooks; existing durable pagination/retry and readback cadence
remain authoritative. Shutdown rejects new decision commands, drains already-started decisions and aborts background work.
Fastify closes hooks in reverse registration order; runtime shutdown is registered
after the global pool hook so it drains first. No new
subscriptions are created automatically. Rollback disables the setting and restarts
the service; preserve pending/uncertain decision journals and revision jobs for
reconciliation before a later re-enable. Modified revisions with a pending tracked
request are held without ACK when its property is disabled, so ordinary ingestion
cannot consume the revision and strand that request. Never retry a provider POST to resolve an
uncertain outcome. This wiring does not enable any deployment environment.
