"""Unit tests for the inbox attachment + message-send paths (VAY-358).

These cover the pure validation helpers and the send-message loop's per-
attachment dispatch behavior. Mocks every external dependency (auth, DB,
Channex) so they can run without the test database stack.
"""

from datetime import UTC, datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from app.models.messaging import SendMessageRequest
from app.routers import admin_messaging
from app.routers.admin_messaging import (
    max_attachment_bytes_for_channel,
    send_message,
    upload_thread_attachment,
    validate_attachment,
)
from fastapi import HTTPException

# ── validate_attachment ────────────────────────────────────────────────


def test_validate_attachment_accepts_image_jpeg():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_accepts_pdf():
    validate_attachment(
        content_type="application/pdf",
        size_bytes=1024,
        channel="booking.com",
    )


def test_validate_attachment_strips_charset_suffix():
    # Some browsers send `image/jpeg; charset=binary`.
    validate_attachment(
        content_type="image/jpeg; charset=binary",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_is_case_insensitive_on_mime():
    validate_attachment(
        content_type="IMAGE/PNG",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_rejects_zip():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="application/zip",
            size_bytes=1024,
            channel="booking.com",
        )
    assert exc.value.status_code == 415
    assert "booking.com" in exc.value.detail
    assert "application/zip" in exc.value.detail


def test_validate_attachment_rejects_missing_content_type():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type=None,
            size_bytes=1024,
            channel="airbnb",
        )
    assert exc.value.status_code == 415


def test_validate_attachment_rejects_oversize_for_bdc():
    # Booking.com cap is 8MB.
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="image/jpeg",
            size_bytes=9 * 1024 * 1024,
            channel="booking.com",
        )
    assert exc.value.status_code == 413
    assert "8 MB" in exc.value.detail


def test_validate_attachment_allows_bdc_at_limit():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=8 * 1024 * 1024,
        channel="booking.com",
    )


def test_validate_attachment_allows_airbnb_up_to_25mb():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=25 * 1024 * 1024,
        channel="airbnb",
    )


def test_validate_attachment_rejects_airbnb_above_25mb():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="image/jpeg",
            size_bytes=26 * 1024 * 1024,
            channel="airbnb",
        )
    assert exc.value.status_code == 413
    assert "25 MB" in exc.value.detail


def test_max_attachment_bytes_unknown_channel_uses_default():
    assert max_attachment_bytes_for_channel("nonsense") == 25 * 1024 * 1024
    assert max_attachment_bytes_for_channel(None) == 25 * 1024 * 1024


def test_max_attachment_bytes_is_case_insensitive():
    assert max_attachment_bytes_for_channel("Booking.Com") == 8 * 1024 * 1024


# ── upload_thread_attachment validation ────────────────────────────────


class _FakeUploadFile:
    def __init__(self, data: bytes, *, content_type: str, filename: str):
        self._data = data
        self.content_type = content_type
        self.filename = filename

    async def read(self) -> bytes:
        return self._data


@pytest.mark.asyncio
async def test_upload_rejects_disallowed_mime_before_calling_channex():
    fake_upload_attachment = AsyncMock()
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "booking.com", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await upload_thread_attachment(
                thread_id="t1",
                file=_FakeUploadFile(
                    b"data",
                    content_type="application/zip",
                    filename="x.zip",
                ),
                user_id="u1",
            )
    assert exc.value.status_code == 415
    fake_upload_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_upload_rejects_oversize_before_calling_channex():
    fake_upload_attachment = AsyncMock()
    big = b"\x00" * (9 * 1024 * 1024)  # 9MB > BDC's 8MB
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "booking.com", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await upload_thread_attachment(
                thread_id="t1",
                file=_FakeUploadFile(
                    big,
                    content_type="image/jpeg",
                    filename="x.jpg",
                ),
                user_id="u1",
            )
    assert exc.value.status_code == 413
    fake_upload_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_upload_calls_channex_for_allowed_jpeg():
    fake_upload_attachment = AsyncMock(return_value={"id": "att-123"})
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "airbnb", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        result = await upload_thread_attachment(
            thread_id="t1",
            file=_FakeUploadFile(
                b"jpegdata",
                content_type="image/jpeg",
                filename="ok.jpg",
            ),
            user_id="u1",
        )
    assert result == {"attachment_id": "att-123"}
    fake_upload_attachment.assert_awaited_once()


# ── send_message loop dispatch ─────────────────────────────────────────


def _channex_msg(msg_id: str) -> dict:
    return {
        "id": msg_id,
        "attributes": {
            "inserted_at": datetime.now(UTC).isoformat(),
        },
    }


def _inserted_row(row_id: str, body: str = "") -> dict:
    return {
        "id": row_id,
        "thread_id": "t1",
        "direction": "outbound",
        "sender_name": None,
        "body": body,
        "sent_at": datetime.now(UTC),
        "read_at": None,
    }


@pytest.mark.asyncio
async def test_send_message_with_two_attachments_issues_two_channex_calls():
    """Body rides with the first attachment; the second has empty body."""
    post_mock = AsyncMock(side_effect=[_channex_msg("m1"), _channex_msg("m2")])
    insert_mock = AsyncMock(
        side_effect=[
            _inserted_row("row1", "Hello!"),
            _inserted_row("row2"),
        ]
    )

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "booking.com",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            insert_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "list_by_message",
            AsyncMock(return_value=[]),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        await send_message(
            thread_id="t1",
            body=SendMessageRequest(body="Hello!", attachment_ids=["a1", "a2"]),
            user_id="u1",
        )

    assert post_mock.await_count == 2
    first_kwargs = post_mock.await_args_list[0].kwargs
    second_kwargs = post_mock.await_args_list[1].kwargs
    assert first_kwargs["message"] == "Hello!"
    assert first_kwargs["attachment_id"] == "a1"
    assert second_kwargs["message"] == ""
    assert second_kwargs["attachment_id"] == "a2"


@pytest.mark.asyncio
async def test_send_message_attachment_only_issues_one_channex_call():
    post_mock = AsyncMock(return_value=_channex_msg("m1"))
    insert_mock = AsyncMock(return_value=_inserted_row("row1"))

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            insert_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "list_by_message",
            AsyncMock(return_value=[]),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        await send_message(
            thread_id="t1",
            body=SendMessageRequest(body="", attachment_ids=["a1"]),
            user_id="u1",
        )

    assert post_mock.await_count == 1
    kwargs = post_mock.await_args.kwargs
    assert kwargs["message"] == ""
    assert kwargs["attachment_id"] == "a1"


@pytest.mark.asyncio
async def test_send_message_partial_failure_surfaces_count_in_error():
    """If the 2nd attachment's Channex call fails, the user must be told the
    1st already went through so they don't blindly retry both."""
    post_mock = AsyncMock(
        side_effect=[
            _channex_msg("m1"),
            Exception("boom"),
        ]
    )

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            AsyncMock(return_value=_inserted_row("row1")),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await send_message(
                thread_id="t1",
                body=SendMessageRequest(body="", attachment_ids=["a1", "a2"]),
                user_id="u1",
            )

    assert exc.value.status_code == 502
    assert "1 of 2" in exc.value.detail


@pytest.mark.asyncio
async def test_send_message_rejects_empty_payload():
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await send_message(
                thread_id="t1",
                body=SendMessageRequest(body="", attachment_ids=[]),
                user_id="u1",
            )
    assert exc.value.status_code == 400
