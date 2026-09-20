# Marketplace engagement communications recommendation

Status: product direction approved by Flamur on September 16, 2026, and
reconciled with `main`. The approved direction is automatic email-only delivery
for new applications and invitations through Resend. Real-user delivery remains
gated on lawful-basis validation and Resend account readiness.

## Decision

Optimize for **timely bilateral action on an existing Marketplace collaboration**,
not newsletter opens or raw return visits.

The first release should prove one vertical slice: an actionable email when a
new creator application or hotel invitation needs a counterparty response. It
should also ship the user-facing email preference, one-click opt-out, durable
event/job records, provider delivery receipts, and outcome instrumentation needed
to prove whether that message improves response time.

Do not restore the legacy weekly newsletter. Do not include discovery digests,
an in-app notification center, browser/mobile push, or Instagram delivery in the
first release.

Flamur approved this product direction on VAY-1029 on September 16, 2026. The
approval selects the scope and intended defaults; it does not by itself verify
the applicable lawful basis or the live Resend account configuration.

## Desired outcome and metrics

### Product outcome

More qualified creator proposals and hotel invitations receive a useful response
from the other party while the opportunity is still current.

### Primary metric

`48-hour counterparty action rate`:

```text
eligible new creator applications or hotel invitations
whose other party performs its first qualifying action within 48 hours
-------------------------------------------------------------------------
eligible new creator applications or hotel invitations
```

A qualifying action is a response, terms update, terms approval, message, or
cancellation by the notified counterparty. Email delivery, open, or click alone
does not count as Marketplace success.

The experiment assignment unit is the **counterparty organization**, assigned
stably for the experiment version. Every eligible member of one organization is
therefore in the same treatment or holdout cohort. The analysis unit is one
eligible created collaboration: its first qualifying counterparty action is
counted once regardless of how many members were notified or acted.

One `communication_id` represents the source event, collaboration revision, and
counterparty organization. Each recipient gets a separate `delivery_id`; the
semantic delivery key is `communication_id + recipient user + channel + template
version`. Recipient fan-out must never multiply the primary outcome count.

### Secondary metrics

- Median time to first counterparty action.
- Seven-day counterparty action rate.
- Fourteen-day collaboration acceptance rate.
- Seven-day Marketplace return rate after a delivered communication.
- Communication click-to-qualifying-action conversion.

### Delivery and trust guardrails

- Preference and consent enforcement rate must be 100%; any confirmed violation
  blocks rollout expansion.
- Duplicate customer-facing sends for one semantic event must be zero.
- Enqueue-to-provider-accepted and provider-accepted-to-delivered rates.
- Retry, dead-letter, hard-bounce, suppression, and complaint rates.
- Messages per recipient per week at median and p95.
- Category opt-out rate after first send.

Opens are diagnostic only. They are not a success metric because privacy features
and image prefetching make them unreliable.

## Audience and recipient resolution

The eligible audience is deliberately narrower than all Marketplace users.

| Segment                      | Eligible recipient                                                                | Exclusions                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Creator application          | Active members of the hotel organization who can act on the offer's collaboration | Inactive/suspended membership, no relevant permission/resource link, sender |
| Hotel invitation             | Active members of the invited creator workspace who can act on collaborations     | Inactive/suspended membership, no creator-profile link, sender              |
| Negotiation or status change | Active members of the counterparty workspace who can act on that collaboration    | Sender, users outside the collaboration's organizations                     |
| Stale action                 | The still-eligible counterparty to the unchanged action-required state            | Already acted, ended collaboration, prior reminder for the same state       |

Recipient resolution must use `RequestContext` organizations, memberships,
permissions, and resource links. It must not fall back to a legacy owner email,
an offer contact address, an Instagram handle, or every user with a matching
legacy `users.type`.

If more than one member is eligible in an organization, the first implementation
may notify all eligible members, deduplicated by internal user ID. The telemetry
must retain the organization fan-out count so a later primary-notification-contact
setting can be justified with evidence.

## MVP triggers, content, and frequency

| Category                        | Trigger                                     | Recipient    | Timing and cap                                          | Required content                                                                        |
| ------------------------------- | ------------------------------------------- | ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `collaboration_action_required` | New creator application or hotel invitation | Counterparty | Immediate; once per created collaboration and recipient | Counterparty display name, offer title, what action is waiting, collaboration deep link |

Do not email for every chat message, deliverable toggle, rating, profile view,
offer view, or recommendation. Do not include negotiated money, travel dates,
private messages, contact details, or creator metrics in the subject line. Email
copy should be factual and service-oriented; it must not add promotional offers
to an operational notification.

