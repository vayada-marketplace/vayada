# Booking, PMS, and Channel Boundaries

_Decision record for the TypeScript backend rewrite. Created after reviewing
current Vayada coupling, the target ownership docs, Channex integration
requirements, and external PMS/channel products such as Guesty, Lodgify,
Hostaway, and SiteMinder._

## Decision

Vayada separates the Booking Engine from PMS operations.

- Booking Engine owns guest-facing direct booking and checkout.
- PMS owns operational stay management, inventory, room assignment, and channel
  connectivity.
- Vayada PMS is one PMS implementation, not the Booking Engine backend.
- External PMS systems must be able to satisfy the same PMS integration
  contracts as Vayada PMS.
- Channex belongs to PMS connectivity because it distributes ARI and delivers
  OTA reservations to a PMS-style system.
- Cross-domain access must use typed interfaces, read models, or domain events.
  Product domains must not open each other's raw tables or database pools as
  normal integration.

This split applies even when Vayada ships multiple capabilities in one UI or one
deployable TypeScript backend. Deployment topology is not domain ownership.

## Definitions

| Term            | Owner                                 | Meaning                                                                                                                                                      |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Booking         | Booking Engine                        | Guest/commercial direct-booking contract: quote, checkout, confirmation, guest-visible status, cancellation/change request, add-ons, promo/referral context. |
| Reservation     | PMS operations                        | Operational stay record: stay dates, operational status, room assignment, check-in/out, no-show, internal notes, housekeeping/turnover impact.               |
| Inventory       | PMS operations                        | Sellable room/unit availability, room blocks, rate restrictions, stop-sell, min/max stay, closed-to-arrival/departure, overbooking prevention.               |
| Quote           | Booking Engine / Distribution         | Public price and availability response with expiry, selected offer, policy version, deep-link context, and typed unavailable reasons.                        |
| Channel booking | PMS operations / channel connectivity | OTA-originated reservation, modification, or cancellation received through Channex or another channel manager.                                               |
| PMS adapter     | PMS integration boundary              | Implementation that lets Vayada talk to Vayada PMS, Guesty, Lodgify, Hostaway, or another PMS behind a stable Vayada interface.                              |

## Domain Responsibilities

### Booking Engine

Booking Engine owns:

- public booking flow and checkout;
- quote/session lifecycle;
- direct booking creation and guest-visible booking status;
- guest lookup, confirmation, cancellation, and change-request contracts;
- promo/referral/add-on application;
- booking idempotency and checkout expiration;
- handoff events or interface calls to a PMS reservation sink.

Booking Engine must not:

- read or write PMS operational tables directly;
- import Channex code or depend on Channex concepts;
- make Vayada PMS database schema part of a Booking route contract;
- own operational room assignment, housekeeping, or channel sync state.

### PMS Operations

PMS owns:

- room types, physical rooms/units, and operational property setup;
- rate plans, rate rules, stay restrictions, inventory, and room blocks;
- operational reservations and room assignments;
- check-in, in-house, checkout, no-show, internal notes, and task impact;
- housekeeping and maintenance tasks;
- channel-manager connectivity and health state;
- Channex property, room, rate, and channel booking mappings;
- ARI pushes and OTA reservation/modification/cancellation ingestion.

PMS must not:

- own public checkout conversion;
- own Booking Engine quote/session contracts;
- treat direct booking payment or promo logic as operational PMS state unless
  exposed through a Booking/Finance read model or event.

### Channel Connectivity

Channex is a channel manager integration used by PMS operations. The Vayada PMS
integration should push ARI to Channex and receive OTA bookings from Channex,
but Booking Engine should not call Channex directly.

At minimum, Channex-facing code should stay behind PMS-owned contracts for:

- property/channel setup;
- room type and rate plan mappings;
- availability, rate, and restriction sync;
- inbound booking revision feed processing;
- channel booking modification and cancellation;
- sync health, retries, audit, and dead-letter visibility.

## Required Boundaries

New TypeScript code must follow these rules:

- `domain-booking` cannot import `domain-pms` implementation modules.
- `domain-booking` cannot import Channex integration modules.
- Booking routes cannot depend on `PMS_DATABASE_URL`, PMS table names, or Vayada
  PMS IDs except as opaque external references carried by an integration
  contract.
- PMS routes cannot own guest-facing checkout or quote contracts.
- Cross-domain reads use read models or service interfaces.
- Cross-domain writes use commands/events with idempotency and audit when they
  can affect guest-visible bookings, inventory, payments, or channel sync.

Current automated enforcement:

- `npm run check:architecture-boundaries` blocks TypeScript Booking route
  adapters from using `PMS_DATABASE_URL`, Channex symbols, or PMS implementation
  imports.
- `.github/workflows/pr-checks.yml` runs that check on PRs.

Planned enforcement:

- VAY-640 extends this into package-level import boundaries once
  `domain-booking`, `domain-pms`, and integration packages exist.
- `engineering/pms-reservation-integration-contract.md` defines the PMS
  reservation integration contracts that Vayada PMS and external PMS adapters
  must implement.
- VAY-642 audits existing legacy coupling and tracks removal order.

The preferred interaction shape is:

```text
Booking Engine
  -> PMS reservation sink interface
    -> Vayada PMS adapter
    -> Guesty adapter
    -> Lodgify adapter
    -> Hostaway adapter
    -> other PMS adapter
```

For reads:

```text
PMS operations
  -> operational reservation/inventory read model

Booking Engine / Distribution
  -> quote and direct-booking read model
```

## Review Checklist

Every rewrite PR touching booking, PMS, Channex, inventory, or reservations must
answer:

- Does this preserve Booking Engine and PMS ownership boundaries?
- Does Booking Engine depend on a PMS interface/read model, not Vayada PMS
  tables?
- Does Channex code live behind PMS connectivity contracts?
- Are reservation concepts named according to the split: guest booking versus
  operational reservation?
- Are cross-domain effects represented as typed commands/events with
  idempotency and audit where needed?
- Is any direct cross-domain database access explicitly temporary and tracked
  with a removal issue?

## References

- `engineering/typescript-backend-structure.md`
- `engineering/backend-database-restructure.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/pms-reservation-integration-contract.md`
- `engineering/public-bookability-contract.md`
- Channex PMS API: https://channex.io/
- Channex PMS integration guide: https://docs.channex.io/guides/pms-integration-guide
- Channex ARI docs: https://docs.channex.io/api-v.1-documentation/ari
- Guesty features: https://www.guesty.com/features/
- Lodgify features: https://www.lodgify.com/all-features/
- Hostaway features: https://www.hostaway.com/features/
- SiteMinder channel manager: https://www.siteminder.com/channel-manager/
