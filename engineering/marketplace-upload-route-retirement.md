# Marketplace Upload Route Retirement

VAY-824 records the marketplace upload route disposition from
`engineering/platform-media-decision.md` for the application cutover.

The marketplace frontend no longer calls these legacy product-owned upload
helpers for profile or listing media:

| Legacy route                                  | Disposition                               | Replacement                                                                                                             |
| --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /upload/image`                          | Retired generic product upload helper.    | `POST /api/media/upload-sessions` with explicit purpose and resource scope, followed by finalize.                       |
| `POST /upload/images`                         | Retired generic product upload helper.    | Batch `POST /api/media/upload-sessions` with explicit purpose and resource scope, followed by finalize.                 |
| `POST /upload/image/hotel-profile`            | Retired from marketplace-web upload flow. | Platform media `property.hero_image`; the target catalog/profile command attaches the platform media object ID.         |
| `POST /upload/image/listing`                  | Retired from marketplace-web upload flow. | Platform media `marketplace.listing.gallery`; listing commands attach returned platform media object IDs.               |
| `POST /upload/images/listing`                 | Retired from marketplace-web upload flow. | Batch platform media `marketplace.listing.gallery`; listing commands attach returned platform media object IDs.         |
| `POST /upload/image/creator-profile`          | Retired from marketplace-web upload flow. | Platform media `marketplace.creator.profile_image`; creator profile commands attach returned platform media object IDs. |
| `POST /upload/image/chat`                     | Retired from marketplace-web chat flow.   | Private platform media `marketplace.collaboration_chat.attachment`; the V4 message command attaches returned media IDs. |
| `POST /hotels/me/upload-picture`              | Retired deprecated helper.                | Same platform media/profile command flow as `property.hero_image`.                                                      |
| `POST /hotels/me/listings/{id}/upload-images` | Retired deprecated helper.                | Same platform media/listing command flow as `marketplace.listing.gallery`.                                              |

VAY-825 retires `POST /upload/image/chat` from marketplace-web. Chat
attachments now create private platform media and send the returned media ID
through the collaboration message command.

Residual dependency: the VAY-823 base exposes marketplace self-service command
contracts, but the TypeScript profile/listing write adapters are not present in
this branch. Until those adapters are merged and the frontend consumes them,
marketplace-web includes platform media object IDs in compatibility payloads
while preserving legacy URL fields for the existing Python endpoints.