The MVP exposes these user choices:

| Preference                          | Values             | Initial state                                       |
| ----------------------------------- | ------------------ | --------------------------------------------------- |
| New application or invitation email | `immediate`, `off` | `immediate` for eligible active Marketplace members |
| All Marketplace email               | `on`, `off`        | `on` for eligible active Marketplace members        |

There is no hidden fallback cadence. A disabled category is suppressed, not
silently moved into another email.

## Consent, preferences, and opt-out

The approved product direction treats actionable collaboration updates as product-service
communications generated by a collaboration in which the recipient's
organization is participating. They should be kept separate from promotional
discovery communications and must remain non-promotional. Flamur selected
automatic delivery with `immediate`/`on` defaults. Privacy/legal review must
still validate the service classification and lawful basis for Vayada's
operating jurisdictions before real-user delivery is enabled.

Discovery/recommendation digests are direct marketing. They require both:

1. active identity-owned marketing consent; and
2. an explicit Marketplace digest preference for the email channel.

The dormant `marketplace.newsletter_preferences` rows are migration history,
not consent for the new product. They must not enable any new communication.
The identity-owned `marketing_consent` boolean is also not granular enough to
serve as the product preference by itself.

The target preference contract should be user- and organization-scoped with a
unique row per `(user, organization, category, channel)`. It records cadence,
enabled state, source, policy/version, and timestamps. Identity continues to own
consent history; Marketplace owns its product categories and requested cadence.

Suppression precedence is:

```text
hard bounce / provider complaint / global channel suppression
-> user channel opt-out
-> category preference
-> marketing-consent gate when the category is marketing
-> eligible send
```

Preferences must be enforced when a job is enqueued **and rechecked immediately
before delivery** so an opt-out also suppresses already queued work.

Every email includes a settings link and a signed, expiring category opt-out
that works without login. Marketing email additionally exposes that endpoint
through standards-compatible `List-Unsubscribe` and one-click headers. An
opt-out records an audit event and takes effect synchronously. It must never
require the user to sign in.

This conservative design follows current regulator guidance that electronic
direct marketing includes email and social direct messages, requires specific
permission in many jurisdictions, and must provide an easy withdrawal path:
[European Commission consent guidance](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data_en),
[ICO electronic-mail marketing guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/),
and [EU ePrivacy Directive Article 13](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32002L0058).

## Target event, job, and analytics contract

### Current-state gaps

- Collaboration lifecycle writes currently return values such as
  `marketplace.collaboration.notification_requested` in the HTTP response, but
  do not persist those values to `platform.domain_events` or
  `platform.outbox_events`.
- `marketplace.marketplace_notifications` and
  `marketplace.newsletter_preferences` exist in the target migration only to
  preserve history. No notification-center consumer or active newsletter route
  exists.
- The identity domain has marketing consent and history, but no per-product,
  per-channel communication preference model.
- `apps/api` has a durable `platform.jobs` email worker and a Resend adapter for
  Booking. It is Booking-specific and treats an accepted HTTP request as job
  success; it does not provide Marketplace preference enforcement.
- `apps/api` now has a signed `/webhooks/resend` route for PMS Inbox delivery
  acknowledgements. It handles only `email.delivered`, routes through a
  PMS-specific receipt port, and ignores tagged Booking notifications. It is not
  a product-neutral Marketplace delivery/bounce/complaint outcome pipeline.
- Marketplace Web has no service worker, Web Push subscription flow, or native
  mobile push surface.

### Source events

The first collaboration transaction should persist one versioned event and
outbox row when a new application or invitation is created, including the
initiator side. The contract may reserve names for later lifecycle transitions,
but those events must remain disabled until their product triggers are approved.

Events contain internal IDs, organization/resource scope, actor, revision,
request/correlation/causation IDs, and the minimum rendering facts. They do not
contain full message bodies, negotiated private terms, credentials, or provider
tokens.

### Projection and delivery

An event projector resolves eligible recipients, evaluates the preference and
consent snapshot, and creates `platform.jobs` records. One semantic delivery key
is used end to end:

```text
marketplace.email:<eventType>:collaboration:<collaborationId>:revision:<revision>:recipient:<userId>:v1
```

The Vayada job/idempotency record is authoritative for the full retention
period. Provider idempotency is defense in depth, not the source of truth.

Persist the delivery attempt as `sending` before the provider call. If the
request may have reached Resend but its response is lost, transition to
`needs_reconciliation`; do not treat it as an ordinary failed attempt. Retry the
identical payload and idempotency key only inside a bounded 23-hour window from
the first attempt. A repeated request inside Resend's 24-hour retention window
returns the original result without sending again.

