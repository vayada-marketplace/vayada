# PMS Reservation Integration Contract

_VAY-641 contract record. Builds on
`engineering/booking-pms-domain-boundaries.md`, VAY-639, and the TypeScript
backend rewrite contracts._

## Purpose

Booking Engine must be able to hand a confirmed direct booking to Vayada PMS,
Guesty, Lodgify, Hostaway, or another PMS without making Booking Engine depend
on any one PMS schema or API.

This contract defines the Vayada-owned boundary for that handoff. It is not a
concrete adapter implementation and it does not change current Python PMS or
Channex behavior before a reviewed cutover.

## Boundary

Owner package:

- `domain-pms` owns operational reservation contracts and PMS adapter ports.

Consumers:

- `domain-booking` may call the reservation sink interface after it has created
  or changed a guest-facing direct booking.
- PMS admin/calendar surfaces may read operational reservation state through the
  read interface.
- Jobs/events may retry handoffs and record provider outcomes.

Non-consumers:

- Booking Engine routes must not call Vayada PMS tables, Channex tables,
  `PMS_DATABASE_URL`, or provider-specific PMS clients directly.
- Channex remains PMS-owned channel connectivity. Booking Engine never calls
  Channex as part of this contract.

## Language Split

| Term                                | Owner          | Meaning                                                                                         |
| ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `guestBookingId`                    | Booking Engine | Vayada guest-facing direct booking identity. Used in guest emails, checkout, and lookup flows.  |
| `pmsReservationRef`                 | PMS adapter    | Opaque reference to an operational reservation in Vayada PMS or an external PMS.                |
| `operationalReservationId`          | PMS operations | Vayada internal operational reservation identity when the PMS implementation is Vayada-owned.   |
| `externalReservationId`             | PMS adapter    | Provider-native reservation ID. Opaque to Booking Engine.                                       |
| `channelReservationRef`             | PMS operations | OTA/channel reservation identity, when the reservation originated from Channex or another feed. |
| `propertyId`                        | Hotel catalog  | Canonical Vayada property identity. Adapter implementations map this to provider properties.    |
| `pmsPropertyRef` / `pmsRoomTypeRef` | PMS adapter    | Provider-native property, unit, room-type, or rate-plan references. Opaque outside the adapter. |

Booking Engine may store `pmsReservationRef` and provider name as opaque values
for status display and retries. It must not parse provider IDs or infer
operational state from provider-specific formats.

## Contract Version

Every command and result carries:

```ts
type PmsReservationContractVersion = "pms-reservation.v1";
```

Breaking changes require a new version. Additive fields are allowed when they
are documented here first and adapter behavior remains backward compatible.

## Shared Types

```ts
type PmsProviderKey = "vayada_pms" | "guesty" | "lodgify" | "hostaway" | "custom";

type PmsCapability =
  | "create_reservation"
  | "update_stay_dates"
  | "update_guest_details"
  | "update_room_type"
  | "cancel_reservation"
  | "read_operational_reservation"
  | "read_inventory_assignments";

type PmsConnectionStatus =
  | "connected"
  | "disconnected"
  | "suspended"
  | "degraded"
  | "setup_incomplete";

type PmsReservationStatus =
  | "pending_handoff"
  | "confirmed"
  | "modified"
  | "cancelled"
  | "checked_in"
  | "in_house"
  | "checked_out"
  | "no_show"
  | "failed";

type PmsMoney = {
  amount: number;
  currency: string;
};

type PmsAuditContext = {
  requestId: string;
  correlationId: string;
  causationId?: string;
  organizationId: string;
  propertyId: string;
  actorType: "guest" | "hotel_user" | "system" | "platform_admin";
  actorId?: string;
  source: "booking_engine" | "pms_admin" | "job_retry" | "migration" | "test";
  occurredAt: string;
};

type PmsExternalReference = {
  provider: PmsProviderKey;
  connectionId: string;
  externalReservationId?: string;
  externalPropertyId?: string;
  externalRoomTypeId?: string;
  externalRatePlanId?: string;
  opaqueProviderData?: Record<string, string | number | boolean | null>;
};
```

`opaqueProviderData` is adapter-owned metadata for diagnostics and retries. It
must not be required by Booking Engine business logic.

## Reservation Sink Port

The sink port is the only synchronous application boundary Booking Engine may
call for guest-visible reservation handoff.

