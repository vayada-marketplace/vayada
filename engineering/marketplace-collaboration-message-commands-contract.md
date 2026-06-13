# MarketplaceCollaborationMessageCommands contract

This is the VAY-825 chat write slice for Marketplace collaboration V4. It
replaces the legacy `/upload/image/chat` upload-then-send flow with a message
command that attaches private platform media by ID.

Contract version: `marketplace-collaboration-message-commands.v1`.

## Endpoints

| Surface      | Method | Target path                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| Send message | `POST` | `/api/marketplace/collaborations/{collaborationId}/messages` |

## Authorization

The route is protected and must use route-policy enforcement at the adapter
boundary. It follows the V4 collaboration write side rules:

- creator-side sends require selected organization kind `creator_workspace`
  and an active owner link to the collaboration creator profile
- hotel-side sends require selected organization kind `hotel_group` and an
  active link to the collaboration hotel listing or hotel profile
- the addressed collaboration must be resolved before mutation so the adapter
  can prove the linked resource belongs to that collaboration

## Attachment Flow

Image attachments are uploaded through platform media before the message command:

1. `POST /api/media/upload-sessions` with purpose
   `marketplace.collaboration_chat.attachment`, visibility `private`, and a
   marketplace resource scope for the caller side.
2. Upload to the signed target and finalize the session.
3. `POST /api/marketplace/collaborations/{collaborationId}/messages` with
   `contentType: "image"` and `attachment.mediaObjectId`.

The message command validates that the media object exists, uses purpose
`marketplace.collaboration_chat.attachment`, is private, and belongs to the
authorized collaboration-side resource scope. The command stores a media
reference in message metadata; raw storage keys, buckets, signed upload URLs,
and private CDN tokens must not be returned in the command response.

## Request Shape

```ts
type SendMarketplaceCollaborationMessageCommandRequest = {
  idempotencyKey: string;
  side?: "creator" | "hotel";
  content?: string;
  contentType?: "text" | "image";
  attachment?: {
    mediaObjectId: string;
    purpose: "marketplace.collaboration_chat.attachment";
    originalFilename?: string;
    contentType?: string;
    sizeBytes?: number;
  };
};
```

Text sends require non-empty `content` and no attachment. Image sends require an
attachment and may include caption text in `content`.

## Response Shape

Successful writes return command metadata and the persisted V4 message read
shape:

```ts
type MarketplaceCollaborationMessageCommandResponse = {
  contractVersion: "marketplace-collaboration-message-commands.v1";
  readContractVersion: "marketplace-collaboration-reads.v1";
  command: {
    action: "send_message";
    idempotencyKey: string;
    messageId: string;
    replayed?: boolean;
    acceptedAt?: string;
  };
  message: MarketplaceCollaborationMessage;
  sideEffects: Array<{
    type: "marketplace.collaboration.message_stored";
    idempotencyKey: string;
  }>;
};
```

## Error Codes

| Code                            | Status | Meaning                                                       |
| ------------------------------- | -----: | ------------------------------------------------------------- |
| `invalid_request`               |    400 | Invalid body, side, ID, content, or content type.             |
| `invalid_attachment`            |    400 | Attachment is malformed or uses the wrong purpose/visibility. |
| `unauthorized`                  |    401 | No valid authenticated request context.                       |
| `forbidden`                     |    403 | Permission, organization kind, or side is wrong.              |
| `missing_creator_resource_link` |    403 | Creator resource link is absent or inactive.                  |
| `missing_hotel_resource_link`   |    403 | Hotel profile/listing link is absent or inactive.             |
| `collaboration_not_found`       |    404 | Collaboration is missing or outside the authorized side.      |
| `media_not_found`               |    404 | Referenced media object does not exist or is not accessible.  |
| `idempotency_conflict`          |    409 | Key was reused with a different payload.                      |
| `internal_error`                |    500 | Unexpected write-model failure.                               |

## Fixtures

Executable fixture cases live in
[`fixtures/marketplace-collaboration-message-commands/cases.json`](fixtures/marketplace-collaboration-message-commands/cases.json).
They cover text sends, private platform-media image attachment sends, media
purpose denial, missing media denial, and the explicit retirement of
`/upload/image/chat` from the marketplace chat attachment flow.
