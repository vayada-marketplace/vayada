# Airbnb guest reviews (VAY-1533)

This TypeScript PMS workflow depends on VAY-1532's review route boundary and UI.
Guest-review receipts are separate from public-response receipts. It follows
[backend domain boundaries](typescript-backend-structure.md) and stores only
property-scoped PMS data with redacted platform audit events.

## Provider evidence, 2026-09-07

[Channex Reviews Collection](https://docs.channex.io/api-v.1-documentation/reviews-collection)
documents GET reviews, GET reviews/:id and POST reviews/:id/guest_review.
The POST body is `{review: {scores, public_review, private_review,
is_reviewee_recommended}}`. Scores use `respect_house_rules`, `communication`
and `cleanliness`. The published example's success response is `{success:true}`.

Channex's [current public application](https://app.channex.io/assets/index-DbfRKpdY.js)
uses these same fields, three whole-star ratings out of five, required public
feedback, optional private feedback and a recommendation switch. Although its
form displays optional tags, its transport does not send them; Vayada omits tags.
Text lengths are not documented: 10,000 characters per field is a Vayada request
bound, not an OTA guarantee. Provider validation can impose stricter rules.

The current application exposes the guest-review form only for hidden reviews,
blocks `is_expired`, treats `reply.guest_review` as submission evidence and
refreshes GET review after POST. Vayada requires explicit `is_hidden:true` and
`is_expired:false`, Airbnb channel, matching review/property identity, and a
nonempty guest name plus OTA reservation code. Unknown flags/context disable
submission. `is_replied` and `reply.reply` are not guest-review receipts.

## Discovery and timing limitation

Discover directly through GET reviews with `filter[property_id]` and pagination,
not the local incoming-review webhook table. Include only Airbnb records with
matching provider property. Do not expose raw provider content or private data.
Keep stored submitted attempts visible independently of provider pagination.

Channex describes hidden reviews as reviews already created by guests. Neither
its docs nor its app establishes discovery of every eligible stay before the
guest reviews it. The UI explicitly says missing opportunities must be reviewed
in Airbnb; it must not imply an empty list means no eligible Airbnb stays.

[Airbnb](https://www.airbnb.com/help/article/995) describes the review window and
delayed publication. Use Channex's expiry flag, not a locally guessed deadline.
Messages & Reviews application access and an active property mapping are required.

## Submission and recovery

All list/check/submit routes require `pms.operations.manage`, an active PMS
entitlement and property assignment. Staff preview public/private feedback,
ratings and guest/reservation identity before explicit submission.

A property/provider-review receipt stores the draft, context, actor and attempt.
Reserve it under a database lock before sending; persist uncertainty across
crashes. Retry only after a definitive provider rejection and fresh eligibility
check. Timeouts and ambiguous failures stay locked until positive read-back;
absence does not prove rejection. Provider-wide concurrent submissions outside
Vayada cannot be made atomic by this integration. Record redacted attempt/outcome
audit events. Accepted means submitted, not immediately public.

No sanctioned non-public Channex/Airbnb review fixture is available. Provider
contract tests, isolated PostgreSQL tests and browser tests with mocked outcomes
cannot prove live OTA delivery. Never publish a real guest review as a test.

## Validation evidence

On 2026-09-07, the shared staging property's scoped credential received HTTP403
from GET `/api/v1/reviews?filter[property_id]=…`. This is an application/access
blocker, not evidence of zero reviews. No POST or shared fixture mutation occurred.
API/provider tests, isolated PostgreSQL receipts, production PMS build and real
browser tests with synthetic API responses pass. Browser cases include preview,
provider failure, dropped POST response, accepted reload, and retrying discovery
without skipping the failed page. Live Airbnb delivery remains unverified.

Review writes require `PMS_CHANNEX_REVIEWS_MODE=mutating` with target PMS operations
and configured Channex credentials. The default `observe_only` mode does not
construct review providers; submission is unavailable while saved receipts remain
readable. Reviews execute inline and do not require the Channex management worker.
