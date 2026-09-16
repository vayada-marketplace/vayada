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
They bypass the generic gross-revenue importer. Existing gross revenue, payments or
folios block this path until their separate reconciliation is supported.

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
  a transactional path described above. Bookings with gross revenue/payment/folio
  evidence remain guarded. Missing cancellation totals are stored as unknown, never
  zero or a refund. Do not enable the
  feature generally until the guarded cases have an operational resolution path.

The Finance/add-on and OTA availability owners confirmed no overlapping edits
at this checkpoint. Real Airbnb validation remains waived; local synthetic tests
do not resolve either provider-evidence dependency. All runtime and Finance
activation guards remain required.