If neither the repeated request nor a signed, delivery-tagged webhook resolves
the attempt by that cutoff, terminate it as `ambiguous_provider_acceptance` and
do not resend after the provider window. A manual replay requires provider
evidence that no email was accepted plus an audit record; otherwise the delivery
remains terminally ambiguous. This favors the zero-duplicate guardrail over
blind at-least-once delivery.

Jobs use the existing target contract: durable status, `run_after`, maximum
attempts, exponential backoff with jitter, attempt history, dead-letter
visibility, and audit correlation. Provider `429` and confirmed pre-acceptance
`5xx` failures are retryable. A network failure after request transmission uses
the reconciliation path above. Invalid recipient, revoked scope, ended resource,
opt-out, hard bounce, and policy failure are suppressed or failed without blind
retry.

The worker rechecks the current collaboration state and recipient eligibility
before sending. If the counterparty has already acted, the job is superseded.

### Provider receipts and engagement events

Persist the provider email ID returned at send time. Ingest signed Resend
webhooks through the provider-webhook boundary, deduplicate their at-least-once
delivery ID, tolerate out-of-order events, and correlate:

- provider accepted/sent;
- delivered or delayed;
- failed, bounced, suppressed, or complained;
- clicked.

The current Resend route already verifies Svix signatures, but only for the PMS
Inbox delivery flow. The provider-feedback contract must decide whether to add a
Marketplace receipt port behind that route or promote Resend into the generic
provider-webhook types and `platform.external_webhook_events.provider`
constraint. Either design must route explicit Marketplace product/delivery tags,
support the approved outcome events, and persist provider event IDs. It must not
store Resend events as a generic-provider workaround.

Record eligible, suppressed, enqueued, attempted, delivered, and clicked facts
separately. Correlate those facts with Marketplace qualifying actions using the
communication ID and collaboration revision. Do not store recipient email,
private message text, or negotiated terms in analytics payloads.

## Channel and provider feasibility

