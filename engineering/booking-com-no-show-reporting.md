# Booking.com no-show reporting — VAY-1535

Contract verification, 2026-09-07:

- [Channex Bookings API](https://docs.channex.io/api-v.1-documentation/bookings-collection#no-show-report-api)
  documents `POST /api/v1/bookings/:booking_id/no_show` with
  `{"no_show_report":{"waived_fees":boolean}}`. This is a whole-reservation
  operation; no room selector is documented. The reservation must allow
  modifications and must not be overbooked.
- Channex documents midnight on the arrival date in the property timezone through
  48 hours later. Enforce this narrower window, including actual elapsed hours
  across DST. Do not extend it using Booking.com’s different published window.
- [Booking.com Reporting API](https://developers.booking.com/connectivity/docs/reporting-api/b_xml-reporting)
  currently describes midnight on arrival through 48 hours after departure;
  older examples on that same page still refer to check-in. Its successful
  response is `enqueued`. Channex returns HTTP 200 with `meta.message: Success`;
  neither contract documents an OTA no-show confirmation lookup through Channex.
  Show this as submitted, confirmation required in the extranet. A cancellation
  revision alone is not evidence of a no-show report.
- The fee choice is mandatory in PMS with no default. Waive means instructing
  Booking.com to waive the no-show fee. Retain does not initiate a card charge.
  PMS makes no promise about commission. Reporting may cause Booking.com to
  notify the guest; test only with provider-supported test reservations.
- [Booking.com self-assessment](https://developers.booking.com/connectivity/docs/self-assessment-reporting)
  requires a connected test property with room/rate availability and test bookings
  created using its supported test booking flow. An ordinary Channex synthetic
  booking or local mock does not establish Booking.com delivery.

Implementation contract:

- Preserve the existing local no-show command and inventory lifecycle. Only an
  explicit second reporting command delivers externally, after all local rooms
  are marked no-show. The confirmation UI can perform both steps sequentially.
- Property-scoped read/manage policies apply independently of identifiers.
  Canonical Booking.com source, active binding claim and complete provider mapping
  must agree. Revalidate local state and live provider identity/status before send.
- One durable platform job per property/reservation; chosen fee parameters are
  immutable. Duplicate requests replay it. Safe preflight failures and explicit
  rate limiting use bounded retries. Persist a dispatch marker before the POST;
  timeout, server error or a lost worker after dispatch requires review, never
  automatic resubmission. Job attempts and product audit events retain sanitized
  outcomes and actor/parameters.
- Reload distinguishes not reported, pending, submitted (OTA confirmation still
  required), and action required. No unverified confirmed status is manufactured.

Provider eligibility limitation: Channex does not document an overbooking or
modifiable capability on its booking read response. `new`/`modified` is only a
preflight filter, not proof of final eligibility. The reporting endpoint remains
the authority for these restrictions, and a rejection is recorded as action
required, never reported. Staff are told this before submission. Do not infer
missing capabilities as `not overbooked`, invent a read endpoint, or infer OTA
confirmation from cancellation alone. Provider staging validation must exercise
these restrictions before this change is accepted.

Validation (2026-09-07):

- All workspace builds and typechecks pass; final API typecheck and PMS production
  build pass. PMS lint has no errors (existing warnings remain).
- 22 focused tests pass: 10 with PostgreSQL 16/all target migrations and 12 route
  tests. Covers concurrency, immutable fee choice, scope denial, metadata gaps,
  binding changes, permanent rejection, bounded retries, interrupted workers,
  ambiguous POST timeout and property-timezone/DST boundaries.
- Five browser cases pass on isolated portless PMS: local-only, explicit retain-fee
  submission and reload, ineligibility, local operation during reporting outage,
  and accepted reporting with failed status refresh. Browser provider responses
  are mocked; screenshots and local database tests are not OTA delivery evidence.
- Full API suite: 3,410 passed, 627 skipped, nine failures and two suite setup
  errors. All failures reproduce on an untouched checkout of the starting
  revision (read-model expectations, settlement fixtures and missing finance test
  database settings); they are outside VAY-1535.
- Independent adversarial review found and verified fixes for NULL mapping
  aggregation, stale preflight eligibility, reporting-outage/local-action coupling,
  and the accepted-POST/failed-refresh message. No remaining correctness findings.
- Acceptance remains pending merge/deployment and provider-supported test delivery.
  Existing VAY-1530 evidence records absent Channex configuration in next API836
  and example.invalid staging configuration; no controlled Booking.com fixture is
  documented. Recheck current configuration after deployment without enabling
  capabilities, changing infrastructure or touching real reservations.

## Scoped deployed validation

`PMS_CHANNEX_STAGING_NO_SHOW_ENABLED` defaults false. Opt-in requires the
existing validated staging property scope, exact staging URL and disabled global
background workers. Booking sync stays observe-only; no import/polling capability
is enabled by this option. The existing Channex worker pause also disables report
submission and delivery. Read status remains available while paused.

When enabled, report submission is limited to the configured property and the
no-show worker claims only that property's pending or abandoned jobs. Existing
eligibility, provider identity checks, dispatch fencing and fee-choice rules
remain mandatory. Other properties' jobs and production behavior are preserved.
A supported imported Booking.com test reservation and its canonical binding must
exist before end-to-end testing; do not fabricate production mappings or enable
unscoped booking sync to create that prerequisite.
