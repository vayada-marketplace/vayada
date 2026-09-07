# PMS OTA review replies

VAY-1532 extends VAY-381/382 in the TypeScript API and PMS. It follows
[the backend domain boundaries](typescript-backend-structure.md) and uses
`pms.channel_reviews` plus `platform.product_audit_events`.

## Provider contract checked 2026-09-07

[Channex Reviews Collection](https://docs.channex.io/api-v.1-documentation/reviews-collection)
and its [published Postman collection](https://documenter.getpostman.com/view/681982/RztkPpne)
document GET `/api/v1/reviews/:review_id` and POST
`/api/v1/reviews/:review_id/reply`, with `{reply: {reply: text}}`.
Success returns a review; Vayada verifies the review and property identities
before accepting its reply state. API examples are not publication guarantees.

[Channex's app guide](https://help.channex.io/en/articles/9979352-messaging-reviews-app)
lists Booking.com, Airbnb and Expedia and requires the property's Messages &
Reviews app. Composer preflight reads the review to check access, channel,
visibility and existing response. Missing/unknown visibility or response flags
are unavailable. A disconnected local mapping is unavailable.

[Booking.com](https://developers.booking.com/connectivity/docs/review-api/reply-to-review)
disallows responses to score-only reviews and moderates responses before public
display. [Airbnb](https://www.airbnb.com/help/article/32) describes responses as
public. PMS always explains that provider acceptance may precede public visibility.

Neither reviewed Channex reference publishes channel text bounds or repeat-POST
semantics. The application accepts nonempty trimmed text, rejects control
characters and applies a **Vayada 10,000-character request bound**, explicitly
not a verified OTA limit. Provider validation can reject stricter constraints.
This limitation was discussed with the user, who authorized proceeding.

## Authorization and durable outcomes

Reads retain `pms.operations.read`. Composer preflight and submission require
`pms.operations.manage`, active property-management entitlement and an assigned
owner/operator/front-desk relationship through `enforceRoutePolicy`.
Provider identity comes from the property-scoped review and connection mapping.

One receipt per canonical review prevents concurrent submissions inside Vayada.
The review lock is acquired before a fresh receipt read, then the receipt and
actor audit are committed before the provider call. Its initial `uncertain`
state survives process death. No automatic worker or retry resends a reply.
Definitive validation/access/not-found/rate-limit rejections retain the draft;
an explicit retry performs a fresh preflight. Timeouts, transport failures,
unexpected success payloads and ambiguous HTTP failures remain uncertain.

Read-back can confirm an existing response, but **absence never releases an
uncertain receipt**: Channex does not document authoritative negative confirmation.
Manual inspection in the channel is the recovery path if it remains uncertain.
Reply deletion/editing and administrative receipt resets are out of scope.
External submissions made concurrently outside Vayada remain subject to Channex
behavior; the integration cannot provide provider-wide atomicity.

Audit events identify actor, property, review and outcome without reply text or
credentials. Reply text is stored only in the protected PMS review/receipt.
Newer or replayed webhooks without reply text cannot clear a confirmed reply.

## Validation and provider-testing boundary

PostgreSQL tests exercise the actual reply schema migration, concurrent sends,
receipt persistence, explicit retry and ambiguous reconciliation. Route tests
exercise the denial matrix. Provider tests use the documented HTTP envelope.
Playwright exercises the real PMS composer with mocked API/provider outcomes.

No sanctioned OTA review fixture is identified in the reusable local test-account
records. [Channex Airbnb staging](https://docs.channex.io/guides/test-accounts-for-airbnb)
uses live listings and does not document non-public guest-review testing.
No real guest review or response was published during validation.

VAY-1533 is separate: Channex's guest-review example does not establish eligible
opportunity discovery, exact eligibility fields or post-timeout read-back. An
incoming review, `is_replied` or `is_hidden` must not be treated as a verified
host-to-guest submission receipt. Those missing contracts still need confirmation.
