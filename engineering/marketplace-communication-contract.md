# Marketplace communication contract

Contract version: `marketplace-communications.v1`.

Derived from
[`marketplace-engagement-communications.md`](marketplace-engagement-communications.md),
this defines target data and boundaries only—no migration, route, worker,
template, UI, or customer send.

## Approved scope and launch gates

V1 enables only `marketplace.collaboration.action_required.created`, with topic
`collaboration_action_required`, channel `email`, cadence `immediate | off`,
template `marketplace.collaboration_action_required.v1`, and Resend as the
provider direction.

The event covers both creator applications and hotel invitations. The
`initiatorSide` field distinguishes them. No response, terms, reminder, chat,
digest, recommendation, in-app, push, or Instagram event may enqueue a v1
communication.

The approved product default is automatic `immediate` email with the global
Marketplace email switch `on`. Real-user delivery stays disabled until:

1. privacy/legal records the applicable service-communication lawful basis for
   every launch jurisdiction; and
2. the Resend account, sender authentication, limits, secrets, webhook events,
   suppression behavior, and operational owner are verified.

An audited launch policy controls the effective default:

- `disabled`: suppress every real-user delivery;
- `service_default_on`: apply the approved automatic default; or
- `explicit_opt_in`: absent preferences resolve to `off` if the lawful basis
  does not support automatic service delivery.

Legacy newsletter state never selects a launch policy.
`marketplace.newsletter_preferences` remains dormant migration history: no row
is copied into either new preference table, treated as consent, or consulted by
the runtime unless a separately approved migration contract says otherwise.

## Ownership and boundaries

| Owner                      | Source of truth                                                                                                                     | Boundary                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                   | User status and current delivery email; organizations, memberships, permissions, resource links; consent history                    | Marketplace reads through typed identity/authorization ports. It never authorizes by email or copies consent history as its own truth. |
| Marketplace                | Topics, user preferences, communication intent, recipient delivery state, unsubscribe decisions, and engagement outcome attribution | Marketplace persists intent in the same transaction as its lifecycle change and projects recipient deliveries through platform jobs.   |
| Platform events/jobs/audit | `domain_events`, `outbox_events`, `jobs`, `job_attempts`, external webhook receipts, idempotency, dead letters, product audit       | These generic tables execute and evidence work. They do not decide Marketplace eligibility or preference policy.                       |
| Email delivery             | Provider-neutral send and suppression ports                                                                                         | Resend is an adapter. Provider IDs and idempotency are not Marketplace authorization or consent.                                       |
| Marketplace Web            | Settings and authenticated collaboration navigation                                                                                 | The browser does not decide the effective preference, recipient set, or send eligibility.                                              |

Cross-domain ports resolve eligible recipients and current identity email,
evaluate consent and suppression, enqueue a delivery job, and append product
audit. Implementations may not bypass those ports with cross-domain SQL.
The email address is resolved immediately before delivery and is not stored in
Marketplace communication, event, job, or analytics payloads.

## Preference schema

### `marketplace.communication_preference_sets`

One row per `(user_id, organization_id)` is the aggregate control row for the
complete preference document. It has identity user/organization foreign keys,
an integer `revision`, the last actor, and created/updated timestamps. The tuple
is unique. A missing row is effective revision `0` and uses the audited launch
policy defaults.

The aggregate revision is the revision returned by the API. A mutation locks
this row and atomically advances its revision by exactly one before changing
one or more preference values and appending audit. Value-row revisions are not
combined or compared to derive the document revision. Hard deletion and
user/organization scope mutation are forbidden; an opt-out remains explicit.
The database rejects a value insert or update unless the control row was
created or advanced in the same transaction, so one revision cannot identify
multiple committed document states.

### `marketplace.communication_channel_preferences`

