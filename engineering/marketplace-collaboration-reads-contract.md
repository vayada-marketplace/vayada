# MarketplaceCollaborationReads contract

This contract is marketplace vertical **V4 (collaboration lifecycle and chat)** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md).
It is the first, read-only slice: collaboration lists, collaboration detail,
conversation summaries, and messages. Lifecycle writes stay out of this slice.

Legacy sources are `/collaborations*`, `/creators/me/collaborations*`,
`/hotels/me/collaborations*`, and chat message routes in
`apps/marketplace-api/app/routers/collaborations.py`. The current consumer is
`apps/marketplace-web`.

## Endpoints

| Surface              | Method | Target path                                                                        | Notes                                                                                                            |
| -------------------- | ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| My collaborations    | `GET`  | `/api/marketplace/collaborations/me?side=creator\|hotel`                           | Replaces creator/hotel-specific list routes.                                                                     |
| Collaboration detail | `GET`  | `/api/marketplace/collaborations/{collaborationId}?side=creator\|hotel`            | Enforces the requested side against selected organization kind.                                                  |
| Conversations        | `GET`  | `/api/marketplace/collaborations/conversations[?side=creator\|hotel]`              | Read-only chat inbox summaries. Side may be inferred from selected organization kind.                            |
| Messages             | `GET`  | `/api/marketplace/collaborations/{collaborationId}/messages[?side=creator\|hotel]` | Supports `before` and `limit` pagination when implemented. Side may be inferred from selected organization kind. |

Contract version: `marketplace-collaboration-reads.v1`.

## Authorization

All routes are protected and must use route-policy enforcement at the adapter
boundary.

Shared permission:

```text
marketplace.collaboration.read
```

`side` is required for list/detail calls that can otherwise be ambiguous. Chat
summary and message calls may omit it when the selected organization kind
unambiguously resolves the caller side (`creator_workspace` -> creator,
`hotel_group` -> hotel); if supplied, it must still match that selected
organization kind.

Creator-side reads require a selected `creator_workspace` organization and an
active owner link to the collaboration's creator profile:

```ts
{
  permission: "marketplace.collaboration.read",
  resource: {
    product: "marketplace",
    resourceType: "creator_profile",
    resourceId: collaboration.creatorProfileId,
    allowedRelationships: ["owner"],
  },
}
```

Hotel-side reads require a selected `hotel_group` organization and an active
link to the collaboration's hotel profile or listing. Detail and message routes
must resolve the addressed collaboration before returning rows:

```ts
{
  permission: "marketplace.collaboration.read",
  resource: {
    product: "marketplace",
    resourceType: "hotel_listing",
    resourceId: collaboration.listingResourceId,
    allowedRelationships: ["owner", "operator"],
  },
}
```

If a route uses the hotel profile link for list filtering, detail/message reads
must still prove that the addressed collaboration belongs to a listing or hotel
profile linked to the selected organization. Permission alone is not enough.

## ID Continuity

The collaboration create write slice must keep V1/V2 ID continuity:

- `listingId` is the public legacy listing ID exposed by marketplace discovery,
  not the target table primary key.
- `creatorId` is the public legacy creator ID exposed by marketplace discovery.
- `collaborationId` remains stable across reads, conversations, messages, and
  later lifecycle writes.
- Target-native listing/profile UUIDs used for authorization do not appear in
  response payloads unless they are already public resource IDs.

## Response Shape

```ts
type MarketplaceCollaborationRead = {
  contractVersion: "marketplace-collaboration-reads.v1";
  authorizationMode: "creator_workspace_resource_link" | "hotel_group_resource_link";
  collaborationId: string;
  listingId: string;
  creatorId: string;
  hotelProfileId: string;
  side: "creator" | "hotel";
  initiatorSide: "creator" | "hotel";
  isInitiator: boolean;
  status:
    | "pending"
    | "negotiating"
    | "accepted"
    | "active"
    | "completed"
    | "cancelled"
    | "rejected"
    | "declined";
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate" | null;
  listingName: string;
  listingLocation: string | null;
  creator: MarketplaceCollaborationParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: MarketplaceCollaborationTerms;
  deliverables: MarketplaceCollaborationDeliverable[];
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Conversation summaries and messages use the same contract version and
authorization modes. Message metadata may include platform-media references, but
new upload commands are out of scope for this read slice.

## Error Codes

| Code                            | Status | Meaning                                                      |
| ------------------------------- | -----: | ------------------------------------------------------------ |
| `invalid_query`                 |    400 | Invalid side, pagination, filter, or ID parameter.           |
| `unauthorized`                  |    401 | No valid authenticated request context.                      |
| `forbidden`                     |    403 | Permission or selected organization kind is wrong.           |
| `missing_creator_resource_link` |    403 | Creator-side resource link is absent or inactive.            |
| `missing_hotel_resource_link`   |    403 | Hotel-side profile/listing link is absent or inactive.       |
| `collaboration_not_found`       |    404 | The collaboration is missing or outside the authorized side. |
| `internal_error`                |    500 | Unexpected read-model failure.                               |

## Out Of Scope

The following lifecycle writes stay in follow-up slices:

- create collaboration from `listingId`/`creatorId`
- respond, approve, cancel, update terms, toggle deliverables, and rate creator
- mark chat messages read and send chat messages
- affiliate provisioning on collaboration acceptance

Affiliate provisioning must keep the accepted VAY-768 idempotency key:

```text
marketplace.affiliate.provision:collaboration:<id>:v1
```

The lifecycle write slice must emit that command/event through the typed
Marketplace-to-affiliate port instead of writing PMS tables.

## Fixtures

Executable fixture cases live in
[`fixtures/marketplace-collaboration-reads/cases.json`](fixtures/marketplace-collaboration-reads/cases.json).
They cover creator-side allowed reads, hotel-side allowed reads, and denial
cases for missing creator links, missing hotel listing links, and wrong-side
organization access.