| Channel                    | Current capability                                                                                                                                                             | Constraint and recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email / Resend             | `apps/api` already calls Resend, has durable Booking email jobs, and verifies PMS-specific Resend delivery webhooks                                                            | Feasible for MVP after extracting a Marketplace-safe adapter and adding preferences plus product-tagged provider receipts. Resend idempotency lasts 24 hours, so use the bounded reconciliation rule above and keep durable Vayada keys authoritative. As of September 16, 2026, Resend documents a default maximum of 10 requests/second per team; verify Vayada's current team limit and honor rate-limit, `Retry-After`, and quota headers. Verify a sending subdomain with SPF/DKIM and establish DMARC. Resend webhooks are at-least-once and unordered, so verify, dedupe, and persist them. See [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [usage limits](https://resend.com/docs/api-reference/rate-limit), [domain verification](https://resend.com/docs/dashboard/domains/introduction), and [webhooks](https://resend.com/docs/webhooks/introduction). |
| In-app notification center | Historical Marketplace notification rows exist, but V6 intentionally retired the unconsumed inbox/read routes                                                                  | Feasible later only with a new read-state contract and an actual Marketplace Web consumer. Do not treat the historical table as an approved inbox design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Browser Web Push           | No Marketplace service worker, subscription storage, sender, or permission UX exists                                                                                           | Later experiment only. It requires HTTPS, explicit permission from a user gesture, a service worker, expiring subscription handling, and user-visible notifications. Browser coverage is not universal. See [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API) and [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Native mobile push         | No Vayada native mobile app or APNs/FCM device-token model exists                                                                                                              | Out of scope until a mobile product and its consent/device lifecycle exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Instagram Direct           | Current Vayada Instagram connection requests only basic profile and insights scopes; it has no messaging permission, webhook contract, recipient conversation IDs, or approval | Unresolved and excluded. Meta's Send API is for professional accounts, requires `instagram_business_manage_messages`, and requires the recipient to have messaged the professional account first. Serving accounts Vayada does not own/manage requires Advanced Access. Normal replies are limited by the standard messaging window; the seven-day Human Agent path requires separate permission and disallows automated or unrelated messages. These constraints do not support proactive Marketplace engagement notices to arbitrary profile handles. See Meta's official [Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) and [Conversations API requirements](https://www.postman.com/meta/instagram/folder/23987686-6a91368f-1fa8-4614-9ed6-7d1e08c21e62).                                                                            |

Instagram can be reconsidered only for a concrete, recipient-initiated support
or inbox use case after Vayada obtains the required permission/Advanced Access,
documents the sender account, verifies the active messaging window, and receives
separate product/legal approval. A connected creator profile and public handle
alone never authorize a DM.

## MVP, later, and out of scope

### MVP after approval

- Persist the new-application/invitation event transactionally.
- Add Marketplace email preferences, settings UI, and one-click opt-out.
- Deliver the one approved new-application/invitation email.
- Enforce recipient scope, consent where applicable, preference, suppression,
  idempotency, retry, supersession, and dead-letter rules.
- Store delivery outcomes and qualifying Marketplace actions for evaluation.
- Roll out behind a server-side flag with an eligible holdout cohort.

### Later, only after the MVP is effective

- Weekly discovery digest with explicit marketing opt-in, relevance thresholds,
  and a recommendation-quality review.
- Remaining collaboration lifecycle emails for terms changes, approvals,
  acceptance, decline, and cancellation.
- A single stale-action reminder only if first-slice data shows that it is needed.
- In-app notification center and read-state synchronization.
- Unread-chat aggregation rather than one email per message.
- Browser Web Push for users who explicitly grant permission.
- A primary notification contact for multi-member organizations if fan-out data
  shows that it is needed.

### Out of scope

- Legacy Python newsletter routes, scheduler, sender, templates, and country-only
  recommendation logic.
- Cold or proactive Instagram DMs, scraped-handle outreach, Human Agent misuse,
  or any external-channel delivery without provider approval and recipient
  consent.
- Native mobile push before a mobile product exists.
- AI-generated targeting or copy in the delivery path.
- Sending every activity event or chat message as a separate email.

## Rollout and evaluation

1. Accept the approved MVP contract, validate its service-versus-marketing
   classification and lawful basis, and verify the sender identity and copy boundaries.
2. Run event generation and recipient selection in shadow mode; require zero
   cross-tenant, duplicate, or preference violations.
3. Deliver only to internal/test accounts and exercise retries, dead letters,
   opt-out-after-enqueue, bounce, complaint, and already-acted supersession.
4. Enable a small randomized eligible cohort while retaining a stable holdout.
5. Expand only after delivery/complaint guardrails are healthy and the primary
   metric has enough eligible collaborations for a meaningful comparison.
6. Evaluate for at least four weeks or the pre-agreed sample threshold. Keep,
   adjust, or disable each trigger independently; do not justify later channels
   with email opens alone.

The implementation feature flag must be a kill switch for enqueueing new sends.
Disabling it does not erase audit, delivery, preference, or holdout records.

## Decision record and remaining launch gates

### Approved product decisions — September 16, 2026

Flamur approved:

1. the email-only new-application/invitation MVP and the audience/content
   boundaries above;
2. automatic `immediate` delivery with the all-Marketplace-email preference
   initially `on`, plus direct category and global opt-outs;
3. Resend as the email provider direction; and
4. the 48-hour outcome, organization-level experiment assignment,
   one-count-per-collaboration analysis, and staged holdout rollout.

Instagram, in-app notifications, push, reminders, and digests remain outside
the MVP.

### Privacy/legal launch gate

The intended default is now decided: `immediate`/`on` for eligible active
Marketplace members. Before enabling real-user delivery, privacy/legal must
validate that the narrowly factual action-required email is a non-promotional
service communication with an applicable lawful basis in each operating
jurisdiction. If that validation fails or remains uncertain, launch must switch
to explicit opt-in rather than silently treating legacy newsletter rows as
permission.

### Resend account-readiness launch gate

Resend is selected because it is already used by the target API. Before any real
send, verify the actual Vayada account's sender/domain, SPF/DKIM/DMARC, quota and
rate limit, API/webhook secret ownership, bounce/complaint/suppression events,
and operational owner. Selecting Resend does not prove those account facts.

The concrete next step is to accept and merge this decision PR, then begin the
VAY-1394 contract/schema slice. Real-user delivery must remain disabled until
the privacy/legal and Resend account-readiness gates above have evidence.

## Implementation slicing

After the decision PR is accepted, use stacked follow-ups in this order:

1. Define the exact communication preference, event payload, recipient, and
   HTTP contracts in
   [`marketplace-communication-contract.md`](marketplace-communication-contract.md).
2. Implement preference storage/API, the signed opt-out boundary, and
   delivery-time enforcement.
3. Add the Marketplace Web settings surface.
4. Make the existing TypeScript/Resend delivery foundation product-neutral and
   add provider outcome handling.
5. Persist and deliver the one new-application/invitation vertical.
6. Instrument qualifying actions and gate the staged rollout.

Each implementation PR should answer one review question and stay within the
TypeScript rewrite's reviewability budget.
