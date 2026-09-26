# Stripe webhook receipt policy

_VAY-1348 review record. This policy requires security and engineering approval
before VAY-947 may switch production callback ownership._

## Stored evidence

The Stripe route verifies `stripe-signature` against the exact request body,
then discards that body. `platform.external_webhook_events` stores no request
headers and only a versioned replay envelope:

`POST /webhooks/stripe/connect` verifies the distinct
`STRIPE_CONNECT_WEBHOOK_SECRET` and defaults independently to `observe_only`
through `STRIPE_CONNECT_WEBHOOK_INTAKE_MODE`. This mode controls only that route:
reviewed connected events sent to `/webhooks/stripe` still obey
`STRIPE_WEBHOOK_INTAKE_MODE`. Freeze both routes before draining target mutation.
It uses the same Stripe receipt
identity, minimization, retention, and signed-redelivery dedupe as the platform
endpoint. Only the four reviewed PaymentIntent transitions, `charge.updated`,
and `account.updated` can promote; other connected events stay observed even
when redelivered through the platform endpoint. Account updates must agree with
the signed envelope's connected-account ID. Deployment, enabled event selection,
live/test separation, affiliate ownership, and signed delivery remain cutover
verification requirements; this change does not establish production readiness.

| Event family             | Retained fields                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| All events               | event `id`, `type`, optional `created`, optional connected `account`                                                         |
| Payment intent           | object `id`, `amount`, `amount_received`, `currency`, `status`                                                               |
| Charge update            | object `id`, payment-intent and balance-transaction references, `amount`, `currency`                                         |
| Connect account          | object `id`, readiness booleans, card-payments capability, default currency                                                  |
| Payout                   | object `id`, `status`, `amount`, `currency`                                                                                  |
| Billing subscription     | object/subscription/customer references, client reference, and only `vayada_property_id` / `vayada_organization_id` metadata |
| Unsupported future event | object `id` only                                                                                                             |

The full verified event contributes only to the existing SHA-256 receipt hash.
This preserves dedupe compatibility while discarding unknown fields by default.
Secrets, arbitrary metadata, identity/contact attributes, URLs, error objects,
and future nested fields are not retained.

Receipts created or imported before this versioned allowlist are not treated as
safe replay evidence. Migration immediately empties their headers, payload, and
linked audit private-payload copy while preserving receipt IDs, hashes,
lifecycle, and audit relationships. Non-Stripe receipts do not receive a Stripe
retention deadline.

## Access and AI boundary

Receipts remain `privacy_scope = restricted` and `ai_visible = false`, enforced
by the schema. They must not enter AI evidence, public read models, logs, support
exports, tickets, or reviews. Intake/reconciliation is the only application
access; direct reads and purges are audited break-glass operations. Before
cutover, an operator must confirm deployed role grants because repository state
is not production access evidence.

## Retention, replay, and purge

New versioned, minimized evidence is retained for 30 days, covering the
repository's 72-hour Stripe retry/drain window plus reconciliation. Before then
it supports the current normalizer; redelivery dedupes by event ID and payload
hash. Pre-v1 evidence is intentionally not replayable after its migration
tombstone because its fields cannot be proven safe.

After the deadline, an authorized operator runs
`SELECT platform.purge_expired_stripe_webhook_receipts();`.

The function irreversibly empties headers/payload and sets `payload_purged_at`,
but keeps append-only identity, hash, lifecycle, normalized-event, and audit
links. Manual payload replay ends; provider redelivery still dedupes. The trigger
rejects early/second erasure, retention changes, mutation, and deletion. The
function is revoked from `PUBLIC`; execution requires an authorized role.

## Incident handling

For unexpected data, set intake to `observe_only`, stop replay/promotion,
preserve only identifiers/hashes, purge under an incident decision, and rotate
affected credentials through secret management. Resume mutation only after
Finance, Platform, and Security approve the corrected boundary.

This policy does not authorize a Stripe Dashboard change, secret rotation,
production callback switch, or online-card enablement.
