# AI actions design note

_VAY-2499 contract record for the AI Agent & MCP project (Linear P-VAY-35), plan item 1. It records
the plan as decided on 2026-11-18 (plan v3.5; no decision is open). Code facts are from commit
`e0659e30d`; each one links to its line. The full authority lists are in
[ai-actions-authority-inventory.md](ai-actions-authority-inventory.md)._

One list of named **actions** sits under both AI surfaces: the MCP server (outside AI apps such as
Claude and ChatGPT) and the in-app assistant in PMS and Booking Admin. Every action runs as the
signed-in user through the existing `apps/api` routes. Reads return a reduced **projection**.
Changes fall into three groups: **Just do it**, **Ask first** and **Never**.

Where a ticket and this note disagree, this note wins. Where any section and the action policy
table ([§4.4](#44-action-policy-table)) disagree, the table wins.

## 0. Ticket map

| Ticket                                                | Sections it builds on                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAY-2500 spikes                                       | [§5.1](#51-mechanism), [§5.5](#55-mcp-connections), [§8.3](#83-provider-layer), [§11](#11-not-yet-verified)                                                                      |
| VAY-2501 `/api` token check                           | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| VAY-2502 DPA, privacy, terms                          | [§5.5](#55-mcp-connections), [§7.3](#73-retention-and-erasure), [§8.3](#83-provider-layer)                                                                                       |
| VAY-2503 guest-text helpers                           | [§3.3](#33-guest-written-text)                                                                                                                                                   |
| VAY-2504 provider layer, ledger, budgets              | [§8.2](#82-budgets), [§8.3](#83-provider-layer)                                                                                                                                  |
| VAY-2505 Inbox AI buttons                             | [§3.3](#33-guest-written-text), [§8](#8-limits-budgets-and-the-provider-layer)                                                                                                   |
| VAY-2506 delegated reads                              | [§5](#5-delegation-acting-as-the-user), inventory [A](ai-actions-authority-inventory.md#a-owner-session-gates) to [D](ai-actions-authority-inventory.md#d-sql-side-owner-checks) |
| VAY-2507 registry                                     | [§2](#2-the-action-registry), [§3.2](#32-projections), [§6](#6-the-never-list)                                                                                                   |
| VAY-2508 tool-call log                                | [§7](#7-audit-and-attribution), [§10](#10-gaps-found-in-the-code)                                                                                                                |
| VAY-2509 MCP read actions                             | [§3](#3-reads), [§2.4](#24-first-catalog-mcp-read-only-launch)                                                                                                                   |
| VAY-2510 load cap                                     | [§8.1](#81-capacity-and-caps)                                                                                                                                                    |
| VAY-2511, 2514 connection pages                       | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| VAY-2512, 2513 MCP sign-in, connections               | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| VAY-2515 MCP launch                                   | [§5.5](#55-mcp-connections), [§8.1](#81-capacity-and-caps)                                                                                                                       |
| VAY-2516 CSP                                          | [§3.3](#33-guest-written-text)                                                                                                                                                   |
| VAY-2517, 2519 assistant panel                        | [§4.7](#47-ask-first-the-yesno), [§4.8](#48-undo)                                                                                                                                |
| VAY-2518 assistant engine                             | [§4.5](#45-taint), [§4.6](#46-operations-and-the-one-executor), [§8](#8-limits-budgets-and-the-provider-layer)                                                                   |
| VAY-2520 model test                                   | [§8.2](#82-budgets), [§8.3](#83-provider-layer)                                                                                                                                  |
| VAY-2521, 2529 guest data reads                       | [§3.1](#31-read-tiers), [§3.3](#33-guest-written-text), [§4.5](#45-taint)                                                                                                        |
| VAY-2522 write delegation                             | [§5.4](#54-write-delegation-through-authority-sites), inventory [E](ai-actions-authority-inventory.md#e-in-transaction-permission-re-reads)                                      |
| VAY-2523 retry-safe writes                            | [§2.2](#22-registration-rules), [§4.2](#42-effects-and-inverses), [§7.2](#72-attribution-joins)                                                                                  |
| VAY-2524 Ask first + executor                         | [§4.6](#46-operations-and-the-one-executor), [§4.7](#47-ask-first-the-yesno)                                                                                                     |
| VAY-2525, 2526, 2527 change batches                   | [§4](#4-changes)                                                                                                                                                                 |
| VAY-2528 MCP changes                                  | [§4.3](#43-bounds), [§4.7](#47-ask-first-the-yesno)                                                                                                                              |
| VAY-2532, 2560 guest messages, cancellations, refunds | [§4.4](#44-action-policy-table), [§4.7](#47-ask-first-the-yesno)                                                                                                                 |
| VAY-2534 separate AI service                          | [§8.1](#81-capacity-and-caps)                                                                                                                                                    |
| VAY-2535 directory listings                           | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| VAY-2536 AI allowance                                 | [§8.2](#82-budgets)                                                                                                                                                              |
| VAY-2558 assistant and attack tests                   | [§2.3](#23-contract-tests), [§4.5](#45-taint)                                                                                                                                    |
| VAY-2559 Undo                                         | [§4.8](#48-undo)                                                                                                                                                                 |
| VAY-2498 staff daily PMS work                         | [§5.6](#56-who-may-make-changes)                                                                                                                                                 |

## 1. Rules that always hold

1. The AI never has more rights than its user. It acts through the user's own routes, permissions,
   entitlements and property access ([§5](#5-delegation-acting-as-the-user)).
2. Guest-written and third-party text is data, never an instruction ([§3.3](#33-guest-written-text)).
3. Every AI action is logged and attributable to the user and the conversation or connection
   ([§7](#7-audit-and-attribution)).
4. Some actions are never available to any AI, whatever the user's role ([§6](#6-the-never-list)).
   The never-list is a hard rule (D5).
5. A change is Just do it only if vayada can reverse **every** effect of the command it runs
   ([§4.2](#42-effects-and-inverses)).
6. Every change, in both groups and on both surfaces, is one durable **operation** run by one
   **executor**, so a retry, a regenerated model step or a deploy never runs it twice
   ([§4.6](#46-operations-and-the-one-executor)).
7. An Ask-first Yes/No is written by vayada from the stored operation and answered by a person on a
   vayada surface. Text in a chat ("yes, do it") never counts ([§4.7](#47-ask-first-the-yesno)).
8. On MCP, assume anything returned can leave through the hotel's other AI tools. Return less.
9. Every model call goes through the provider layer; customer data goes only to allow-listed EU
   provider setups ([§8.3](#83-provider-layer)).

## 2. The action registry

The registry lives next to the routes in `apps/api` (`src/ai/actions`).

**Decision of 2026-11-20 (full parity):** the AI can do everything a user can do in the website,
with exactly that user's rights, so actions are **generated from next-api's own routes**, not
hand-picked (this replaces "about 10 read actions at launch, about 30 after the first change
batch"):

- **Route list:** `src/ai/routeManifest.generated.ts` is captured from the real app (every route
  module switched on, every route recorded by Fastify's `onRoute` hook) and checked in. CI fails
  when a route is added, renamed or removed without regenerating it, and a static scan of the
  route files cross-checks that the capture missed nothing.
- **Sorting:** `src/ai/routeClassification.ts` sorts every route that is not an action's exactly
  once: `never` ([§6](#6-the-never-list)), `ask_first_later` (rare setup tasks, decided one by one
  when their screen becomes an action), `not_for_ai` (machine traffic, public guest pages, partner
  apps, broken, dead or duplicate routes, reads with side effects, deny-listed reads, owner-session
  gates) or `later` (a hotel route that is not an action yet; VAY-2567 ranks the order). CI fails on
  an unsorted route and reports how many hotel routes are actions.
- **One action per route** (`defineRouteAction`): the route, its method and its path parameters
  come from the route list; a person writes the description, the output allow-list, the permission,
  the tier or group and the surfaces, and is named as the reviewer. Composite actions hide
  multi-step flows (for example the four pricing-v2 steps) and call base actions, never routes
  directly.
- **Generated safety tests** run every action through its real route on fake storage
  (`src/ai/actions/actionSafety.test.ts`); an action without a fixture fails CI.

### 2.1 Fields

| Field            | Meaning                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name@version`   | Namespaced, e.g. `bookings_search@1`. A changed input or output schema is a new version.                                                                                    |
| `description`    | When to call it and what it returns. Never contains hotel data.                                                                                                             |
| `input`          | Hand-written strict zod object. Ids are UUIDs or enums. Takes the canonical `propertyId`; the action maps it to the Booking Admin `hotelId` itself when a route needs that. |
| `output`         | Zod allow-list schema with unknown keys stripped (the projection, [§3.2](#32-projections)). Untrusted text wrapped ([§3.3](#33-guest-written-text)), size caps, pagination. |
| `tier`           | Reads: `R0`, `R1`, `R2-finance`, `R2` ([§3.1](#31-read-tiers)). Changes: `do` (Just do it) or `ask` (Ask first) ([§4.1](#41-the-three-groups)).                             |
| `undo`           | `do` only: what is captured before the change and how it is reversed ([§4.8](#48-undo)).                                                                                    |
| `bounds`         | `do` only: the limits past which the same change becomes `ask` ([§4.3](#43-bounds)).                                                                                        |
| `effects`        | Changes only: every outward or durable effect of the command and its inverse ([§4.2](#42-effects-and-inverses)).                                                            |
| `businessKey`    | Changes only: how a retry finds the same operation, e.g. room block = property + rooms + dates ([§4.6](#46-operations-and-the-one-executor)).                               |
| `routeCalls`     | The exact method and route templates the action may call. Reads: `GET` only.                                                                                                |
| `permission`     | The key the route **really** checks, so the action is never shown to a role the route refuses.                                                                              |
| `authoritySites` | Changes only: the in-transaction and SQL-side checks the route hits ([§5.4](#54-write-delegation-through-authority-sites)).                                                 |
| `surfaces`       | `mcp`, `in_app` or both. Concierge calls its domain services directly; the registry wraps the same services as actions (e.g. availability, [§3.2](#32-projections)).        |
| `reviewedBy`     | Who reviewed the description, the output allow-list and the group (plan v3.7 `source`; the route itself is the action's `route`).                                           |
| `idempotency`    | How a retry is made safe.                                                                                                                                                   |

### 2.2 Registration rules

An action cannot be registered when:

- it is `do` without an `undo` that covers every effect in `effects`;
- it changes something and has no `idempotency`, no `businessKey` or no preconditions;
- it calls a route outside its `routeCalls`, or a read calls a non-`GET` route;
- its route is sorted in `src/ai/routeClassification.ts` at all (never, ask first later, not for
  AI, or still `later`): the registry throws at module load, so the app does not start;
- (since 2026-11-20) `ownerOnly` routes and role-key owner gates are no longer refused as a class:
  an action may use one only through the route's own owner check, so only an owner's delegation
  passes; routes behind an owner-session gate (inventory
  [A](ai-actions-authority-inventory.md#a-owner-session-gates)) are sorted `not_for_ai` until
  VAY-2567 decides each;
- it changes something and an `authoritySites` entry does not take the delegation yet
  ([§5.4](#54-write-delegation-through-authority-sites));
- the route has no frontend caller today, until it is hardened and tested (e.g. the refund route).

Routes without idempotency, actor or audit get those first (VAY-2523): booking settings, add-on
and promo create, guest profile edit and merge, and a required key on change/extras decisions.

### 2.3 Contract tests

- Never-list: no action's route is sorted `never`; one real route per never area is pinned in the
  classification test; the auth hook accepts only registered actions' routes.
- Method allow-list enforced; MCP and in-app list identical schemas for the same action.
- Cross-tenant denial for every action: other organization, other property, assigned-only member.
- Output fixtures fail on any unknown key.
- Every change declares idempotency, a business key, preconditions and effects; every `do` change
  undoes cleanly, including edits that land during capture and during the undo.
- Every exposed change persists the attribution join keys ([§7.2](#72-attribution-joins)).
- A delegated context never passes an owner-session gate ([§5.3](#53-what-delegation-never-passes)).

### 2.4 First catalog (MCP read-only launch)

R0/R1 only. No guest-written text (guest names included) and no contact data until the owner
turns them on (D12); no money fields unless finance is enabled for the connection.

| Action                                                   | Job                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `properties_list`                                        | which properties I can act on                                                                                        |
| `briefing_today`                                         | counts: arrivals, departures, in-house, not checked in, pending requests, unread threads, channel alerts             |
| `bookings_search` / `bookings_get`                       | find a booking by reference, dates, room or a name the user types; no guest names, no amounts without finance access |
| `bookings_unpaid`                                        | balances due in a range (finance only)                                                                               |
| `availability_search`, `availability_nearest_free_dates` | free? price per stay? (stay prices; no stored quote)                                                                 |
| `calendar_get`                                           | occupancy and blocks for a range                                                                                     |
| `pricing_get`                                            | prices, min stay, closures                                                                                           |
| `performance_compare`                                    | this period vs last year; revenue and ADR only with finance access                                                   |
| `rooms_status`                                           | room states                                                                                                          |
| `channel_alerts_list`                                    | channel sync problems                                                                                                |
| `why_not_bookable`                                       | why a date or room is not for sale                                                                                   |

The routes and fields behind each are in [§3.2](#32-projections). In-app adds R2 reads later:
inbox threads, arrivals with requests, reviews, guest contact, check-in readiness (no ID numbers),
returning guests.

## 3. Reads

### 3.1 Read tiers

Tiers are about what data leaves vayada.

| Tier             | Contents                                                                                                                                                                                                                                                            | Where                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `R0` public      | stay prices, free windows, public property facts                                                                                                                                                                                                                    | every surface; per-connection cap                                                                                                                                              |
| `R1` operational | arrival and departure counts and lists (reference, room, dates; guest names in-app only, wrapped as untrusted text, [§3.3](#33-guest-written-text)), bookings without contact data, free text or amounts, calendar, rates, rooms, room status, channel alert status | MCP and in-app; on MCP without guest names (D12)                                                                                                                               |
| `R2-finance`     | balances, amounts due, totals, payments, revenue, ADR, P&L                                                                                                                                                                                                          | needs `pms.finance.read`, the financial entitlement and the owner/finance relationship the finance routes check; on MCP only when the owner enables finance for the connection |
| `R2` sensitive   | guest email and phone; guest-written text (inbox bodies, reviews, special requests, notes)                                                                                                                                                                          | in-app first; on MCP only after the owner's opt-in per kind (VAY-2529), and never contact data and free text on one connection. Guest names follow the same opt-in on MCP      |

`quote_create` is not R0: it inserts an append-only quote row with no cleanup, so it stays out until
a quote retention policy exists.

### 3.2 Projections

A projection is the action's output allow-list. It drops every field the action's tier does not
allow, **even when the route returns it under a permission the user has**. Today the routes hand
out more than the tiers allow, so the projection is the control, not the route. No hotel or guest
table carries an AI flag: `ai_visible` exists only on eight internal `platform.*` tables, pinned to
`false` ([`0010_platform_jobs_events_audit.sql:748-754`](../packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql#L748)).

**Words used below.**

- **Finance money:** amounts owed, paid or earned: booking totals and balances, per-night applied
  amounts, payments and their state, refunds, fees, payouts, revenue, ADR, P&L. Shown only with
  **finance access**, defined as the Financials module check: `pms.finance.read`, a `hotel_group`
  organization, the `pms:property-management` and `pms:module:financials` entitlements, and the
  owner or finance-manager relationship
  ([`financeDashboard.ts:71-77`](../apps/api/src/routes/financeDashboard.ts#L71)). The code has
  two looser variants (`finance.ts` also admits operators; the PMS reservation redactor checks the
  permission only, [`pmsOperations.ts:5907-5925`](../apps/api/src/routes/pmsOperations.ts#L5907));
  the action layer uses the strict one.
- **Sell prices** (public stay prices, rate-plan prices) are not finance money: stay prices are
  `R0`, rate-plan prices follow the route's `pms.rooms_rates.read`.

**Routes no action may call**, because they return data no projection should ever receive:

| Route                                                                                                                                                                           | Why                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/booking/hotels/:hotelId/reservations` ([`bookingReservations.ts:128`](../apps/api/src/routes/bookingReservations.ts#L128))                                            | returns platform fee and payout under `booking.reservation.read` (it returned passport number, date of birth and gender too, until VAY-2562) |
| `GET /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-registrations` ([`pmsGuestRegistrations.ts:106`](../apps/api/src/routes/pmsGuestRegistrations.ts#L106)) | ID document number, type, date of birth ([`:26`](../apps/api/src/routes/pmsGuestRegistrations.ts#L26))                                       |
| `GET .../reservations/:guestBookingId/additional-guests` ([`pmsOperations.ts:3199`](../apps/api/src/routes/pmsOperations.ts#L3199))                                             | full guest personal data                                                                                                                     |
| `GET /api/pms/properties` ([`pmsOperations.ts:1354-1368`](../apps/api/src/routes/pmsOperations.ts#L1354))                                                                       | always answers 500 after its auth check                                                                                                      |

The registry's contract test keeps a deny-list of these next to the allow-lists. The reservation
notes `GET` ([`pmsOperations.ts:3923`](../apps/api/src/routes/pmsOperations.ts#L3923)) returns staff
free text: it is an `R2` read for the in-app assistant later (VAY-2521), never on MCP before the
owner's opt-in.

**Per action.** "Drop" = never in the output; "finance" = only with finance access.

| Action                             | Backing route(s)                                                                                                                                                                                                                                                     | Route checks                                                    | Projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `properties_list`                  | `GET /api/hotel-setup/status` ([`sharedHotelSetupStatus.ts:213`](../apps/api/src/routes/sharedHotelSetupStatus.ts#L213))                                                                                                                                             | `hotel_catalog.property_manifest.read`, member's property scope | keep `propertyId`, `displayName`, `locationSummary`; drop organization and setup fields. It checks no PMS or Booking entitlement, so each later action still relies on its own route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `briefing_today`                   | reservations list ([`pmsOperations.ts:3019`](../apps/api/src/routes/pmsOperations.ts#L3019)) for arrival, in-house, departure and not-checked-in counts; `GET .../messaging/unread-count` ([`:2217`](../apps/api/src/routes/pmsOperations.ts#L2217)); channel alerts | `pms.reservation.read`, `pms.inbox.read`                        | counts only, never rows. The stay-range read has no status filter and no limit ([`pmsOperationsReadModel.ts:781-801`](../apps/api/src/domains/pmsOperationsReadModel.ts#L781)): count in the action and exclude cancelled. No route lists pending guest change/extras requests for a property                                                                                                                                                                                                                                                                                                                                                                            |
| `bookings_search` / `bookings_get` | reservations list and detail ([`pmsOperations.ts:3019`](../apps/api/src/routes/pmsOperations.ts#L3019), [`:3087`](../apps/api/src/routes/pmsOperations.ts#L3087))                                                                                                    | `pms.reservation.read`                                          | keep reference, status, source, stay dates, room count, room name, assignments (room type, room number, status), add-on names, check-in/out state. Drop `primaryGuest.displayName`, `specialRequests`, `email`, `phone`, `countryCode` and `additionalGuests`. Finance: `pricing.*` ([`pmsOperationsReadModel.ts:1595-1605`](../apps/api/src/domains/pmsOperationsReadModel.ts#L1595)), `assignments[].nightly[].applied`, `roomLines[].totals` and `rateSummary`, `payment.*`, `cancellationOutcome`, `cardRefund`. Searching by a typed guest name is fine; the answer still carries no names. There is no room filter: filter a stay-range read by room in the action |
| `bookings_unpaid`                  | **no route** filters on balance due                                                                                                                                                                                                                                  |                                                                 | new read, or filter the reservations list in the action; finance only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `availability_search`              | the Concierge availability and stay-price domain service (VAY-2533), called in-process                                                                                                                                                                               | the action checks membership and property scope itself          | `R0`. **Not** the public `stay-prices` route ([`bookingWebPublic.ts:552`](../apps/api/src/routes/bookingWebPublic.ts#L552)): it ignores the caller, shares per-IP limits and the busy guard with live guests, and takes write-grade locks (plan 3.10)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `availability_nearest_free_dates`  | the same domain service; no route returns this for one hotel today (only the agency page search returns one next free window)                                                                                                                                        | as above                                                        | `R0`; the service can reuse `readFreeWindows` ([`agencyNextFreeDates.ts:114`](../apps/api/src/domains/agencyNextFreeDates.ts#L114))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `calendar_get`                     | `GET .../calendar` and `GET .../room-blocks` ([`pmsOperations.ts:1653`](../apps/api/src/routes/pmsOperations.ts#L1653), [`:1703`](../apps/api/src/routes/pmsOperations.ts#L1703))                                                                                    | `pms.calendar.read`                                             | keep per-night counts and status, block dates and counts. Drop `assignmentRefs` (other bookings' ids), `blocks[].sourceSummary` ("Booking <reference>"), `blocks[].reason` (staff free text up to 1,000 characters), `sourceFreshness`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pricing_get`                      | `GET .../pricing-v2` ([`replacementPricing.ts:337`](../apps/api/src/routes/replacementPricing.ts#L337)), `.../not-selling`                                                                                                                                           | `pms.rooms_rates.read`, owner/operator                          | keep rate rules, restrictions and not-selling reasons; drop `sources` and `ownerReferences`. It returns rules, not per-date prices: per-date prices run the calculator in the action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `performance_compare`              | Booking dashboard `stats` and `bookings-by-source` ([`bookingDashboard.ts:92`](../apps/api/src/routes/bookingDashboard.ts#L92), [`:130`](../apps/api/src/routes/bookingDashboard.ts#L130)); Financials revenue for finance users                                     | `booking.analytics.read`; Financials check                      | keep booking counts and source counts. Finance: `totalRevenue`, `avgNightlyRate`, `revenue`, `revenueSharePercent` (the dashboard returns them under `booking.analytics.read` alone). Occupancy has no route: compute it from calendar counts                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `rooms_status`                     | `GET .../rooms` ([`pmsOperations.ts:1466`](../apps/api/src/routes/pmsOperations.ts#L1466))                                                                                                                                                                           | `pms.room_status.read`                                          | keep room number, floor, room type, status (available, maintenance, out of order, retired); drop `metadata`. There is no housekeeping (clean/dirty) state anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `channel_alerts_list`              | `GET .../channex/alerts` ([`pmsChannexManagement.ts:112`](../apps/api/src/routes/pmsChannexManagement.ts#L112))                                                                                                                                                      | `pms.operations.read` (owners only today)                       | keep event type, dates, channel, error type, counts. Drop the recovery fields read from `platform.jobs` (status, attempts, retry time; inventory F19), `impact.bookingId`, `revisionId`, `channelId` and provider ids; the OTA's own reservation code (`impact.reference`) only for users with `pms.reservation.read`                                                                                                                                                                                                                                                                                                                                                    |
| `why_not_bookable`                 | composed: calendar, room blocks, pricing-v2 restrictions, not-selling                                                                                                                                                                                                | as above                                                        | reasons only. Two reasons have no route: the inventory rate gate and "room type is closing"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Four facts every read action must handle:

- **Property scope.** Some reads check only the organization's property links, not the member's
  assigned properties: Channex ([`pmsChannexManagement.ts:473-491`](../apps/api/src/routes/pmsChannexManagement.ts#L473)),
  operating calendar, pricing source, flexible rate plan and the booking-settings check. The action
  checks the member's scope itself before calling them.
- **Locks.** Every pricing-v2 read and every public stay-price read takes the inventory lock and
  `identity.organizations ... FOR UPDATE`
  ([`replacementPricingAuthorization.ts:58-63`](../apps/api/src/domains/replacementPricingAuthorization.ts#L58)),
  so AI reads queue behind staff price saves and bookings. VAY-2510's load test covers these reads.
- **Platform rows.** Some answers carry values read from `platform.*` job and event rows
  (inventory [F19](ai-actions-authority-inventory.md#f19-reading-platform-audit--job--event-rows)):
  the channel alerts' recovery fields and an inbox thread's `providerActions`. Projections drop
  them; that is how these reads stay off the never-list.
- **Booking settings.** All booking-settings reads need `booking.settings.manage`, including the
  hotelId-to-propertyId mapping (`GET /api/booking/hotels/:hotelId/property-link`,
  [`bookingSettings.ts:2198`](../apps/api/src/routes/bookingSettings.ts#L2198)). The `:hotelId`
  routes also accept the canonical property id, so actions pass `propertyId` and skip the mapping.

### 3.3 Guest-written text

- **Carriers:** OTA inbox bodies (up to 100,000 characters), thread previews, OTA reviews and
  reviewer names, special requests, guest names and emails (direct and OTA), sender names,
  attachment names, guest profiles, Airbnb listing titles, Channex alert references, Concierge
  messages. Nothing is sanitised today.
- **Wrapping:** labelled fields `{untrusted: true, source, author, text}`, never mixed into
  vayada's own sentences. Normalise control, zero-width and bidi characters. Caps: names 60,
  requests 300, message bodies 2,000 in detail views. Defang URLs and markdown links and images.
- **Never sent to any AI:** guest ID document data, `pms.guest_registrations.document_number`, the
  legacy `booking.checkout_contexts.guest_input`.
- **In-app rendering:** model output is plain text (no raw HTML, no images, no autolinks), with an
  app-wide CSP and `frame-ancestors 'none'` (VAY-2516; neither app sends either today).
- **Sends:** AI drafts are marked; the send route blocks exact emails, phone numbers and booking
  references that the conversation read from other bookings.
- Reading guest text taints the conversation ([§4.5](#45-taint)).

## 4. Changes

### 4.1 The three groups

These replace the earlier tiers W1, W2 and W3 and the proposal/approval design (Flamur,
2026-11-16: "this whole approve flow is far to much friction").

| Group                 | Meaning                                        | How it runs                                                                                                     |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Just do it** (`do`) | vayada can reverse every effect of the command | runs at once inside its bounds; logged; Undo on the change card and on the AI activity page                     |
| **Ask first** (`ask`) | anything Undo can not fully reverse            | one Yes/No written by vayada from the stored operation: in the in-app chat, or on a one-tap vayada page for MCP |
| **Never**             | the never-list                                 | no action exists                                                                                                |

Every change, in both groups, ends with a **change card** written by vayada from the result, never
by the model, listing every outward effect ("Closed Deluxe 12-14 Dec. Pushed to Booking.com and
Airbnb. Undo"). If a person has an open pricing draft for the same room type, a price action stops
and asks instead of overwriting it.

The group is judged on **every effect of the command**, not on the field it is named after. A room
move looks like a small edit, but a move to another room type clears the rate plan and can
re-price the booking, so it is Ask first.

### 4.2 Effects and inverses

Every outward or durable effect of each command an action may run, and what reverses it today.
Channex is reached by a once-a-minute scan of the inventory and pricing tables, not by the
commands themselves
([`pmsChannexAriSchedule.ts:5-22`](../apps/api/src/jobs/pmsChannexAriSchedule.ts#L5)). So an Undo
that writes the old state back also pushes the old values to the OTAs, but a sale made in between
stays. All paths below are under `apps/api/src/`.

| Command                                           | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Existing inverse                                                                                                                                                                                    | Consequence for the group                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| booking note add                                  | one private note row ([`pmsOperationsCommandRepository.ts:1075-1104`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L1075))                                                                                                                                                                                                                                                                                                                                                                                                  | delete by id, no version check ([`:1347-1353`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L1347))                                                                                    | `do`; VAY-2559 adds a conditional delete. Deleting a note is not an AI action: the text is kept nowhere ([`:1367`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L1367))                                                                                                                                                                                                    |
| thread done / follow-up / reopen                  | thread state, a domain event, a follow-up job; the OTA is not called ([`pmsInboxTriageCommand.ts:478-513`](../apps/api/src/domains/pmsInboxTriageCommand.ts#L478))                                                                                                                                                                                                                                                                                                                                                                       | the other two routes, lossy: reopen always lands on "needs attention" and clears done and follow-up fields ([`:645-649`](../apps/api/src/domains/pmsInboxTriageCommand.ts#L645))                    | `do`; the undo record keeps the previous state and follow-up time. A follow-up time that has passed can not be restored                                                                                                                                                                                                                                                                 |
| room status                                       | inventory and bookability recompute ([`pmsPhysicalRoomInventory.ts:130-167`](../apps/api/src/domains/pmsPhysicalRoomInventory.ts#L130))                                                                                                                                                                                                                                                                                                                                                                                                  | set back to available                                                                                                                                                                               | `do`, but the route refuses a change away from available when the room type has future inventory ([`:63-77`](../apps/api/src/domains/pmsPhysicalRoomInventory.ts#L63)) or the room ever had a block or assignment ([`pmsPhysicalRoomManagementRepository.ts:209-231`](../apps/api/src/domains/pmsPhysicalRoomManagementRepository.ts#L209)). For a live room the action is a room block |
| room block create / release                       | availability on the public page and the OTAs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | create → release; release → a new block, which fails if the room sold in between ([`pmsOperationsCommandRepository.ts:2537-2553`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L2537)) | `do`; the card for a release says its Undo can fail                                                                                                                                                                                                                                                                                                                                     |
| room move, same room type                         | assignment row and calendar projection only ([`:7415`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L7415))                                                                                                                                                                                                                                                                                                                                                                                                                 | move back if the room is still free                                                                                                                                                                 | `do`                                                                                                                                                                                                                                                                                                                                                                                    |
| room move, other room type                        | rate plan cleared ([`:6771`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L6771)), booked offer link dropped ([`:6780`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L6780)), availability of both types; `target_base` appends revenue corrections ([`:6921`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L6921))                                                                                                                                                                               | none: moving back restores neither                                                                                                                                                                  | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| check-in                                          | check-in record and assignment status; nothing outward                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none: status only moves forward ([`:302-310`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L302))                                                                                      | `ask` until VAY-2559 adds the reverse command                                                                                                                                                                                                                                                                                                                                           |
| check-out                                         | final check-out writes add-on revenue evidence; add-ons not listed as fulfilled are recorded as missing and can not be corrected later ([`bookingAddonRevenueEvidence.ts:233-239`](../apps/api/src/domains/bookingAddonRevenueEvidence.ts#L233), [`:128`](../apps/api/src/domains/bookingAddonRevenueEvidence.ts#L128))                                                                                                                                                                                                                  | none                                                                                                                                                                                                | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| expense create                                    | one expense row; nothing outward                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | delete = a reversal dated today ([`financeManualExpenseRepository.ts:490-529`](../apps/api/src/domains/financeManualExpenseRepository.ts#L490))                                                     | `do` for a one-off expense dated this month. An earlier date is `ask` (Undo would move the amount between months); a `recurrence` is `ask` (no route reverses the generated expenses)                                                                                                                                                                                                   |
| manual booking                                    | guest confirmation email, **always today** ([`pmsManualBookingPersistence.ts:68-89`](../apps/api/src/domains/pmsManualBookingPersistence.ts#L68); the body has no switch, [`pmsManualBookingCreate.ts:84-112`](../apps/api/src/routes/pmsManualBookingCreate.ts#L84)); inventory and OTA availability; revenue evidence; a payment row when paid; the room optimizer may re-arrange other bookings' unpinned rooms ([`pmsManualBookingCommandRepository.ts:117-125`](../apps/api/src/domains/pmsManualBookingCommandRepository.ts#L117)) | cancel, before check-in only, which sends a second email; other rooms are not put back                                                                                                              | `ask`. The plan keeps the guest email off by default, so VAY-2525 adds the switch the route lacks; the card shows any re-arranged rooms                                                                                                                                                                                                                                                 |
| prices, min stay, open/close (pricing-v2 publish) | public page and OTAs; open guest quotes become stale; the charges step stores a permanent "all mandatory charges included" declaration ([`replacementChargeDeclarations.ts:92-94`](../apps/api/src/domains/replacementChargeDeclarations.ts#L92))                                                                                                                                                                                                                                                                                        | publish the old values as a new revision; a declaration has none                                                                                                                                    | `do` within bounds when the publish needs no new charges declaration. A new declaration has no inverse, so that publish is `ask` and its card shows the statement (VAY-2526 checks when one is needed)                                                                                                                                                                                  |
| promo code create                                 | live in checkout at once (`isActive` defaults to true, [`bookingPromoCodes.ts:500`](../apps/api/src/routes/bookingPromoCodes.ts#L500)); no idempotency key, no audit row                                                                                                                                                                                                                                                                                                                                                                 | deactivate or retire; redemptions stay                                                                                                                                                              | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| cancel, edit dates, refund (host actions)         | guest email ([`bookingHostActions.ts:624`](../apps/api/src/domains/bookingHostActions.ts#L624)); Stripe void or refund; inventory and OTA; revenue evidence                                                                                                                                                                                                                                                                                                                                                                              | cancel and reject: none. Edit dates: edit again (a second email)                                                                                                                                    | `ask` (P5)                                                                                                                                                                                                                                                                                                                                                                              |
| accept request, mark paid                         | Stripe capture inside the open database transaction ([`pricingRequestAcceptance.ts:130-134`](../apps/api/src/domains/pricingRequestAcceptance.ts#L130)); guest email on most branches; payment rows                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                                                                                                | `ask` (P5)                                                                                                                                                                                                                                                                                                                                                                              |
| change / extras request decision                  | change accept moves dates, price and availability (Airbnb: the decision goes to Airbnb); extras decisions email the guest                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                                                                                                                                                | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| inbox reply                                       | guest email or OTA message, with no delay ([`pmsInboxReplyCommand.ts:824-861`](../apps/api/src/domains/pmsInboxReplyCommand.ts#L824))                                                                                                                                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| review reply                                      | public reply on the OTA, sent inside the request ([`pmsReviewReplies.ts:155-158`](../apps/api/src/domains/pmsReviewReplies.ts#L155))                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                                                                                                                | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |
| booking page publish                              | new public page content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none routed                                                                                                                                                                                         | `ask`                                                                                                                                                                                                                                                                                                                                                                                   |

### 4.3 Bounds

A Just-do-it change past any bound becomes Ask first for the part past the bound (one Ask-first
card for the rest). Defaults (D4d); owners can tighten them, not loosen them:

| Bound                                                                                          | In-app    | MCP       |
| ---------------------------------------------------------------------------------------------- | --------- | --------- |
| calendar cells changed (room type x rate x night, including derived rates that move with it)   | 60        | 30        |
| properties touched                                                                             | 1         | 1         |
| price move from **baseline** (the price before the first AI change to that cell in the window) | ±30%      | ±15%      |
| price below the property's floor price                                                         | any: asks | any: asks |
| bookings or rooms touched                                                                      | 5         | 2         |
| closing a date that has arrivals                                                               | any: asks | any: asks |

The plan sets MCP bounds at half the in-app values. This note halves the numeric bounds (60 cells
to 30, ±30% to ±15%, 5 bookings to 2, rounding down); the one-property bound and the floor and
arrivals rules are the same on both. No floor price exists in the code yet
([§10](#10-gaps-found-in-the-code)).

Bounds are **cumulative**: counted per property over a rolling 24 hours across every AI surface,
conversation and connection, and reserved atomically before a change runs, so many small changes
can not add up to a big one.

Why bounds exist: prices, closures, blocks and room moves push availability and rates to the OTAs
through Channex. Undo pushes the old values back, but an OTA booking taken in between stays.

### 4.4 Action policy table

Authoritative. "Tainted" is defined in [§4.5](#45-taint). Every MCP Ask-first action is answered
on the one-tap vayada page.

| Action                                                                                                                                         | In-app                                                                              | MCP                              | When tainted                                                   | Outward effects shown on the card                                                                    | Ticket             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| booking note add                                                                                                                               | do                                                                                  | do                               | ask                                                            | none (internal)                                                                                      | VAY-2525           |
| thread done / follow-up / reopen; room status                                                                                                  | do                                                                                  | do                               | ask                                                            | none (internal)                                                                                      | VAY-2525           |
| room block create / release                                                                                                                    | do                                                                                  | do                               | ask                                                            | availability pushed to OTAs                                                                          | VAY-2525           |
| room move / assign, same room type                                                                                                             | do                                                                                  | do                               | ask                                                            | availability pushed to OTAs                                                                          | VAY-2525           |
| room move to another room type                                                                                                                 | ask                                                                                 | ask                              | ask                                                            | rate plan cleared; booking re-priced (`target_base`); OTA push                                       | VAY-2525           |
| check-in                                                                                                                                       | ask until VAY-2559 adds its reverse command, then do                                | same                             | ask                                                            | check-in record                                                                                      | VAY-2525, VAY-2559 |
| check-out                                                                                                                                      | ask (do only if VAY-2559 also reverses the add-on revenue evidence)                 | same                             | ask                                                            | add-on revenue evidence on final check-out                                                           | VAY-2525, VAY-2559 |
| expense create                                                                                                                                 | do (one-off, dated this month); otherwise ask                                       | same                             | ask                                                            | finance row (undo = reversal)                                                                        | VAY-2525           |
| manual booking (guest email off by default)                                                                                                    | ask                                                                                 | ask                              | ask                                                            | inventory taken; OTA push; other bookings' rooms re-arranged; the guest email when it is switched on | VAY-2525           |
| prices / min stay / open-close within cumulative bounds                                                                                        | do (ask when a new charges declaration is needed, [§4.2](#42-effects-and-inverses)) | do (half bounds), same exception | ask                                                            | rates and availability pushed to OTAs                                                                | VAY-2526           |
| any `do` change past its bounds                                                                                                                | ask                                                                                 | ask                              | ask                                                            | as the action                                                                                        | VAY-2525, VAY-2526 |
| reply / review / description draft, unsaved (P3)                                                                                               | do                                                                                  | -                                | do into the thread or booking in focus                         | none                                                                                                 | VAY-2518           |
| reply / review / description draft, saved (P4)                                                                                                 | do                                                                                  | do                               | unsaved draft into the thread or booking in focus; saving asks | none until sent                                                                                      | VAY-2527, VAY-2559 |
| promo code create (AI caps)                                                                                                                    | ask                                                                                 | ask                              | ask                                                            | bookable discount                                                                                    | VAY-2527           |
| send guest message / confirmation email; publish review reply; mark paid; accept/reject request; change/extras decisions; publish booking page | ask (P5)                                                                            | ask (P5)                         | ask                                                            | the exact message, email or page                                                                     | VAY-2532           |
| cancel; edit dates; refunds                                                                                                                    | ask (P5)                                                                            | ask (P5)                         | ask                                                            | the guest email it queues; OTA push; money moved                                                     | VAY-2560           |
| never-list ([§6](#6-the-never-list))                                                                                                           | none                                                                                | none                             | none                                                           | -                                                                                                    | -                  |

AI caps on promo codes: at most 20% off, an expiry is required and at most 90 days away, a small
required maximum number of uses. Routes with no frontend caller (correct-stays, correct-prices,
payout dispatch, several pricing and review routes) stay unexposed until proven.

### 4.5 Taint

Taint is the prompt-injection guard (D4b). It is kept **per conversation**, not per turn:

- Once an in-app conversation has read guest-written text (directly, or through a summary or draft
  made from it), every Just-do-it change in it becomes Ask first, except unsaved drafts into the
  thread or booking in focus.
- A change in the same model step as a guest-text read counts as tainted.
- Only a new conversation clears it.
- On MCP no guest-written text is returned until the owner opts in (D12, VAY-2529). With that
  opt-in on, the whole connection counts as tainted.

### 4.6 Operations and the one executor

Every change is one row in **`ai_operations`**, written **before** anything runs: id (128-bit),
organization, property, user, conversation or connection, action and version, group, business key,
canonical arguments, **preconditions** (the revisions or current values it expects), preview
digest, status, execution lease, step cursor, per-step results, link to the undo record.

States:

```text
Ask first:   pending --Yes--> running --> done | failed
             pending --No / expiry / revoke / kill switch--> closed
Just do it:  running --> done | failed
running with an expired lease --> resumed by the recovery job (same steps, same keys)
```

- **One executor** runs every operation, step by step, with a per-step idempotency key
  (`operation id + step`) and a lease so exactly one worker wins. Multi-step changes (the four
  pricing steps) use the same machinery.
- **Retries never run a change twice.** An MCP resend, a regenerated model step (a new provider
  tool-call id) or a resume after a deploy finds the row by its business key and gets the stored
  result. Provider and transport ids are logged, never used as the identity.
- **Preconditions on every write.** A retry of "set price to 100" after a person changed it to 150
  is refused ("this changed since"), not applied.
- The model, Mastra, the AI SDK and the browser never execute a change. They create the row or
  answer it. The SDK's and Mastra's own tool approval is not used, because on continuation they
  would execute the tool themselves and make a second executor.
- Ask-first rows expire after 15 minutes, or at the route preview's own expiry if sooner
  (host-action previews last 10 minutes). A preview is never refreshed behind a card; a new preview
  means a new card.
- A Yes is refused, and the row closed, when the connection was revoked, the conversation closed
  or an AI kill switch is on.

### 4.7 Ask first: the Yes/No

The card is rendered by vayada from the stored operation: what will happen, to whom, the exact
message text or amount, and every outward effect the command generates (e.g. the guest email a
cancellation queues). Never from model text.

**In-app:** the model calls the action; the server checks permission and bounds, builds the
route's own preview where one exists, stores the `pending` operation and tells the model "waiting
for the person's answer"; the turn ends. **Yes** is
`POST /api/ai/pending-actions/:id/answer` from the first-party browser session (app `client_id`,
Origin and CSRF checks), same user and organization, with permission re-checked, the conversation
still active, no kill switch on, and the digest and revisions unchanged (otherwise "this changed,
ask me again"). A second click, another tab or a resumed turn joins the same run.

**MCP (D4a):** every Ask-first action, for every client, is answered on a **one-tap vayada page**:
the same card on its own small page, signed-in vayada session whose user must equal the token's
user, not frameable, CSRF-protected, no extra login. The pending operation is bound to the token's
user, its verified `client_id`, a digest of the exact arguments, single use. The link reaches the
person by URL elicitation only when the session negotiated MCP `2026-07-28` and the client declared
URL elicitation; otherwise it is in the tool result. Nothing that happens inside the AI app counts
as a Yes: MCP lets a client fill a form "from other sources", and automation in the apps can
approve tools for the person.

**MCP specifics (VAY-2528).** Just do it runs with half bounds and the MCP caps. Tool labels are
honest: the apps' rules treat edits such as price changes as `destructiveHint: true`, so some apps
prompt the person anyway; on MCP "Just do it" means "no vayada step", not "no prompt in every
app". Tool arguments and results use names, dates and amounts, not only ids, because the apps show
them in their own prompts. Undo is also a tool (`undo_change`) and a button on the AI activity page.

Refunds and card capture need no extra login (D4c): only roles that may refund or accept today get
these actions, plus daily caps.

### 4.8 Undo

- Before a `do` change runs, its **undo record** (`ai_changes`, linked to the operation) stores
  the exact fields or cells with their before values and revisions; after it runs, the committed
  after values and the **new revisions** from the route's result.
- Undo runs as the person who presses it, through the same routes and delegation, as its own
  operation (`Idempotency-Key` = undo record id). It **compares and restores in one transaction
  against the recorded revisions**, never against equal values. Anything changed since is listed
  ("3 of 40 prices changed since; restore the other 37?"), never silently overwritten. Routes
  without a version check get one first.
- Undo window: 7 days, or until the date has passed. One Undo per change; an undo is itself logged
  and can be undone the same way.
- The card says plainly what Undo can not fix: OTA bookings taken between the change and the undo.

### 4.9 Daily caps

Starting values: Just-do-it changes 100 a day per user in-app, 50 a day per MCP connection;
Ask-first actions 20 a day per user in-app, 10 a day per MCP connection; cancellations and refunds
5 a day per MCP connection. Counted from the tool-call log ([§7.1](#71-tool-call-log)).

## 5. Delegation: acting as the user

### 5.1 Mechanism

The action calls the existing route in-process with Fastify `app.inject()` inside an
`AsyncLocalStorage` scope that holds an already-resolved delegated `RequestContext`.

- The auth plugin's `onRequest` hook
  ([`plugin.ts:53`](../packages/backend-auth/src/plugin.ts#L53)) uses that context only when the
  store is present. External requests can never set it: no header, no handle, no token.
- The store is bound to the method and route template the action declared; the plugin rejects a
  mismatch with `request.routeOptions.url`.
- The scope is **one-shot**: consumed by the auth hook of the intended injected request, refused
  for a second or nested `inject` and for detached async work started inside it, and it never
  reaches an outbound HTTP request.
- Identity is resolved once per tool call.
- Injected requests carry no `Origin`; PMS routes accept that
  ([`pmsOperations.ts:4895-4896`](../apps/api/src/routes/pmsOperations.ts#L4895)).
- Fallback if the spike shows the scope does not reach `onRequest`: a single-use handle bound to
  method, route and body digest. Long term, hot actions move to typed `handle(context, input)`
  functions.

### 5.2 The delegated context

- `audit.source = "agent"`. The type already allows it
  ([`types.ts:86`](../packages/backend-auth/src/types.ts#L86)); today the plugin always sets `"api"`
  ([`plugin.ts:63`](../packages/backend-auth/src/plugin.ts#L63)).
- `delegation = { channel, connectionId | conversationId, toolCallId }`. Request id = the tool-call
  id. Correlation id = the operation id for a change (so a change that runs after a Yes still joins
  its tool call), the tool-call id for a read.
- Only `hotel_group` organizations; platform organizations are refused.
- `providerIdentity.sessionId` is **always absent**. The resolver copies the token's `sid` into it
  ([`resolve.ts:100`](../packages/backend-auth/src/resolve.ts#L100)), routes treat any session id
  as proof of an owner browser session (inventory [A](ai-actions-authority-inventory.md#a-owner-session-gates)),
  and on an MCP token `sid` is a WorkOS consent id. The consent id is stored on the connection
  instead.
- The delegation can only narrow: fewer properties, read-only. It never adds a permission.

### 5.3 What delegation never passes

Delegation refuses by default, and no action may call, a route behind:

- an owner-session gate (inventory [A](ai-actions-authority-inventory.md#a-owner-session-gates),
  12 checks; a test asserts a delegated context never passes one);
- an `ownerOnly` policy (inventory [B](ai-actions-authority-inventory.md#b-owneronly-route-policies), 17 routes);
- a direct `hotel_owner` check (inventory [C](ai-actions-authority-inventory.md#c-direct-hotel_owner-checks-in-typescript), 13 gates);
- a SQL-side owner check (inventory [D](ai-actions-authority-inventory.md#d-sql-side-owner-checks), 6 queries);
- the never-list ([§6](#6-the-never-list)).

How the refusal works: the auth plugin accepts a delegated scope only for a method and route
template that a registered action lists in `routeCalls`, and registration refuses any action that
lists one of the routes above ([§2.2](#22-registration-rules)). Nothing inside the gated handlers
knows about delegation: a delegated owner would pass the SQL checks in inventory D if a request
ever reached them. The allow-list is the guard.

### 5.4 Write delegation through authority sites

The first MCP release is `GET` only; the action layer is the primary gate and the delegation
narrows property lists. **Before any change action ships**, every in-transaction permission
re-read it hits must take the delegation as input, with a test per command family that a read-only
or property-limited delegation is refused. The sites are listed in inventory
[E](ai-actions-authority-inventory.md#e-in-transaction-permission-re-reads): 5 shared helpers and
12 local scope locks.

Two things to know when doing this (VAY-2522):

- Most local scope locks join `identity.role_permission_grants` on the membership's `role_key`
  (e.g. [`pmsManageScope.ts:9-28`](../apps/api/src/domains/pmsManageScope.ts#L9)). They see neither
  team-role definitions nor per-member overrides, and a delegated context passes them whenever the
  user's base role holds the key.
- The commands in `pmsOperationsCommandRepository.ts` (notes, room blocks, room moves, check-in,
  check-out) have no in-transaction re-read except room type retire
  ([`:3396`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L3396)); they rely on the
  route check. The re-reads a P4/P5 change does hit are: `lockPmsInboxRolePermissions` (thread
  done / follow-up / reopen, replies); `lockReplacementPricingAuthorization` (prices through
  pricing-v2); `lockAuthorizedPmsPhysicalRoomScope` (room status, through
  [`pmsPhysicalRoomManagementRepository.ts:74`](../apps/api/src/domains/pmsPhysicalRoomManagementRepository.ts#L74));
  `lockMemberPermissions` (booking page publish,
  [`bookingPublicationCommandRepository.ts:346`](../apps/api/src/domains/bookingPublicationCommandRepository.ts#L346));
  and `lockPmsManageScope` (closures, operating calendar).

### 5.5 MCP connections

**Tokens and sign-in.**

- `/api` hardening ships before any WorkOS Connect change (VAY-2501): today the verifier accepts a
  token whose `aud` names the app when `client_id` is absent
  ([`verify.ts:80-94`](../packages/backend-auth/src/verify.ts#L80)). Require `client_id` equal to
  the app client, drop the `aud` fallback in production, reject any `sub_profile` and any MCP
  audience, and prove on staging that a real Connect token is refused. MCP tokens are never
  accepted by `/api`, `/api` tokens never by `/mcp`, and the MCP handler ignores
  `request.authContext`.
- Login mode (D11): Standalone Connect (vayada's own login and consent page) if the spike works,
  else the hosted AuthKit page.
- Per call, connection first: verify the token (JWKS, issuer, `aud` = MCP URL, no `sub_profile`),
  then load the connection by (WorkOS user, `client_id`, consent id), take the organization **from
  the connection row** (a token `org_id` must match it exactly), then resolve user and membership
  for that organization. The existing resolver takes the organization from the token
  ([`resolve.ts:66-68`](../packages/backend-auth/src/resolve.ts#L66)), so the MCP path uses a
  variant.

**Who may connect (D3, decided 2026-11-17).**

- MCP is **on by default** for every hotel; the owner can switch it off.
- **Any vayada user** may connect, front desk included, and the AI gets exactly that user's rights.
- **Personal AI accounts** are allowed, free ones included. The terms say the hotel and its users
  choose their AI app and are responsible for that choice; the connect page shows the tip "check
  your AI app's training setting" (wording confirmed in VAY-2502).
- A new connection can make Just-do-it changes from its first minute (risk accepted 2026-11-17).
  Revisit only if the VAY-2500 two-browser test shows the sign-in is not tied to the account that
  started it.

**Which apps.** Known apps only: Claude, Claude Code, ChatGPT, Codex, by CIMD client id, checked
when the connection is created and on every call; dynamic client registration is off. A hotel can
ask for another app; vayada checks it once and adds it to the known-apps list for **all hotels**.
An app not on the list gets no access, and there is no per-hotel owner approval (decided
2026-11-18).

**Activation and alerts.** Every new connection is activated on a signed-in vayada page with the
consent shown every time, never remembered (one Claude or ChatGPT client id is shared by all their
users). The owner gets an email at once for each new connection, and one daily summary email of
AI changes. "Connected AI apps" pages in both apps: your own connections; the owner sees all;
revoke one; revoke all.

**Lifetimes and revocation.** Maximum lifetime 90 days, idle 30 days. Revoking disables vayada's
row at once (checked per call). The WorkOS authorization is deleted only when the user has no other
active connection for that client, or on full offboarding, because WorkOS revokes per user and
client across accounts. Staff removal, suspension and loss of product access disable all of the
user's connections (extend [`staffRemoval.ts`](../packages/backend-auth/src/staffRemoval.ts)).

**Rollout.** One week on our own test properties, then all hotels; the switch is on for everyone
from day one either way. Directory listings (VAY-2535) after clean first weeks with all hotels.

### 5.6 Who may make changes

D13 (decided 2026-11-17): staff connect and read at once; their AI changes wait for VAY-2498.
VAY-2498 shipped on 2026-11-18: notes, room moves, check-in, check-out and manual bookings now
check `pms.reservation.update`
([`pmsOperations.ts:3989`](../apps/api/src/routes/pmsOperations.ts#L3989),
[`:4127`](../apps/api/src/routes/pmsOperations.ts#L4127),
[`:4298`](../apps/api/src/routes/pmsOperations.ts#L4298),
[`:3805`](../apps/api/src/routes/pmsOperations.ts#L3805),
[`pmsManualBookingCreate.ts:270`](../apps/api/src/routes/pmsManualBookingCreate.ts#L270)) and
room blocks `pms.calendar.manage`
([`pmsOperations.ts:1763`](../apps/api/src/routes/pmsOperations.ts#L1763)), which staff roles can
hold. So when AI changes ship (P4), staff get them with exactly their own rights. Room status
([`pmsPhysicalRoomUnits.ts:257`](../apps/api/src/routes/pmsPhysicalRoomUnits.ts#L257)) and mark
paid still check the broad `pms.operations.manage`; the AI layer does not paper over that.

## 6. The never-list

A hard rule (D5): no action exists for these, for any role, on any surface. **Flamur's list of
2026-11-20** (it replaces the longer list this section had before):

- bank accounts and payouts (payout destination, the guest bank-transfer account, Stripe and Xendit
  provider accounts and links, payout dispatch, payout reconciliation)
- team members and permissions (staff invites, roles, member removal, account-admin transfer,
  joining an account)
- deleting a property
- login and security settings
- accepting legal terms (agreements, consent, the mandatory-charges statement)
- billing and plan
- bulk exports
- privacy (GDPR) export and delete
- guest ID documents
- login and AI-connection management
- partner-app approvals
- platform and vayada staff routes, including reading `platform.*` audit, job and event rows
  (their tables carry `CHECK (ai_visible = FALSE)`, e.g.
  [`0010_platform_jobs_events_audit.sql:754`](../packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql#L754))

**Ask first later** (no action now; each becomes Ask first when its screen becomes an action,
decided one by one): custom domain, Channex connect and disconnect (and the Airbnb import), product
tracks and Feature Hub modules, payment settings and windows, data retention. A guest review on
Airbnb written by the AI is Ask first, never Just do it.

**Outside AI apps (MCP)** get no guest names, contact details or money until the owner turns them
on (VAY-2529), even though the user's rights are the ceiling: `defineRouteAction` refuses an MCP
action whose allow-list keeps a field named like one.

The Google Maps link resolver and media imports (the server fetches a URL the caller gives) are
`not_for_ai`.

Owner-only and in-app-only, later and on demand: no-show reports, folio finalise and delete, guest
merge, currency change. Card refunds and refunding cancellations are **not** on the list: they are
Ask first (VAY-2560) for the roles that may refund today.

The routes behind each item are sorted in `apps/api/src/ai/routeClassification.ts`; inventory
[F](ai-actions-authority-inventory.md#f-never-list-routes) has the evidence for each.

## 7. Audit and attribution

### 7.1 Tool-call log

One `ai_tool_calls` row per call: organization, property, user, channel, connection or
conversation, client id, provider + model + region (in-app), action and version, tier or group,
redacted arguments, outcome, latency, the `Idempotency-Key` sent, resource ids returned,
correlation id, operation id. R2 reads are also security events. Daily caps are counted from this
log, time-bucketed, with no global hot row.

### 7.2 Attribution joins

No new columns on every writer. The route's own audit row links back to the AI tool call through
the two join keys `platform.product_audit_events` already has: `idempotency_key_id` and
`correlation_id`
([`0010_platform_jobs_events_audit.sql:733-734`](../packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql#L733)).
A contract test per exposed change asserts the route persists both. `actor_type` stays `user`
([`:719-722`](../packages/backend-migration/migrations/0010_platform_jobs_events_audit.sql#L719)):
the person whose rights were used, and who pressed Yes, is accountable.

**Today the joins do not hold for most commands.** The resolver sets no correlation id
([`resolve.ts:134-140`](../packages/backend-auth/src/resolve.ts#L134)) and the plugin makes a
random request id ([`plugin.ts:60`](../packages/backend-auth/src/plugin.ts#L60)), so
`correlation_id` is a server id nobody else knows. The delegated context sets the correlation id to
the operation id or tool-call id ([§5.2](#52-the-delegated-context)), which fixes the commands that write
`correlationId ?? requestId`. The rest need route work before their action is registered:

| Command                                                                                                   | Audit row                                                                                                                                                               | `idempotency_key_id` | `correlation_id`                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| room move / assign                                                                                        | **none** ([`pmsOperationsCommandRepository.ts:1391-1556`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L1391) writes none, though its metadata claims one) | -                    | -                                                                                                      |
| promo code create; change / extras decisions                                                              | **none**                                                                                                                                                                | -                    | -                                                                                                      |
| booking note add                                                                                          | yes                                                                                                                                                                     | no                   | the body `commandId` ([`:5522`](../apps/api/src/domains/pmsOperationsCommandRepository.ts#L5522))      |
| room block, check-in, check-out, accept, mark paid, review reply                                          | yes                                                                                                                                                                     | no                   | request id                                                                                             |
| confirmation email                                                                                        | yes                                                                                                                                                                     | no                   | `NULL` ([`bookingEmails.ts:325`](../apps/api/src/jobs/bookingEmails.ts#L325))                          |
| pricing-v2 draft, charges, publish                                                                        | yes                                                                                                                                                                     | no                   | no ([`replacementPricingStore.ts:57-59`](../apps/api/src/domains/replacementPricingStore.ts#L57))      |
| host actions (cancel, edit dates, reject)                                                                 | yes                                                                                                                                                                     | yes                  | the preview id ([`bookingHostActions.ts:421-422`](../apps/api/src/domains/bookingHostActions.ts#L421)) |
| thread done / follow-up / reopen, inbox reply, room status, expense, manual booking, booking page publish | yes                                                                                                                                                                     | yes                  | request id                                                                                             |

### 7.3 Retention and erasure

The new tables (tool-call arguments, operations including pending ones and previews, undo records,
transcripts) are wired into the guest retention worker and the GDPR delete flow:

| Data               | Kept                             |
| ------------------ | -------------------------------- |
| transcripts        | 30 days, owner-configurable (D8) |
| pending operations | 90 days                          |
| undo records       | until the undo window closes     |
| tool-call log      | 2 years, arguments redacted      |

Anything Mastra stores (threads, messages, workflow snapshots, spans) falls under the same rules,
in its own schema; vayada's own records win if the two disagree. GDPR erasure that touches a
conversation closes it instead of editing its history.

## 8. Limits, budgets and the provider layer

### 8.1 Capacity and caps

- MCP launches **inside next-api** with a hard cap, a per-account limit and a load test sized for
  all hotels and all their users at once. The separate AI service (VAY-2534) comes when load shows
  the need (decided 2026-11-17).
- Per-process AI concurrency cap: start at 3 in-flight tool executions, queue with a timeout, then 429. A separate provider-call limit covers every AI surface (Inbox assist, in-app assistant,
  Concierge).
- Never hold a database client across a model call; follow the Inbox assist pattern of a prepare
  transaction and a finalize transaction
  ([`pmsInboxAssistance.ts:154-235`](../apps/api/src/domains/pmsInboxAssistance.ts#L154)).
- Starting limits: MCP 30 calls a minute and 1,000 a day per connection, lists at most 50 rows,
  plus a per-account and a global MCP limit; in-app 50 turns a day per user. A per-IP limiter and
  body-size cap sit in front of `/mcp` before token verification.
- Kill switches per account, per surface, global, and per provider.
- Alerts: a new client followed by a burst; reads across all properties; Just-do-it changes in
  bursts; many "No" answers or undos; DLP blocks; an Ask-first answer from a different user.

### 8.2 Budgets

- One monthly AI budget per account, across all providers and surfaces (in-app, Inbox assist,
  Concierge). MCP model cost is on the user's own AI account; vayada pays only server load there.
- **Only vayada staff can raise a hotel's AI budget. The owner can not** (decided 2026-11-17). The
  "AI allowance used up" message offers the owner no way to raise it. Raising a budget is a
  platform-staff action, so it is on the never-list for every AI.
- The amount per hotel is set before launch from the model test's cost per conversation
  (VAY-2520). Paid top-ups come later (VAY-2536).
- Before each provider call, atomically reserve the estimated maximum cost (prefix estimate +
  `max_tokens`), reconcile after. At 100%: no further model calls until vayada staff raise the
  budget or the month resets. Two concurrent turns per account. Spend alarms (VAY-2504).
- D6 (decided 2026-11-17): MCP is included with limits; the in-app assistant is included with a
  generous allowance; one meter is shared with Concierge, costed per provider and model.

### 8.3 Provider layer

All model calls go through one thin interface in `apps/api/src/ai`: `run(task, input, tools,
options)`, `stream(...)` and the agent and workflow runs. The rest of the code never imports the
framework directly. Underneath: **Mastra** on the Vercel AI SDK, checked first in VAY-2500; if it
fails, the AI SDK alone behind the same interface.

- **Task -> provider + model + region**, stored as config together with the test run that picked
  it. Starting tasks: `inbox_translate`, `inbox_summarise`, `inbox_draft`, `assistant_chat`,
  `concierge_understand`, `concierge_reply`. Each task has a fallback list used only by an
  operator switch or the per-provider kill switch, never silently mid-conversation.
- One model per conversation; a model switch starts a new conversation.
- Customer data goes only to an allow-listed combination of provider, account or project,
  endpoint, source region, model and features, each with its DPA row (VAY-2502). Claude on Bedrock
  through the `eu.` profile is the first; OpenAI, Gemini and Mistral all go into the model test and
  the best becomes the second provider (D2a). The Anthropic API has no EU option and gets only
  synthetic test data.
- What stays vayada's own code: the registry, delegation, the executor, Ask first and Undo, bounds,
  the never-list, the conversation store, the ledger and budgets, caps. Mastra runs the loop and
  workflows and never runs a change. Its tables live in their own schema, created by a migration.

## 9. Decisions recorded here

| Decision (plan decision log)                                                                                                                                                                                                   | Section                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three groups replace approvals (row 3, 2026-11-16)                                                                                                                                                                             | [§4.1](#41-the-three-groups)                                                                                                                                                     |
| No lock-in, provider layer (row 1); Mastra (row 7)                                                                                                                                                                             | [§8.3](#83-provider-layer)                                                                                                                                                       |
| D4a: MCP Ask first on a one-tap vayada page (row 6)                                                                                                                                                                            | [§4.7](#47-ask-first-the-yesno)                                                                                                                                                  |
| D4b taint per conversation, D4c no extra login, D4d bounds (rows 8-10)                                                                                                                                                         | [§4.5](#45-taint), [§4.7](#47-ask-first-the-yesno), [§4.3](#43-bounds)                                                                                                           |
| D1 order (row 11): gates, then Inbox assist and the foundation, then the MCP read-only launch for all hotels, then the in-app assistant, then AI changes, then guest messages, cancellations and refunds (milestones P0 to P5) | [§0](#0-ticket-map)                                                                                                                                                              |
| D6 pricing (row 11)                                                                                                                                                                                                            | [§8.2](#82-budgets)                                                                                                                                                              |
| D5 never-list, D8 retention, D9 directories, D10 hosting, D11 login, D12 guest text on MCP, D13 staff (row 11)                                                                                                                 | [§6](#6-the-never-list), [§7.3](#73-retention-and-erasure), [§5.5](#55-mcp-connections), [§8.1](#81-capacity-and-caps), [§3.1](#31-read-tiers), [§5.6](#56-who-may-make-changes) |
| D3 who may connect (rows 12-13)                                                                                                                                                                                                | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| MCP inside next-api first (row 14)                                                                                                                                                                                             | [§8.1](#81-capacity-and-caps)                                                                                                                                                    |
| Terms and training-setting tip (row 15)                                                                                                                                                                                        | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| Changes from the first minute (row 16)                                                                                                                                                                                         | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| Staff read now, change after VAY-2498 (row 17)                                                                                                                                                                                 | [§5.6](#56-who-may-make-changes)                                                                                                                                                 |
| Known apps only (row 18); vayada adds apps for all hotels (row 24)                                                                                                                                                             | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| Owner email per connection, daily summary of changes (row 19)                                                                                                                                                                  | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| Test week, then all hotels (row 20); directories after clean weeks (row 21)                                                                                                                                                    | [§5.5](#55-mcp-connections)                                                                                                                                                      |
| D2a three providers in the model test (row 22)                                                                                                                                                                                 | [§8.3](#83-provider-layer)                                                                                                                                                       |
| Only vayada staff raise a hotel's AI budget (row 23)                                                                                                                                                                           | [§8.2](#82-budgets)                                                                                                                                                              |

## 10. Gaps found in the code

Facts found while writing this note that a later ticket must handle. The ticket named owns it.

| Gap                                                                                                                                                                         | Where                            | Ticket                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| Attribution join keys missing or meaningless for most commands                                                                                                              | [§7.2](#72-attribution-joins)    | VAY-2508 (test), VAY-2523 and each batch ticket (fix) |
| Manual booking always emails the guest today; the plan's "guest email off by default" needs a switch the route does not have                                                | [§4.2](#42-effects-and-inverses) | VAY-2525                                              |
| Routes hand out finance money and guest data under non-finance keys (the Booking Admin list's passport numbers were removed by VAY-2562)                                    | [§3.2](#32-projections)          | VAY-2507, VAY-2509                                    |
| Planned reads with no route: balances due, nearest free dates for one hotel, pending guest requests per property, occupancy, housekeeping state, two "not bookable" reasons | [§3.2](#32-projections)          | VAY-2509                                              |
| `GET /api/pms/properties` always answers 500                                                                                                                                | [§3.2](#32-projections)          | VAY-2509 (use `/api/hotel-setup/status`)              |
| Some reads check the organization's properties, not the member's                                                                                                            | [§3.2](#32-projections)          | VAY-2506                                              |
| Price reads take write-grade locks                                                                                                                                          | [§3.2](#32-projections)          | VAY-2510                                              |
| Channel alerts need `pms.operations.read` (owners only); the staff key `pms.channel_manager.read` gates no route                                                            | [§3.2](#32-projections)          | VAY-2509                                              |
| No property floor price exists in the code, so the floor-price bound can not fire yet                                                                                       | [§4.3](#43-bounds)               | VAY-2526                                              |
| Room status changes are refused for live rooms; room blocks are the real tool                                                                                               | [§4.2](#42-effects-and-inverses) | VAY-2525                                              |
| Expense Undo moves money between months; recurring expenses can not be reversed                                                                                             | [§4.2](#42-effects-and-inverses) | VAY-2525                                              |
| The price composite's charges step records a permanent "all mandatory charges included" statement for the hotel                                                             | [§4.2](#42-effects-and-inverses) | VAY-2526                                              |
| Stripe capture and void run inside an open database transaction, so money can move while the booking change rolls back                                                      | [§4.2](#42-effects-and-inverses) | VAY-2524, VAY-2532, VAY-2560                          |
| Inbox replies send with no delay; "held" replies are never released                                                                                                         | [§4.2](#42-effects-and-inverses) | VAY-2532                                              |
| Promo create has no idempotency key and no audit row; change-request decisions fall back to the request id without a header                                                 | [§2.2](#22-registration-rules)   | VAY-2523                                              |

## 11. Not yet verified

These are assumptions until VAY-2500 checks them:

- The `AsyncLocalStorage` scope reaches Fastify 5's `onRequest` through `app.inject()`, is
  one-shot, and never reaches nested or outbound requests ([§5.1](#51-mechanism)).
- Standalone Connect works with our login; WorkOS issues `client_id` and a default resource
  indicator as expected; per-client revoke behaves as described ([§5.5](#55-mcp-connections)).
- claude.ai and ChatGPT tie the OAuth callback to the account that started it (two-browser test).
- Mastra passes its seven checks (own Postgres schema, Fastify/ECS, Bedrock EU, Ask first in a
  workflow, MCP, licence, token estimates) ([§8.3](#83-provider-layer)).