```ts
interface PmsReservationSink {
  createReservation(command: CreatePmsReservationCommand): Promise<PmsReservationHandoffResult>;

  updateReservation(command: UpdatePmsReservationCommand): Promise<PmsReservationHandoffResult>;

  cancelReservation(command: CancelPmsReservationCommand): Promise<PmsReservationHandoffResult>;
}
```

Implementations may complete synchronously or accept the command for async
processing. A synchronous return of `accepted` means the command is durably
recorded and retryable; it does not mean the external PMS already confirmed the
change.

## Create Command

```ts
type CreatePmsReservationCommand = {
  contractVersion: "pms-reservation.v1";
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    requiredCapabilities: ["create_reservation"];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
    status: "confirmed";
    createdAt: string;
    source: "direct_booking";
    locale: string;
  };
  stay: {
    checkInDate: string;
    checkOutDate: string;
    adults: number;
    children: number;
    numberOfRooms: number;
    estimatedArrivalTime?: string | null;
    specialRequests?: string | null;
  };
  guests: {
    primary: PmsGuest;
    additional?: PmsGuest[];
  };
  bookedOffer: {
    roomTypeId: string;
    ratePlanId?: string | null;
    roomName: string;
    roomTypeExternalRef?: PmsExternalReference;
    ratePlanExternalRef?: PmsExternalReference;
  };
  pricing: {
    roomTotal: PmsMoney;
    taxesAndFees?: PmsMoney;
    discounts?: PmsMoney;
    addonsTotal?: PmsMoney;
    grandTotal: PmsMoney;
  };
  payment: {
    paymentStatus: "unpaid" | "authorized" | "partially_paid" | "paid";
    paymentMethod?: "card" | "pay_at_property" | "bank_transfer" | "other";
    depositAmount?: PmsMoney;
    balanceAmount?: PmsMoney;
    providerPaymentRef?: string;
  };
  policy: {
    cancellationPolicyId?: string;
    cancellationSummary?: string;
    refundableUntil?: string | null;
  };
};

type PmsGuest = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  dateOfBirth?: string | null;
};
```

Create commands should be emitted only after Booking Engine has committed the
guest-facing booking. The PMS handoff must not be the source of truth for
whether checkout succeeded.

## Update Command

```ts
type UpdatePmsReservationCommand = {
  contractVersion: "pms-reservation.v1";
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    pmsReservationRef: string;
    requiredCapabilities: PmsCapability[];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
  };
  changes: {
    stay?: Partial<CreatePmsReservationCommand["stay"]>;
    guests?: Partial<CreatePmsReservationCommand["guests"]>;
    bookedOffer?: Partial<CreatePmsReservationCommand["bookedOffer"]>;
    pricing?: Partial<CreatePmsReservationCommand["pricing"]>;
    payment?: Partial<CreatePmsReservationCommand["payment"]>;
    policy?: Partial<CreatePmsReservationCommand["policy"]>;
  };
  expectedPreviousVersion?: string;
};
```

Adapters must reject unsupported partial changes with
`UNSUPPORTED_CAPABILITY`. Booking Engine should then choose a product-visible
fallback, such as a manual review state, instead of reaching around the
adapter.

## Cancel Command

```ts
type CancelPmsReservationCommand = {
  contractVersion: "pms-reservation.v1";
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    pmsReservationRef: string;
    requiredCapabilities: ["cancel_reservation"];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
  };
  cancellation: {
    reason:
      | "guest_requested"
      | "hotel_declined"
      | "payment_failed"
      | "no_show"
      | "platform_action"
      | "other";
    cancelledAt: string;
    penaltyAmount?: PmsMoney;
    refundAmount?: PmsMoney;
    note?: string;
  };
};
```

Cancellation commands describe the Booking Engine outcome. A PMS adapter may
map that to a provider-specific cancellation, but Booking Engine must not depend
on provider-specific cancellation reason codes.

## Handoff Result

```ts
type PmsReservationHandoffResult = {
  contractVersion: "pms-reservation.v1";
  commandId: string;
  idempotencyKey: string;
  outcome: "succeeded" | "accepted" | "duplicate_replayed" | "noop" | "failed";
  guestBookingId: string;
  pmsReservationRef?: string;
  operationalReservationId?: string;
  externalReference?: PmsExternalReference;
  status?: PmsReservationStatus;
  providerVersion?: string;
  providerRequestId?: string;
  auditEventId: string;
  retryAfter?: string;
  error?: PmsReservationError;
};
```

Result rules:

- `succeeded` means the PMS operation is confirmed.
- `accepted` means a durable job/outbox record exists and will drive the
  provider call.
