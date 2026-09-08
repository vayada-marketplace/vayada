# Airbnb request decisions

VAY-384 / VAY-1551. TypeScript implementation contract, 2026-09-08.

## Ownership and sequence

PMS owns the Channex connection and provider decisions. Reuse canonical Booking
pending records and Reservations → Pending for reservation requests. Reuse the
booking-change display for alterations. Do not add a parallel request center or
invoke direct-booking payment capture/refunds for either Airbnb workflow.

Implementation stack:

1. This contract and the scoped provider decision adapter, with mocked transport
   tests. No runtime registration, subscription changes or outbound activation.
2. Provider-backed fixtures proving request identity, deadline and confirmation
   linkage; canonical intake/read model, notifications and reconciliation jobs.
3. Protected staff decision commands, availability checks and existing PMS UI.
4. Deployed and provider smoke evidence using an authorized test connection.

The first slice is independently testable. It does not deliver the staff feature.
VAY-1551 may reuse the transport but must preserve alteration-specific behavior.

## Provider contract

Read `GET /api/v1/live_feed/{id}`. Resolve the same event with
`POST /api/v1/live_feed/{id}/resolve`, wrapping the decision in `resolution`:

| Kind        | Accept                | Decline                                           |
| ----------- | --------------------- | ------------------------------------------------- |
| Reservation | `{"accept":true}`     | `{"accept":false,"reason":"dates_not_available"}` |
| Alteration  | `{"accept":"accept"}` | `{"accept":"decline"}`                            |

Every read must match the persisted provider event ID, provider property ID and
event kind. These values come from a server-owned connection/request binding,
never an unchecked browser argument. API credentials go only to the configured
official Channex origin; redirects are rejected. Provider bodies/errors are not
logged or surfaced to staff. Reads expose only normalized decision state.

Re-read before sending. An already resolved event is returned unchanged by
Channex, including when the requested decision conflicts with the existing one.
Return the actual provider outcome; HTTP success alone is not decision success.
After an ambiguous POST, read once to reconcile. If still unresolved/unreadable,
report `decision_outcome_unknown`; never automatically repeat that POST.

The adapter is not a durable command coordinator. Before calling it, the worker
must acquire the existing property/request command lock, persist one immutable
intent and actor/audit identity, verify the current connection binding, and check
availability/deadline. Only one caller per provider request may send. A retry
must reconcile a previous ambiguous send before considering further action.
Keep workers fenced and feature activation off until these requirements exist.

## Lifecycle

`accepted_reservation` acknowledges the host decision, not booking confirmation.
Only a pulled authoritative confirmed booking revision confirms the same pending
record. Acceptance may await payment remediation past the original host deadline.
Do not expire that accepted request using the original host-response timer.

For alterations, keep the booking unchanged until a pulled modified revision
arrives. A decline/withdrawal does not generate a separate webhook; re-read
pending requests with bounded polling and preserve the original booking.
Do not invent a 24-hour alteration deadline. Use the existing generic `booking`
subscription instead of redundant booking subtype subscriptions.

The current direct-booking contract reserves inventory for pending requests;
VAY-384 explicitly excludes Airbnb pending records from confirmed occupancy and
local availability consumption. The provider-specific intake must preserve that
exception without changing direct-booking behavior. Airbnb may retain calendar
blocks after expiry/decline; do not reopen provider dates automatically.

## Required provider evidence before intake/activation

The public reservation webhook example has `bms`, `resolved` and a webhook
timestamp; the live-feed example abbreviates `bms`. Neither establishes the
exact host deadline field or stable identity linking a request to the later
confirmed revision. A webhook receipt time is not the request creation time.
Guest name/dates are not an acceptable identity. Obtain sanitized reservation,
accepted/declined and confirmed-revision fixtures from the same request, plus
alteration/withdrawal examples, before implementing those mappings.

Channex's Airbnb test guide requires connecting a live listing. The shared
synthetic staging property does not authorize doing that or creating real
reservations/payments. An authorized provider test connection or provider-issued
fixtures are required; do not fabricate production payload contracts from mocks.

Validation for subsequent slices includes property authorization denial cases,
exact replay, conflicting clicks, unknown POST outcomes, out-of-order revisions,
request-to-booking linkage, pending inventory/payment exclusions, availability
checks excluding the altered booking's own allocation, and PMS browser tests.

## References

- [Channex Airbnb API](https://docs.channex.io/api-v.1-documentation/airbnb-api)
- [Webhook collection](https://docs.channex.io/api-v.1-documentation/webhook-collection)
- [Airbnb test accounts](https://docs.channex.io/guides/test-accounts-for-airbnb)
- `engineering/booking-acceptance-mode-contract.md`
- `engineering/channex-webhook-event-strategy.md`

Documentation checked 2026-09-08. Mocked tests are not real-provider acceptance.

Read-only shared staging checks on 2026-09-08 returned HTTP 200: the scoped
channel list contained one OpenChannel connection, and property-filtered live
feeds contained zero reservation requests and zero alteration requests. No
provider decisions or fixture mutations were performed. These reads establish
credential access and the missing fixture, not Airbnb request behavior.
