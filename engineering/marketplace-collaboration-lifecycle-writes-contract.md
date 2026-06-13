# MarketplaceCollaborationLifecycleWrites contract

This is the first V4 write slice after
[`marketplace-collaboration-reads-contract.md`](marketplace-collaboration-reads-contract.md).
It defines collaboration lifecycle writes only: create, respond, update terms,
approve, cancel, toggle deliverables, and rate creator.

Chat lifecycle actions stay out of this slice. Message sends and private
platform-media attachments are covered by
[`marketplace-collaboration-message-commands-contract.md`](marketplace-collaboration-message-commands-contract.md).

Contract version: `marketplace-collaboration-lifecycle-writes.v1`.

## Endpoints

| Surface            | Method | Target path                                                                             |
| ------------------ | ------ | --------------------------------------------------------------------------------------- |
| Create             | `POST` | `/api/marketplace/collaborations`                                                       |
| Respond            | `POST` | `/api/marketplace/collaborations/{collaborationId}/respond`                             |
| Update terms       | `PUT`  | `/api/marketplace/collaborations/{collaborationId}/terms`                               |
| Approve terms      | `POST` | `/api/marketplace/collaborations/{collaborationId}/approve`                             |
| Cancel             | `POST` | `/api/marketplace/collaborations/{collaborationId}/cancel`                              |
| Toggle deliverable | `POST` | `/api/marketplace/collaborations/{collaborationId}/deliverables/{deliverableId}/toggle` |
| Rate creator       | `POST` | `/api/marketplace/collaborations/{collaborationId}/rate`                                |

## Authorization

All routes are protected and must use route-policy enforcement at the adapter
boundary. The shared permission is:

```text
marketplace.collaboration.write
```

Creator-side writes require selected organization kind `creator_workspace` and
an active owner link to the creator profile. Hotel-side writes require selected
organization kind `hotel_group` and active links to the hotel profile plus the
addressed listing. Detail writes must resolve the collaboration before mutation
and prove the collaboration belongs to the linked listing or creator profile.

Recipient-only actions, such as responding to a pending request, must enforce
the initiator/recipient role. Permission alone is not enough.

## Idempotency

Every write request must carry an explicit `idempotencyKey`. The target route
reserves the key before mutation, replays the original accepted command response
for identical retries, and returns `idempotency_conflict` when the key is reused
with a different canonical payload.

Recommended key shape:

```text
marketplace.collaboration.<action>:<collaboration-or-listing-id>:<client-nonce>:v1
```

Approving an affiliate collaboration must also emit the accepted VAY-768
Marketplace-to-affiliate command/event with this stable key:

```text
marketplace.affiliate.provision:collaboration:<id>:v1
```

Marketplace must not write PMS, Finance, or affiliate-owned tables directly.

## ID Continuity

- `listingId` is the public legacy listing ID exposed by marketplace discovery.
- `creatorId` is the public legacy creator ID exposed by marketplace discovery.
- `collaborationId` remains stable across reads, lifecycle writes, later chat
  writes, and affiliate provisioning side effects.
- Target-native authorization UUIDs do not replace public request or response
  identifiers.

## Response Shape

Successful writes return command metadata, the updated
`MarketplaceCollaborationRead` projection, and an audit-facing `sideEffects`
array for emitted work such as system messages, notifications, acceptance
events, and affiliate provisioning commands. `sideEffects` must not expose
private email addresses, WorkOS membership IDs, PMS hotel IDs, or raw database
handles.

`rate_creator` responses must include `command.ratingId`, the persisted rating
identifier. Idempotency replays for the same rating return the original
`ratingId`; clients must not derive rating identifiers from idempotency keys.

## Error Codes

| Code                            | Status | Meaning                                                    |
| ------------------------------- | -----: | ---------------------------------------------------------- |
| `invalid_request`               |    400 | Invalid body, side, ID, or terms payload.                  |
| `unauthorized`                  |    401 | No valid authenticated request context.                    |
| `forbidden`                     |    403 | Permission, organization kind, or recipient role is wrong. |
| `missing_creator_resource_link` |    403 | Creator resource link is absent or inactive.               |
| `missing_hotel_resource_link`   |    403 | Hotel profile/listing link is absent or inactive.          |
| `collaboration_not_found`       |    404 | Collaboration is missing or outside the authorized side.   |
| `invalid_transition`            |    409 | Action is invalid for the current state.                   |
| `idempotency_conflict`          |    409 | Key was reused with a different payload.                   |
| `validation_failed`             |    422 | Domain validation failed.                                  |
| `internal_error`                |    500 | Unexpected write-model failure.                            |

## Fixtures

Executable fixture cases live in
[`fixtures/marketplace-collaboration-lifecycle-writes/cases.json`](fixtures/marketplace-collaboration-lifecycle-writes/cases.json).
They cover both-side create authorization, recipient-only response, approval
side effects, resource-link denial, invalid transition handling, and
idempotency replay/conflict behavior for every lifecycle write action. Approval
fixtures also pin affiliate provisioning side-effect metadata so retries cannot
emit duplicate downstream commands.
