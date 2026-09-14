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
  Airbnb revision. Validate the local booking's property, provider source reference,
  currency, confirmed lifecycle and updated dates/room count/total in the same transaction.
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