One row per `(user_id, organization_id, channel)` with a UUID primary key and
foreign keys to `identity.users` and `identity.organizations`. It stores
`channel = email`, `state = on | off`, `source = settings |
signed_unsubscribe | explicit_opt_in`, `policy_version`, `effective_at`, and
created/updated timestamps. It also stores `effective_revision`, the aggregate
revision that last changed the row. The tuple is unique and is scoped by a
foreign key to `marketplace.communication_preference_sets`.

This row is the global Marketplace channel switch. `off` suppresses every
Marketplace email for that user and organization. An absent row uses the
audited launch policy; it is never inferred from a newsletter row.

### `marketplace.communication_topic_preferences`

One row per `(user_id, organization_id, topic, channel)` with a UUID primary key
and identity user/organization foreign keys. It stores `topic =
collaboration_action_required`, `channel = email`, `cadence = immediate | off`,
the same preference source values, `consent_classification = service |
marketing`, nullable `consent_reference`, `policy_version`, `effective_at`, and
created/updated timestamps. It also stores `effective_revision`, the aggregate
revision that last changed the row. The tuple is unique and is scoped by a
foreign key to `marketplace.communication_preference_sets`.

`consent_reference` points to the identity-owned consent/policy evidence; it
does not duplicate consent history. The v1 topic is `service` only after the
launch gate approves that classification. A later marketing topic must use
`explicit_opt_in` and a valid identity consent reference.
Preference resolution runs at projection and immediately before delivery, in
this precedence: launch disabled; provider hard-bounce, complaint, or global
suppression; inactive user or membership; channel off; topic off; consent
denied; otherwise eligible at the effective cadence.

A user choice always overrides the product default toward less delivery. An
admin or migration cannot silently re-enable a user after opt-out.

### Preference API v1

Authenticated settings routes operate only on the actor's active membership in
the selected organization:

```text
GET /api/marketplace/communication-preferences
PUT /api/marketplace/communication-preferences
```

Both routes require `marketplace.collaboration.write`, matching v1 recipient
eligibility. A creator workspace resolves exactly one active Marketplace
`creator_profile` owner link. A hotel group resolves an active Marketplace
`hotel_profile` owner or operator link and an active organization-level
`marketplace-hotel-profile` entitlement. Every resolved actor, organization,
and membership must be active. Creator workspaces have no separate product
entitlement source in v1; their creator-profile owner link is the applicable
resource boundary.

`GET` returns `200` with this complete effective representation:

```ts
type PreferencesV1 = {
  contractVersion: "marketplace-communications.v1";
  organizationId: string;
  revision: number;
  email: { state: "on" | "off"; source: PreferenceSource; effectiveAt: string };
  topics: { collaborationActionRequired: TopicPreference };
};
type PreferenceSource = "policy_default" | "settings" | "signed_unsubscribe" | "explicit_opt_in";
type TopicPreference = {
  cadence: "immediate" | "off";
  source: PreferenceSource;
  effectiveAt: string;
};
```

`PUT` requires `Idempotency-Key` and this full JSON body; fields are required,
`null` and unknown fields are invalid, and a success returns the new
`PreferencesV1`:

```ts
type ReplacePreferencesV1 = {
  contractVersion: "marketplace-communications.v1";
  expectedRevision: number;
  email: { state: "on" | "off" };
  topics: { collaborationActionRequired: { cadence: "immediate" | "off" } };
};
```

After authentication and organization scope are resolved, idempotency is
checked before revision: an exact key/body replay returns the original `200`;
the same key with another body returns `409 idempotency_conflict`; otherwise a
stale revision returns `409 preference_conflict`. Errors use
`{ error: { code } }`: `400 invalid_request`, `401 unauthenticated`, `403
forbidden`, or `409 preference_conflict | idempotency_conflict |
command_in_progress`. The server supplies source, policy version, consent
reference, and timestamps. The initial source-controlled runtime policy is
`disabled`, effective from the v1 contract decision at
`2026-09-16T13:22:41.000Z`; changing it requires a new audited legal/privacy
launch decision.