- `duplicate_replayed` means the same idempotency key and payload already
  produced this result.
- `noop` means the requested state already exists.
- `failed` must include a typed `PmsReservationError`.

## Error Contract

```ts
type PmsReservationError = {
  code:
    | "PMS_DISCONNECTED"
    | "UNSUPPORTED_CAPABILITY"
    | "DUPLICATE_RESERVATION"
    | "MAPPING_MISSING"
    | "RETRYABLE_INTEGRATION_FAILURE"
    | "IDEMPOTENCY_CONFLICT"
    | "VALIDATION_FAILED"
    | "CONFLICT"
    | "PROVIDER_REJECTED";
  retryable: boolean;
  userVisibleCategory:
    | "manual_review_required"
    | "temporary_unavailable"
    | "configuration_required"
    | "already_exists"
    | "invalid_request";
  sanitizedMessage: string;
  providerStatusCode?: number;
  providerErrorCode?: string;
  providerRequestId?: string;
};
```

Required states:

| Code                            | Retryable | Meaning                                                                                  | Expected handling                                                               |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `PMS_DISCONNECTED`              | No        | No active PMS connection exists for the property.                                        | Put booking into manual PMS follow-up; surface setup issue to hotel/admin.      |
| `UNSUPPORTED_CAPABILITY`        | No        | Adapter cannot perform the requested create/update/cancel capability.                    | Use manual review or product fallback; do not call provider internals directly. |
| `DUPLICATE_RESERVATION`         | No        | Provider reports an existing reservation for the same booking outside idempotent replay. | Link manually or reconcile through an audited repair flow.                      |
| `MAPPING_MISSING`               | No        | Required property, room type, rate plan, or guest-booking mapping is absent.             | Block handoff until setup or reconciliation creates the mapping.                |
| `RETRYABLE_INTEGRATION_FAILURE` | Yes       | Timeout, `429`, `5xx`, transient lock, or provider temporary outage.                     | Retry through jobs/events with the same idempotency key and correlation chain.  |
| `IDEMPOTENCY_CONFLICT`          | No        | Same idempotency key was reused with a different payload.                                | Treat as a caller bug; create an audit event and reject.                        |
| `VALIDATION_FAILED`             | No        | Command is missing required contract data or violates date/guest/price rules.            | Reject before provider call when possible.                                      |
| `CONFLICT`                      | Maybe     | Provider state conflicts with expected previous version or current reservation state.    | Retry only if adapter can prove the conflict is transient.                      |
| `PROVIDER_REJECTED`             | No        | Provider rejected a valid command for a business reason.                                 | Preserve sanitized reason and move to manual review.                            |

Provider raw errors, credentials, card data, and full PII payloads must not be
stored in `sanitizedMessage`.

## Idempotency

Every create/update/cancel command must include an idempotency key.

Recommended key format:

```text
pms.reservation.<operation>:property:<propertyId>:booking:<guestBookingId>:<semanticVersion>
```

Examples:

- `pms.reservation.create:property:prop_alpenrose:booking:book_123:v1`
- `pms.reservation.update:property:prop_alpenrose:booking:book_123:dates-v2`
- `pms.reservation.cancel:property:prop_alpenrose:booking:book_123:v1`

Rules:

- Same key + same normalized payload returns the existing active or completed
  result.
- Same key + different normalized payload returns `IDEMPOTENCY_CONFLICT`.
- Retries reuse the same key and append attempts.
- Intentional new changes use a new semantic version.
- Provider-native idempotency keys may be derived from the Vayada key, but the
  Vayada key remains the audit source of truth.

## Audit and Correlation

Every command must create or link:

- a durable command/outbox record;
- a product audit event with actor, organization, property, guest booking, PMS
  provider, command ID, idempotency key, request ID, and correlation ID;
- sanitized provider attempt records when an external PMS call is attempted;
- final handoff status visible to Booking Engine and PMS admin surfaces.

Guest-visible handoffs must be auditable even when an adapter completes
synchronously. There must be no untracked fire-and-forget PMS handoff.

## Operational Reservation Read Port

PMS admin/calendar surfaces should read operational reservation state through a
PMS-owned interface. They must not read Booking Engine internals directly.

