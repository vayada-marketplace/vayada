from unittest.mock import AsyncMock, patch

import pytest
from app.repositories.platform_media_repo import PlatformMediaAttachment
from app.services.channex import messaging


@pytest.mark.asyncio
async def test_persist_inbound_attachment_records_private_platform_media_reference():
    add_attachment = AsyncMock(return_value={"id": "message-attachment-1"})
    set_platform_media = AsyncMock()
    create_external_reference = AsyncMock(
        return_value=PlatformMediaAttachment(
            media_id="media-1",
            storage_key=None,
            filename="passport.png",
            content_type="image/png",
            size_bytes=98000,
        )
    )

    with (
        patch.object(messaging.MessageAttachmentRepository, "add", add_attachment),
        patch.object(
            messaging.MessageAttachmentRepository,
            "set_platform_media_object",
            set_platform_media,
        ),
        patch.object(
            messaging.PlatformMediaAttachmentRepository,
            "create_provider_external_reference",
            create_external_reference,
        ),
    ):
        await messaging._persist_attachments(
            property_id="property-1",
            thread_id="thread-1",
            message_id="message-1",
            attachments=[
                {
                    "id": "provider-attachment-1",
                    "links": {"url": "https://provider.example.test/passport.png"},
                    "file_name": "passport.png",
                    "file_type": "image/png",
                    "size": 98000,
                }
            ],
        )

    add_attachment.assert_awaited_once_with(
        message_id="message-1",
        source_url="https://provider.example.test/passport.png",
        filename="passport.png",
        content_type="image/png",
        size_bytes=98000,
        source_attachment_id="provider-attachment-1",
    )
    create_external_reference.assert_awaited_once_with(
        property_id="property-1",
        thread_id="thread-1",
        message_attachment_id="message-attachment-1",
        source_attachment_id="provider-attachment-1",
        source_url="https://provider.example.test/passport.png",
        filename="passport.png",
        content_type="image/png",
        size_bytes=98000,
    )
    set_platform_media.assert_awaited_once_with(
        attachment_id="message-attachment-1",
        platform_media_object_id="media-1",
    )
