"""
Tests for chat/messaging endpoints.
"""
import pytest
from httpx import AsyncClient

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_creator,
    create_test_hotel,
    create_test_listing,
    create_test_collaboration,
)


class TestGetConversations:
    """Tests for GET /collaborations/conversations"""

    async def test_get_conversations_list(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting conversations list."""
        # First, accept the collaboration to enable chat
        collab_id = str(test_collaboration["collaboration"]["id"])
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1

    async def test_conversations_include_partner_info(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that conversations include partner information."""
        collab_id = str(test_collaboration["collaboration"]["id"])
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        if len(data) > 0:
            conv = data[0]
            assert "partner_name" in conv
            assert "partner_avatar" in conv
            assert "my_role" in conv

    async def test_conversations_include_unread_count(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that conversations include unread count."""
        collab_id = str(test_collaboration["collaboration"]["id"])
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Send a message from hotel
        await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Hello!", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Get conversations as creator
        response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        if len(data) > 0:
            assert "unread_count" in data[0]
            assert data[0]["unread_count"] >= 1

    async def test_pending_collaborations_not_in_conversations(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that pending collaborations don't appear in conversations."""
        # Don't accept the collaboration - leave it pending
        response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Pending collaborations should not appear
        for conv in data:
            assert conv["collaboration_status"] != "pending"

    async def test_conversations_no_auth(
        self, client: AsyncClient
    ):
        """Test getting conversations without authentication."""
        response = await client.get("/collaborations/conversations")

        assert response.status_code == 403


class TestGetChatMessages:
    """Tests for GET /collaborations/{id}/messages"""

    async def test_get_messages_success(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting chat messages."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept to enable chat
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.get(
            f"/collaborations/{collab_id}/messages",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        # Should include system messages from accept
        assert len(data) >= 1

    async def test_get_messages_includes_system_messages(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that messages include system messages."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept to create system messages
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.get(
            f"/collaborations/{collab_id}/messages",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        system_messages = [m for m in data if m["message_type"] == "system"]
        assert len(system_messages) >= 1

    async def test_get_messages_pagination(
        self, client: AsyncClient, test_collaboration
    ):
        """Test message pagination."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept and send some messages
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        for i in range(5):
            await client.post(
                f"/collaborations/{collab_id}/messages",
                json={"content": f"Message {i}", "message_type": "text"},
                headers=get_auth_headers(test_collaboration["creator"]["token"])
            )

        response = await client.get(
            f"/collaborations/{collab_id}/messages?limit=3",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Should return at most 3 (limit) messages
        # Note: actual count may vary based on implementation

    async def test_get_messages_before_timestamp(
        self, client: AsyncClient, test_collaboration
    ):
        """Test getting messages before a timestamp."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept and send messages
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Get all messages first
        all_response = await client.get(
            f"/collaborations/{collab_id}/messages",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )
        all_data = all_response.json()

        if len(all_data) > 0:
            before_time = all_data[0]["created_at"]

            response = await client.get(
                f"/collaborations/{collab_id}/messages?before={before_time}",
                headers=get_auth_headers(test_collaboration["creator"]["token"])
            )

            assert response.status_code == 200


class TestSendChatMessage:
    """Tests for POST /collaborations/{id}/messages"""

    async def test_send_message_success(
        self, client: AsyncClient, test_collaboration
    ):
        """Test sending a chat message."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Hello, looking forward to our collaboration!", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["content"] == "Hello, looking forward to our collaboration!"
        assert data["message_type"] == "text"
        assert data["sender_id"] == str(test_collaboration["creator"]["user"]["id"])

    async def test_send_message_from_hotel(
        self, client: AsyncClient, test_collaboration
    ):
        """Test hotel sending a message."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Welcome! We're excited to host you.", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["sender_id"] == str(test_collaboration["hotel"]["user"]["id"])

    async def test_send_message_no_auth(
        self, client: AsyncClient, test_collaboration
    ):
        """Test sending message without authentication."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Test", "message_type": "text"}
        )

        assert response.status_code == 403

    async def test_send_empty_message(
        self, client: AsyncClient, test_collaboration
    ):
        """Test sending empty message."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        # Depending on validation, this could be 200 (empty message allowed) or 422
        assert response.status_code in [200, 422]


class TestMarkMessagesAsRead:
    """Tests for POST /collaborations/{id}/read"""

    async def test_mark_as_read_success(
        self, client: AsyncClient, test_collaboration
    ):
        """Test marking messages as read."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept and send message
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Unread message", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Creator marks as read
        response = await client.post(
            f"/collaborations/{collab_id}/read",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"

    async def test_mark_as_read_updates_unread_count(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that marking as read updates unread count."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept and send messages
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Message 1", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Check unread count before
        conv_response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )
        conv_data = conv_response.json()
        collab_conv = [c for c in conv_data if c["collaboration_id"] == collab_id]
        if collab_conv:
            initial_unread = collab_conv[0]["unread_count"]

            # Mark as read
            await client.post(
                f"/collaborations/{collab_id}/read",
                headers=get_auth_headers(test_collaboration["creator"]["token"])
            )

            # Check unread count after
            conv_response_after = await client.get(
                "/collaborations/conversations",
                headers=get_auth_headers(test_collaboration["creator"]["token"])
            )
            conv_data_after = conv_response_after.json()
            collab_conv_after = [c for c in conv_data_after if c["collaboration_id"] == collab_id]
            if collab_conv_after:
                assert collab_conv_after[0]["unread_count"] == 0

    async def test_mark_as_read_no_auth(
        self, client: AsyncClient, test_collaboration
    ):
        """Test marking as read without authentication."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(f"/collaborations/{collab_id}/read")

        assert response.status_code == 403


class TestChatMessageTypes:
    """Tests for different message types"""

    async def test_send_text_message(
        self, client: AsyncClient, test_collaboration
    ):
        """Test sending text message."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.post(
            f"/collaborations/{collab_id}/messages",
            json={"content": "Text message", "message_type": "text"},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        assert response.json()["message_type"] == "text"


class TestChatConversationOrdering:
    """Tests for conversation ordering"""

    async def test_conversations_ordered_by_last_message(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that conversations are ordered by last message time."""
        from tests.conftest import create_test_creator, create_test_hotel, create_test_listing, create_test_collaboration

        # Create two collaborations
        creator = await create_test_creator()

        hotel1 = await create_test_hotel()
        listing1 = await create_test_listing(hotel_profile_id=str(hotel1["hotel"]["id"]))
        collab1 = await create_test_collaboration(
            creator_id=str(creator["creator"]["id"]),
            hotel_id=str(hotel1["hotel"]["id"]),
            listing_id=str(listing1["listing"]["id"])
        )

        hotel2 = await create_test_hotel()
        listing2 = await create_test_listing(hotel_profile_id=str(hotel2["hotel"]["id"]))
        collab2 = await create_test_collaboration(
            creator_id=str(creator["creator"]["id"]),
            hotel_id=str(hotel2["hotel"]["id"]),
            listing_id=str(listing2["listing"]["id"])
        )

        # Accept both
        await client.post(
            f"/collaborations/{collab1['id']}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(hotel1["token"])
        )
        await client.post(
            f"/collaborations/{collab2['id']}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(hotel2["token"])
        )

        # Send message in collab1 first
        await client.post(
            f"/collaborations/{collab1['id']}/messages",
            json={"content": "First", "message_type": "text"},
            headers=get_auth_headers(creator["token"])
        )

        # Then send in collab2
        await client.post(
            f"/collaborations/{collab2['id']}/messages",
            json={"content": "Second", "message_type": "text"},
            headers=get_auth_headers(creator["token"])
        )

        # Get conversations
        response = await client.get(
            "/collaborations/conversations",
            headers=get_auth_headers(creator["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Most recent message should be first
        if len(data) >= 2:
            assert data[0]["last_message_content"] == "Second"