```ts
interface PmsOperationalReservationReadPort {
  getOperationalReservation(
    query: GetPmsOperationalReservationQuery,
  ): Promise<PmsOperationalReservationReadModel | null>;

  listOperationalReservations(
    query: ListPmsOperationalReservationsQuery,
  ): Promise<PmsOperationalReservationListResult>;
}

type GetPmsOperationalReservationQuery = {
  propertyId: string;
  pmsReservationRef?: string;
  operationalReservationId?: string;
  guestBookingId?: string;
};

type ListPmsOperationalReservationsQuery = {
  propertyId: string;
  dateRange: {
    from: string;
    to: string;
  };
  statuses?: PmsReservationStatus[];
  roomTypeId?: string;
  roomId?: string;
  source?: "direct_booking" | "channel" | "manual" | "imported";
  limit: number;
  offset: number;
};

type PmsOperationalReservationReadModel = {
  operationalReservationId?: string;
  pmsReservationRef: string;
  guestBookingId?: string;
  bookingReference?: string;
  propertyId: string;
  provider: PmsProviderKey;
  source: "direct_booking" | "channel" | "manual" | "imported";
  status: PmsReservationStatus;
  stay: {
    checkInDate: string;
    checkOutDate: string;
    adults: number;
    children: number;
  };
  assignment: {
    roomTypeId?: string;
    roomTypeName?: string;
    roomId?: string;
    roomNumber?: string;
    assignmentStatus: "unassigned" | "assigned" | "changed";
  };
  guestSummary: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
  };
  financialSummary?: {
    total: PmsMoney;
    paid?: PmsMoney;
    balance?: PmsMoney;
  };
  externalReference?: PmsExternalReference;
  channelReservationRef?: string;
  lastSyncedAt?: string;
  version?: string;
};

type PmsOperationalReservationListResult = {
  reservations: PmsOperationalReservationReadModel[];
  total: number;
  limit: number;
  offset: number;
};
```

The read model can include Booking Engine summary fields such as
`guestBookingId` and `bookingReference`, but those fields should come from a
permissioned read model or explicit integration event, not from PMS code opening
Booking Engine tables.

## Adapter Responsibilities

### Vayada PMS Adapter

The Vayada PMS adapter implements the same sink/read ports as every external
adapter. It may translate commands into Vayada operational reservation tables or
domain services, but that translation remains behind `domain-pms`.

The adapter must not leak Vayada PMS table names, SQL columns, or legacy PMS IDs
into Booking Engine contracts.

### External PMS Adapters

Guesty, Lodgify, Hostaway, and future adapters implement this contract by
mapping Vayada commands to provider APIs and mapping provider reservations back
to `PmsReservationHandoffResult` and `PmsOperationalReservationReadModel`.

Adapters must declare supported capabilities per connection. If a provider
cannot update stay dates, cancel reservations, or read assignments through API,
the adapter returns `UNSUPPORTED_CAPABILITY` instead of faking success.

### Test Fakes

Test fakes must implement the same interfaces and support:

- deterministic success, accepted, duplicate, noop, and failure outcomes;
- idempotency replay and conflict assertions;
- retryable failure simulation;
- disconnected/setup-incomplete provider state;
- mapping-missing scenarios;
- audit/correlation assertions.

Fakes should not expose helper-only behavior that real adapters cannot support.

## Channex Interaction

Channex integration stays behind PMS operations:

```text
Booking Engine
  -> PmsReservationSink
    -> Vayada PMS adapter or external PMS adapter
      -> PMS-owned channel connectivity / Channex jobs when applicable
```

Direct booking handoff may cause PMS-owned inventory or channel-sync events, but
Booking Engine only observes the PMS handoff result. It does not enqueue
Channex jobs or read Channex mappings.

## Implementation Follow-Ups

This contract enables implementation tickets without re-deciding the boundary:

- VAY-643 creates `packages/domain-pms` with these port and DTO types;
- VAY-644 creates a `packages/domain-booking` handoff service that emits
  `CreatePmsReservationCommand` after a guest booking commits;
- add test fakes for `PmsReservationSink` and
  `PmsOperationalReservationReadPort`;
- VAY-645 implements the Vayada PMS adapter behind the same interface;
- wire the VAY-639 Booking reservation read route to a Booking-owned read model
  or a PMS read adapter without direct PMS database access;
- extend `npm run check:architecture-boundaries` into package-level import
  boundaries under VAY-640.

## References

- `engineering/booking-pms-domain-boundaries.md`
- `engineering/jobs-events-contract.md`
- `engineering/request-context-contract.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/public-bookability-contract.md`
- Channex PMS integration guide: https://docs.channex.io/guides/pms-integration-guide
- Guesty reservations API: https://open-api-docs.guesty.com/reference/get_reservations
- Hostaway reservations API: https://api.hostaway.com/documentation