`POST /api/marketplace/communication-unsubscribe` is a separate public
signed-token mutation. It never requires a session; its exact body and outcomes
are defined under Unsubscribe.

## Source event and outbox contract

The collaboration creation transaction atomically writes the collaboration, an
immutable `platform.domain_events` row, a redactable
`marketplace.communications` intent, and a `platform.outbox_events` row.
Returning `marketplace.collaboration.notification_requested` in an HTTP response
is not delivery and does not satisfy this contract.

The v1 payload contains the literal event type and version; event,
collaboration, property, offer, creator-profile, actor, initiator-organization,
and counterparty-organization IDs; `collaborationRevision = 1`;
`initiatorSide = creator | hotel`; `occurredAt`; and request, correlation, and
optional causation IDs. Display names and offer titles are excluded from this
append-only event.

The event uses `tenant_scope = organization` and the counterparty organization
as `organization_id`; the actor and initiator organization remain explicit in
the payload. It uses `resource_product = marketplace`,
`resource_type = collaboration`, and the collaboration ID as `resource_id`.
It contains no message body, negotiated terms, travel dates, contact details,
creator metrics, email address, or provider token.

The event key is
`marketplace.collaboration.action_required:collaboration:<id>:revision:1`; the
outbox destination is `marketplace.communication.projector` and its key is
`communication-projector:<event_key>`.

The projector ignores every event type outside the v1 allowlist. Existing
notification side-effect descriptors from response, terms, approval, message,
cancel, deliverable, or rating commands do not enqueue email.

## Recipient resolution

The counterparty organization is the assignment and fan-out boundary.

For a creator application, a recipient must be an active user with an active
membership in the hotel organization, the effective
`marketplace.collaboration.write` permission, and an active organization link
to the offer as `owner` or `operator`.

For a hotel invitation, a recipient must be an active user with an active
membership in the creator workspace, the effective
`marketplace.collaboration.write` permission, and an active `owner` link from
that organization to the invited creator profile.

The actor is excluded. Candidate users are deduplicated by internal user ID.
Zero eligible recipients produces an audited `no_eligible_recipient`
suppression; it never falls back to the first user, legacy `users.type`, profile
email, offer contact email, creator handle, or another organization.
Membership, permission, resource link, user status, collaboration state,
preference, consent, and suppression are rechecked immediately before send.
If the counterparty has already acted or any eligibility fact changed, the
delivery becomes `superseded` or `suppressed` without contacting Resend.

## Communication and delivery schema

### `marketplace.communications`

One communication represents one source event and counterparty organization.
It stores a UUID `communication_id`; foreign keys to the source domain event,
collaboration, and counterparty organization; collaboration revision; topic;
experiment version; `treatment | holdout` cohort; eligibility time; nullable
first qualifying action time/type; redactable `rendering_snapshot` and
`rendering_redacted_at`; `recipient_resolution_version`, resolution time,
candidate and eligible counts, exclusion counts by reason; and creation time.
The source event, counterparty organization, and topic tuple is unique.

Creation captures the initiator display name and offer title in the redactable
rendering snapshot, not the append-only domain event.

Assignment is a stable hash of `(experiment_version,
counterparty_organization_id)`. Every member of one organization is in the same
cohort. A qualifying action is recorded once per communication, regardless of
recipient fan-out. The counts plus the recipient delivery rows form the
immutable resolution result; excluded addresses and profile contact fields are
never retained.

### `marketplace.communication_deliveries`

One delivery represents one recipient, channel, and template version. It stores
a UUID `delivery_id`; communication and identity-user foreign keys; channel;
template key/version; unique delivery key; `send_state`; nullable
`provider_outcome` and suppression reason; preference snapshot; nullable
provider/message ID; first-attempt,
provider-accepted, and terminal timestamps; and created/updated timestamps. The
communication, recipient, channel, template key, and template version tuple is
unique.

Allowed send-state transitions are:

```text
eligible -> suppressed | holdout | queued
queued -> suppressed | superseded | sending
sending -> provider_accepted | retryable_failure | needs_reconciliation
retryable_failure -> suppressed | superseded | queued | failed
needs_reconciliation -> provider_accepted | ambiguous_provider_acceptance
ambiguous_provider_acceptance -> provider_accepted  # signed feedback only; no resend
```

`suppressed` covers policy disabled, channel/topic off, consent denied,
provider suppression, inactive recipient, or revoked scope. `superseded` means
the collaboration no longer needs the action. `ambiguous_provider_acceptance`
is terminal for automatic send attempts, but later signed evidence may reconcile
it without a new send.

Provider feedback is a separate monotone outcome: `accepted`, `delayed`,
`delivered`, `failed`, `bounced`, or `complained`. Append-only facts derive the
effective outcome with risk precedence `complained > bounced > failed >
delivered > delayed > accepted`; therefore a late complaint can supersede a
delivery receipt while an old `sent` event cannot regress it.

The Marketplace uniqueness constraint, platform job, and Resend idempotency key
all use `marketplace.email:collaboration_action_required:collaboration:<id>:
revision:1:recipient:<userId>:template:v1`.

The database uniqueness rule remains authoritative beyond the provider's
idempotency window.

## Jobs, attempts, and ambiguous sends

The projector enqueues one `platform.jobs` row per eligible treatment delivery:
queue `marketplace-email`, type `marketplace.communication.email.deliver`,
Marketplace `communication_delivery` resource keyed by `delivery_id`, and
payload `{ deliveryId }`.

`platform.job_attempts` owns attempt timing, worker identity, retry scheduling,
and error metadata. The Marketplace delivery row owns the product state.

The worker records `sending` before calling the adapter. A confirmed
pre-acceptance `429` or `5xx` may retry with bounded exponential backoff. If the
request may have reached Resend but the response is lost, the delivery becomes
`needs_reconciliation`; it is not an ordinary failure.

Only the identical payload and delivery key may be retried, and only within 23
hours of `first_attempted_at`. A signed tagged webhook may also reconcile the
delivery. At the cutoff, unresolved delivery becomes
`ambiguous_provider_acceptance`; the platform job fails terminally and no later
automatic retry is allowed. Manual replay requires provider evidence that no
email was accepted plus a product audit event.

## Resend feedback contract

V1 promotes Resend into the generic provider-webhook boundary rather than
adding another unpersisted product callback:

- add `resend` to provider webhook types and the
  `platform.external_webhook_events.provider` constraint;
- verify the Svix signature before parsing or acknowledging the event;
- deduplicate on `(provider = resend, provider_event_id = svix-id)`;
- persist a minimized receipt before normalization;
- route `vayada_product = marketplace` and `vayada_delivery_id = <delivery_id>`
  tags to the Marketplace feedback port;
- retain the existing explicit Booking and untagged PMS behavior until their
  own contracts replace it; and
- reject a Marketplace tag whose delivery/provider message identity conflicts
  with the stored delivery.

Accepted feedback is `sent`, `delivered`, `delivery_delayed`, `failed`,
`bounced`, or `complained`. Unknown types are persisted as `ignored`. Raw
payload persistence excludes recipient address, subject, headers, and body;
the minimized receipt keeps provider event ID, event type, provider message ID,
approved Vayada tags, provider timestamp, and payload hash.

Provider acceptance is recorded from the synchronous send response. A webhook
is evidence, not authorization to create a missing communication or delivery.
Signed late feedback may update `provider_outcome` and reconcile an ambiguous
send state, but it can never enqueue or replay a send.

## Click and resulting-action attribution

V1 uses no open pixel and does not enable provider open tracking. The email CTA
contains an opaque, signed delivery token. After authentication, the actor must
equal the delivery's recipient user and still be authorized for the
collaboration before the server records at most one
`marketplace.communication.clicked` fact and removes the token. A forwarded
token never attributes a click to another user; normal route authorization may
still allow navigation after the token is discarded. Bots and unauthenticated
link fetches do not count.

The first qualifying counterparty action within 48 hours records one
`marketplace.communication.outcome_observed` fact keyed by communication ID and
collaboration revision. Qualifying actions are response, terms update, terms
approval, message, or cancellation by the counterparty. These measurement
facts never trigger another communication and recipient fan-out never
multiplies the outcome count.

Analytics dimensions are limited to communication ID, delivery ID, topic,
channel, template version, cohort, initiator side, organization kind, outcome
type, timestamps, and delivery/suppression status. They contain no email,
message text, negotiated terms, contact details, or tracking-pixel identifier.

## Unsubscribe contract

Every email includes settings and category unsubscribe links. The unsubscribe
token is opaque, authenticated, expiring, key-versioned, and bound to delivery,
user, organization, topic, channel, action, and nonce. The raw token is never
stored; only its hash and resulting audit event are retained.

`POST /api/marketplace/communication-unsubscribe` requires no login and accepts
JSON `{ contractVersion: "marketplace-communications.v1", token: string }`.
A valid or already-consumed token returns `204` with no body, writes the topic
preference as `off` with source `signed_unsubscribe`, and is idempotent by token
hash. A malformed, invalid, or expired token returns the same `400 {
error: { code: "invalid_or_expired_unsubscribe" } }` without disclosing whether
a user, organization, or delivery exists. The category link targets Marketplace
Web at `/marketplace/communication-unsubscribe#token=<opaque-token>`; that page
removes the fragment with `history.replaceState` before posting the JSON body.
The token never enters a path, query, referrer, or server access log. A separate
authenticated settings action changes the global Marketplace email switch.
Preference mutation and its `platform.product_audit_events` row are committed
atomically. Jobs recheck the new state, so an unsubscribe suppresses already
queued work.

## Retention and redaction

The migration and operations runbook for the later implementation must enforce:

| Data                                                        | Retention target                                                  | Redaction rule                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Current preferences and opt-out evidence                    | Account/organization lifetime plus the approved compliance period | Preserve the effective off/tombstone state; remove obsolete consent payloads and raw tokens.           |
| Communications, normalized delivery outcomes, outcome facts | 13 months                                                         | Retain internal IDs and coarse dimensions; remove rendering snapshots after 90 days.                   |
| Job attempts and detailed errors                            | 90 days                                                           | Remove provider response bodies, addresses, and free-form error text; retain status/timing aggregates. |
| Minimized Resend webhook receipts                           | 30 days raw, 13 months normalized outcome                         | Never persist recipient, subject, headers, or body in the raw receipt.                                 |
| Authenticated click facts                                   | 90 days row-level, 13 months aggregate                            | Remove token hash and recipient linkage after row-level expiry.                                        |

Privacy/legal must approve or shorten these periods before real-user delivery.
Deletion or GDPR workflows remove recipient-level analytics where required but
retain non-identifying aggregate experiment counts. Logs use delivery IDs, not
email addresses. Secrets, tokens, template bodies, and provider credentials are
never analytics fields.

## Implementation order and verification

The contract is implemented by the existing canonical follow-ups:

1. VAY-1397: preference storage/API, signed unsubscribe, and delivery-time
   enforcement;
2. VAY-1398: settings UI;
3. VAY-1396: provider-neutral worker, Resend adapter, generic persisted feedback,
   reconciliation, and suppression handling;
4. VAY-1399: transactional source event, recipient projection, first template,
   outcome attribution, and staged rollout.

Each implementation must add focused tests for default-policy resolution,
explicit opt-out precedence, active membership/permission/resource links,
cross-tenant denial, fan-out deduplication, event/job idempotency, queued opt-out,
already-acted supersession, retry classification, ambiguous acceptance cutoff,
webhook signature/deduplication/order, and one-count-per-collaboration outcome
attribution.

This contract does not activate a legacy row, change production schema, enable
a send flag, or approve a launch jurisdiction. Those actions require their
own reviewed implementation and launch evidence.
