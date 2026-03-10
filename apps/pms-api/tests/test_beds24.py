"""
Tests for Beds24 channel manager integration: config, models, repositories,
API client service, sync service, webhook, admin endpoints, scheduler, and
booking service hooks.
"""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, AsyncMock, MagicMock

from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    get_auth_headers,
)
from app.database import Database
from app.config import settings


# ── Helpers ────────────────────────────────────────────────────────


async def create_test_beds24_connection(
    hotel_id: str,
    beds24_property_id: str = None,
    is_active: bool = True,
) -> dict:
    """Insert a beds24_connections row for testing."""
    row = await Database.fetchrow(
        """
        INSERT INTO beds24_connections
            (hotel_id, api_token, refresh_token, token_expires_at,
             beds24_property_id, is_active)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        """,
        hotel_id,
        "test-api-token",
        "test-refresh-token",
        datetime.now(timezone.utc) + timedelta(hours=1),
        beds24_property_id,
        is_active,
    )
    return dict(row)


async def create_test_room_mapping(
    hotel_id: str,
    room_type_id: str,
    beds24_room_id: str = "b24-room-1",
) -> dict:
    """Insert a beds24_room_mappings row for testing."""
    row = await Database.fetchrow(
        """
        INSERT INTO beds24_room_mappings (hotel_id, room_type_id, beds24_room_id)
        VALUES ($1, $2, $3)
        RETURNING *
        """,
        hotel_id, room_type_id, beds24_room_id,
    )
    return dict(row)


async def create_test_booking_mapping(
    hotel_id: str,
    booking_id: str,
    beds24_booking_id: str = "b24-booking-1",
    channel_source: str = "beds24",
) -> dict:
    """Insert a beds24_booking_mappings row for testing."""
    row = await Database.fetchrow(
        """
        INSERT INTO beds24_booking_mappings
            (hotel_id, booking_id, beds24_booking_id, channel_source)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        """,
        hotel_id, booking_id, beds24_booking_id, channel_source,
    )
    return dict(row)


# ── Config ─────────────────────────────────────────────────────────


class TestBeds24Config:
    """Verify Beds24 config fields are present with defaults."""

    async def test_beds24_api_base_url(self, init_database):
        assert settings.BEDS24_API_BASE_URL == "https://api.beds24.com/v2"

    async def test_beds24_poll_interval(self, init_database):
        assert settings.BEDS24_POLL_INTERVAL_MINUTES == 5

    async def test_beds24_full_sync_hour(self, init_database):
        assert settings.BEDS24_FULL_SYNC_HOUR == 3

    async def test_beds24_api_delay(self, init_database):
        assert settings.BEDS24_API_DELAY_SECONDS == 2.0

    async def test_beds24_webhook_secret(self, init_database):
        assert hasattr(settings, "BEDS24_WEBHOOK_SECRET")


# ── Models ─────────────────────────────────────────────────────────


class TestBeds24Models:
    """Verify Beds24 pydantic models and camelCase aliasing."""

    async def test_connect_request(self, init_database):
        from app.models.beds24 import Beds24ConnectRequest

        req = Beds24ConnectRequest(invite_code="abc123")
        assert req.invite_code == "abc123"
        data = req.model_dump(by_alias=True)
        assert "inviteCode" in data

    async def test_connect_request_from_camel(self, init_database):
        from app.models.beds24 import Beds24ConnectRequest

        req = Beds24ConnectRequest(**{"inviteCode": "xyz"})
        assert req.invite_code == "xyz"

    async def test_connection_response(self, init_database):
        from app.models.beds24 import Beds24ConnectionResponse

        resp = Beds24ConnectionResponse(
            id="1", hotel_id="2", is_active=True, created_at="2026-01-01T00:00:00"
        )
        data = resp.model_dump(by_alias=True)
        assert data["hotelId"] == "2"
        assert data["isActive"] is True

    async def test_room_mapping_create(self, init_database):
        from app.models.beds24 import Beds24RoomMappingCreate

        m = Beds24RoomMappingCreate(room_type_id="rt1", beds24_room_id="b24r1")
        data = m.model_dump(by_alias=True)
        assert data["roomTypeId"] == "rt1"
        assert data["beds24RoomId"] == "b24r1"

    async def test_set_property_request(self, init_database):
        from app.models.beds24 import Beds24SetPropertyRequest

        r = Beds24SetPropertyRequest(beds24_property_id="prop-1")
        assert r.beds24_property_id == "prop-1"

    async def test_property_response(self, init_database):
        from app.models.beds24 import Beds24PropertyResponse

        p = Beds24PropertyResponse(id="1", name="My Property")
        assert p.name == "My Property"

    async def test_room_response(self, init_database):
        from app.models.beds24 import Beds24RoomResponse

        r = Beds24RoomResponse(id="1", name="Deluxe", qty=3)
        assert r.qty == 3


# ── Repository ─────────────────────────────────────────────────────


class TestBeds24ConnectionRepo:
    """Test Beds24ConnectionRepository CRUD operations."""

    async def test_upsert_creates_connection(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])

        conn = await Beds24ConnectionRepository.upsert(
            hotel_id, "token-1", "refresh-1",
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
        assert conn["hotel_id"] == hotel["id"]
        assert conn["api_token"] == "token-1"
        assert conn["is_active"] is True

    async def test_upsert_updates_existing(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])

        await Beds24ConnectionRepository.upsert(
            hotel_id, "token-1", "refresh-1",
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
        conn2 = await Beds24ConnectionRepository.upsert(
            hotel_id, "token-2", "refresh-2",
            datetime.now(timezone.utc) + timedelta(hours=2),
        )
        assert conn2["api_token"] == "token-2"

    async def test_get_by_hotel_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id)

        conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
        assert conn is not None
        assert conn["api_token"] == "test-api-token"

    async def test_get_by_hotel_id_not_found(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        conn = await Beds24ConnectionRepository.get_by_hotel_id("00000000-0000-0000-0000-000000000000")
        assert conn is None

    async def test_get_by_property_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id, beds24_property_id="prop-42")

        conn = await Beds24ConnectionRepository.get_by_property_id("prop-42")
        assert conn is not None
        assert str(conn["hotel_id"]) == hotel_id

    async def test_list_active(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id, is_active=True)

        active = await Beds24ConnectionRepository.list_active()
        assert any(str(c["hotel_id"]) == hotel_id for c in active)

    async def test_deactivate(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id)

        await Beds24ConnectionRepository.deactivate(hotel_id)
        conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
        assert conn["is_active"] is False

    async def test_set_property_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id)

        conn = await Beds24ConnectionRepository.set_property_id(hotel_id, "prop-99")
        assert conn["beds24_property_id"] == "prop-99"

    async def test_update_last_sync(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])
        await create_test_beds24_connection(hotel_id)

        now = datetime.now(timezone.utc)
        await Beds24ConnectionRepository.update_last_sync(hotel_id, now)
        conn = await Beds24ConnectionRepository.get_by_hotel_id(hotel_id)
        assert conn["last_sync_at"] is not None


class TestBeds24RoomMappingRepo:
    """Test Beds24RoomMappingRepository CRUD operations."""

    async def test_create_mapping(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24RoomMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        room_type_id = str(room["id"])

        mapping = await Beds24RoomMappingRepository.create(hotel_id, room_type_id, "b24-r1")
        assert mapping["beds24_room_id"] == "b24-r1"
        assert str(mapping["room_type_id"]) == room_type_id

    async def test_get_by_room_type_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24RoomMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        room_type_id = str(room["id"])
        await create_test_room_mapping(hotel_id, room_type_id)

        m = await Beds24RoomMappingRepository.get_by_room_type_id(room_type_id)
        assert m is not None
        assert m["beds24_room_id"] == "b24-room-1"

    async def test_get_by_beds24_room_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24RoomMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_room_mapping(str(hotel["id"]), str(room["id"]), "b24-unique")

        m = await Beds24RoomMappingRepository.get_by_beds24_room_id("b24-unique")
        assert m is not None
        assert str(m["room_type_id"]) == str(room["id"])

    async def test_list_by_hotel_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24RoomMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        await create_test_room_mapping(hotel_id, str(room["id"]))

        mappings = await Beds24RoomMappingRepository.list_by_hotel_id(hotel_id)
        assert len(mappings) == 1
        assert "room_type_name" in mappings[0]

    async def test_delete_mapping(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24RoomMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        mapping = await create_test_room_mapping(str(hotel["id"]), str(room["id"]))

        result = await Beds24RoomMappingRepository.delete(str(mapping["id"]))
        assert result is True

        m = await Beds24RoomMappingRepository.get_by_room_type_id(str(room["id"]))
        assert m is None


class TestBeds24BookingMappingRepo:
    """Test Beds24BookingMappingRepository CRUD operations."""

    async def test_create_booking_mapping(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))
        hotel_id = str(hotel["id"])
        booking_id = str(booking["id"])

        m = await Beds24BookingMappingRepository.create(
            hotel_id, booking_id, "b24-bk-1", "airbnb"
        )
        assert m["beds24_booking_id"] == "b24-bk-1"
        assert m["channel_source"] == "airbnb"

    async def test_get_by_booking_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))
        booking_id = str(booking["id"])
        await create_test_booking_mapping(str(hotel["id"]), booking_id)

        m = await Beds24BookingMappingRepository.get_by_booking_id(booking_id)
        assert m is not None
        assert m["beds24_booking_id"] == "b24-booking-1"

    async def test_get_by_beds24_id(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))
        await create_test_booking_mapping(
            str(hotel["id"]), str(booking["id"]), "b24-unique-bk"
        )

        m = await Beds24BookingMappingRepository.get_by_beds24_id("b24-unique-bk")
        assert m is not None
        assert str(m["booking_id"]) == str(booking["id"])

    async def test_update_sync_time(self, cleanup_database):
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))
        booking_id = str(booking["id"])
        await create_test_booking_mapping(str(hotel["id"]), booking_id)

        now = datetime.now(timezone.utc)
        await Beds24BookingMappingRepository.update_sync_time(booking_id, now)

        m = await Beds24BookingMappingRepository.get_by_booking_id(booking_id)
        assert m["last_synced_at"] is not None


# ── Sync Service ───────────────────────────────────────────────────


class TestSyncServiceInboundBooking:
    """Test process_inbound_booking for importing Beds24 bookings."""

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_import_new_booking(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import process_inbound_booking
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        await create_test_room_mapping(hotel_id, str(room["id"]), "b24-rm-import")

        b24_booking = {
            "id": "b24-import-1",
            "roomId": "b24-rm-import",
            "arrival": "2026-08-01",
            "departure": "2026-08-05",
            "guestName": "Jane Smith",
            "guestEmail": "jane@example.com",
            "guestPhone": "+11234567890",
            "price": 600.0,
            "numAdult": 2,
            "numChild": 1,
            "channelName": "Booking.com",
            "status": "confirmed",
        }

        await process_inbound_booking(b24_booking, hotel_id)

        mapping = await Beds24BookingMappingRepository.get_by_beds24_id("b24-import-1")
        assert mapping is not None
        assert mapping["channel_source"] == "Booking.com"

        # Verify booking was created
        from app.repositories.booking_repo import BookingRepository
        booking = await BookingRepository.get_by_id(str(mapping["booking_id"]))
        assert booking["status"] == "confirmed"
        assert booking["channel"] == "beds24"
        assert booking["guest_first_name"] == "Jane"
        assert booking["guest_last_name"] == "Smith"

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_import_duplicate_skipped(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import process_inbound_booking
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        booking = await create_test_booking(hotel_id, str(room["id"]))
        await create_test_booking_mapping(hotel_id, str(booking["id"]), "b24-dup-1")

        b24_booking = {
            "id": "b24-dup-1",
            "roomId": "some-room",
            "arrival": "2026-08-01",
            "departure": "2026-08-05",
            "status": "confirmed",
        }

        # Should not raise, should just update sync time
        await process_inbound_booking(b24_booking, hotel_id)

        m = await Beds24BookingMappingRepository.get_by_beds24_id("b24-dup-1")
        assert m["last_synced_at"] is not None

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_import_cancellation_of_existing(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import process_inbound_booking
        from app.repositories.booking_repo import BookingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        hotel_id = str(hotel["id"])
        booking = await create_test_booking(hotel_id, str(room["id"]), status="confirmed")
        await create_test_booking_mapping(hotel_id, str(booking["id"]), "b24-cancel-1")

        b24_booking = {
            "id": "b24-cancel-1",
            "status": "cancelled",
        }

        await process_inbound_booking(b24_booking, hotel_id)

        updated = await BookingRepository.get_by_id(str(booking["id"]))
        assert updated["status"] == "cancelled"

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_import_cancelled_new_skipped(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import process_inbound_booking
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])

        b24_booking = {
            "id": "b24-skip-cancel",
            "status": "cancelled",
        }

        await process_inbound_booking(b24_booking, hotel_id)

        m = await Beds24BookingMappingRepository.get_by_beds24_id("b24-skip-cancel")
        assert m is None

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_import_no_room_mapping_skipped(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import process_inbound_booking
        from app.repositories.beds24_mapping_repo import Beds24BookingMappingRepository

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])

        b24_booking = {
            "id": "b24-no-map",
            "roomId": "unknown-room-id",
            "arrival": "2026-08-01",
            "departure": "2026-08-05",
            "status": "confirmed",
        }

        await process_inbound_booking(b24_booking, hotel_id)

        m = await Beds24BookingMappingRepository.get_by_beds24_id("b24-no-map")
        assert m is None


class TestSyncServicePushAvailability:
    """Test availability push logic."""

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_push_availability_for_room_type(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import push_availability_for_room_type
        from datetime import date

        mock_svc.set_room_calendar = AsyncMock(return_value={})

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=3)
        hotel_id = str(hotel["id"])
        room_type_id = str(room["id"])
        await create_test_beds24_connection(hotel_id)
        await create_test_room_mapping(hotel_id, room_type_id, "b24-push-room")

        start = date(2026, 9, 1)
        end = date(2026, 9, 4)  # 3 days
        await push_availability_for_room_type(hotel_id, room_type_id, start, end)

        mock_svc.set_room_calendar.assert_called_once()
        args = mock_svc.set_room_calendar.call_args
        assert args[0][1] == "b24-push-room"
        calendar = args[0][2]
        assert len(calendar) == 3
        assert calendar[0]["date"] == "2026-09-01"
        assert calendar[0]["available"] == 3

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_push_no_mapping_noop(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import push_availability_for_room_type
        from datetime import date

        mock_svc.set_room_calendar = AsyncMock()

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        await push_availability_for_room_type(
            str(hotel["id"]), str(room["id"]),
            date(2026, 9, 1), date(2026, 9, 3),
        )

        mock_svc.set_room_calendar.assert_not_called()

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_push_availability_reduces_with_bookings(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import push_availability_for_room_type
        from datetime import date

        mock_svc.set_room_calendar = AsyncMock(return_value={})

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=3)
        hotel_id = str(hotel["id"])
        room_type_id = str(room["id"])
        await create_test_beds24_connection(hotel_id)
        await create_test_room_mapping(hotel_id, room_type_id, "b24-avail-room")

        # Create a booking overlapping Sep 1-3
        await create_test_booking(
            hotel_id, room_type_id,
            check_in="2026-09-01", check_out="2026-09-03",
            status="confirmed",
        )

        start = date(2026, 9, 1)
        end = date(2026, 9, 4)
        await push_availability_for_room_type(hotel_id, room_type_id, start, end)

        calendar = mock_svc.set_room_calendar.call_args[0][2]
        # Sep 1 and Sep 2 should have 2 available (3 total - 1 booked)
        assert calendar[0]["available"] == 2  # Sep 1
        assert calendar[1]["available"] == 2  # Sep 2
        assert calendar[2]["available"] == 3  # Sep 3 (booking ends this day)


class TestSyncServiceCancellation:
    """Test outbound cancellation propagation."""

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_handle_vayada_cancellation(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import handle_vayada_cancellation

        mock_svc.cancel_booking = AsyncMock(return_value={})

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))
        booking_id = str(booking["id"])
        await create_test_booking_mapping(str(hotel["id"]), booking_id, "b24-canc-out")

        await handle_vayada_cancellation(booking_id)

        mock_svc.cancel_booking.assert_called_once()
        assert mock_svc.cancel_booking.call_args[0][1] == "b24-canc-out"

    @patch("app.services.beds24_sync_service.beds24_service")
    async def test_handle_cancellation_no_mapping_noop(self, mock_svc, cleanup_database):
        from app.services.beds24_sync_service import handle_vayada_cancellation

        mock_svc.cancel_booking = AsyncMock()

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(str(hotel["id"]), str(room["id"]))

        await handle_vayada_cancellation(str(booking["id"]))
        mock_svc.cancel_booking.assert_not_called()


# ── Webhook ────────────────────────────────────────────────────────


class TestBeds24Webhook:
    """Test POST /webhooks/beds24 endpoint."""

    async def test_webhook_missing_token(self, client):
        resp = await client.post(
            "/webhooks/beds24",
            content=json.dumps({"id": "1"}),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 400
        assert "Missing" in resp.json()["detail"]

    async def test_webhook_invalid_token(self, client):
        resp = await client.post(
            "/webhooks/beds24",
            content=json.dumps({"id": "1"}),
            headers={
                "content-type": "application/json",
                "x-beds24-token": "wrong-token",
            },
        )
        assert resp.status_code == 400
        assert "Invalid" in resp.json()["detail"]

    @patch("app.repositories.beds24_mapping_repo.Beds24ConnectionRepository.get_by_property_id", new_callable=AsyncMock)
    async def test_webhook_valid_token_processes(self, mock_get_prop, client, cleanup_database):
        # Set a known webhook secret for the test
        original = settings.BEDS24_WEBHOOK_SECRET
        settings.BEDS24_WEBHOOK_SECRET = "test-beds24-secret"

        mock_get_prop.return_value = None

        try:
            resp = await client.post(
                "/webhooks/beds24",
                content=json.dumps({"id": "1", "propertyId": "999"}),
                headers={
                    "content-type": "application/json",
                    "x-beds24-token": "test-beds24-secret",
                },
            )
            assert resp.status_code == 200
            assert resp.json()["status"] == "ok"
        finally:
            settings.BEDS24_WEBHOOK_SECRET = original


# ── Admin Endpoints ────────────────────────────────────────────────


class TestBeds24AdminConnect:
    """Test Beds24 admin connection endpoints."""

    @patch("app.services.beds24_service.setup_connection")
    async def test_connect(self, mock_setup, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        hotel_id = str(hotel["id"])

        mock_setup.return_value = {
            "id": "00000000-0000-0000-0000-000000000001",
            "hotel_id": hotel["id"],
            "beds24_property_id": None,
            "is_active": True,
            "last_sync_at": None,
            "created_at": datetime.now(timezone.utc),
        }

        resp = await client.post(
            "/admin/beds24/connect",
            json={"inviteCode": "test-code"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["isActive"] is True

    async def test_connect_requires_auth(self, client):
        resp = await client.post(
            "/admin/beds24/connect",
            json={"inviteCode": "test"},
        )
        assert resp.status_code in (401, 403)

    async def test_get_connection(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]), beds24_property_id="prop-1")

        resp = await client.get(
            "/admin/beds24/connection",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["beds24PropertyId"] == "prop-1"

    async def test_get_connection_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/beds24/connection",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_disconnect(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]))

        resp = await client.delete(
            "/admin/beds24/connection",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Verify deactivated
        from app.repositories.beds24_mapping_repo import Beds24ConnectionRepository
        conn = await Beds24ConnectionRepository.get_by_hotel_id(str(hotel["id"]))
        assert conn["is_active"] is False


class TestBeds24AdminProperty:
    """Test Beds24 admin property mapping endpoints."""

    @patch("app.services.beds24_service.get_properties")
    async def test_list_properties(self, mock_get, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]))

        mock_get.return_value = [
            {"id": "p1", "name": "Beach Hotel"},
            {"id": "p2", "name": "City Hotel"},
        ]

        resp = await client.get(
            "/admin/beds24/properties",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    async def test_set_property(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]))

        resp = await client.post(
            "/admin/beds24/property",
            json={"beds24PropertyId": "prop-new"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["beds24PropertyId"] == "prop-new"


class TestBeds24AdminRooms:
    """Test Beds24 admin room listing and mapping endpoints."""

    @patch("app.services.beds24_service.get_property_rooms")
    async def test_list_beds24_rooms(self, mock_rooms, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]), beds24_property_id="prop-x")

        mock_rooms.return_value = [
            {"id": "r1", "name": "Deluxe King", "qty": 2},
        ]

        resp = await client.get(
            "/admin/beds24/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()[0]["name"] == "Deluxe King"

    async def test_list_rooms_no_property(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]))  # no property mapped

        resp = await client.get(
            "/admin/beds24/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_create_room_mapping(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        resp = await client.post(
            "/admin/beds24/room-mappings",
            json={"roomTypeId": str(room["id"]), "beds24RoomId": "b24-admin-r1"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        assert resp.json()["beds24RoomId"] == "b24-admin-r1"

    async def test_create_room_mapping_duplicate_fails(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_room_mapping(str(hotel["id"]), str(room["id"]), "b24-dup-r")

        resp = await client.post(
            "/admin/beds24/room-mappings",
            json={"roomTypeId": str(room["id"]), "beds24RoomId": "b24-another"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 409

    async def test_list_room_mappings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_room_mapping(str(hotel["id"]), str(room["id"]))

        resp = await client.get(
            "/admin/beds24/room-mappings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    async def test_delete_room_mapping(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        mapping = await create_test_room_mapping(str(hotel["id"]), str(room["id"]))

        resp = await client.delete(
            f"/admin/beds24/room-mappings/{mapping['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

    async def test_delete_room_mapping_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.delete(
            "/admin/beds24/room-mappings/00000000-0000-0000-0000-000000000099",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404


class TestBeds24AdminSyncAvailability:
    """Test manual availability sync endpoint."""

    @patch("app.services.beds24_sync_service.push_availability_for_hotel", new_callable=AsyncMock)
    async def test_sync_availability(self, mock_push, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_beds24_connection(str(hotel["id"]))

        resp = await client.post(
            "/admin/beds24/sync-availability",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "sync_started"

    async def test_sync_no_connection(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/beds24/sync-availability",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400


# ── Scheduler ──────────────────────────────────────────────────────


class TestBeds24Scheduler:
    """Test scheduler job registration."""

    async def test_scheduler_has_beds24_jobs(self, init_database):
        from app.services.scheduler import scheduler

        job_ids = [j.id for j in scheduler.get_jobs()]
        assert "poll_beds24_bookings" in job_ids
        assert "full_beds24_availability_sync" in job_ids

    @patch("app.repositories.beds24_mapping_repo.Beds24ConnectionRepository.list_active", new_callable=AsyncMock)
    @patch("app.services.beds24_sync_service.poll_bookings_for_hotel", new_callable=AsyncMock)
    async def test_poll_beds24_bookings_calls_all_active(
        self, mock_poll, mock_list_active, init_database
    ):
        from app.services.scheduler import poll_beds24_bookings

        mock_list_active.return_value = [
            {"hotel_id": "h1"},
            {"hotel_id": "h2"},
        ]

        await poll_beds24_bookings()
        assert mock_poll.call_count == 2

    @patch("app.repositories.beds24_mapping_repo.Beds24ConnectionRepository.list_active", new_callable=AsyncMock)
    @patch("app.services.beds24_sync_service.push_availability_for_hotel", new_callable=AsyncMock)
    async def test_full_sync_calls_all_active(
        self, mock_push, mock_list_active, init_database
    ):
        from app.services.scheduler import full_beds24_availability_sync

        mock_list_active.return_value = [
            {"hotel_id": "h1"},
        ]

        await full_beds24_availability_sync()
        mock_push.assert_called_once_with("h1")


# ── Booking Service Hooks ──────────────────────────────────────────


class TestBookingServiceHooks:
    """Test that booking service methods fire Beds24 sync tasks."""

    @patch("app.services.beds24_sync_service.push_availability_for_booking", new_callable=AsyncMock)
    @patch("app.services.stripe_service.capture_payment_intent", new_callable=AsyncMock)
    async def test_accept_booking_fires_sync(self, mock_stripe, mock_push, cleanup_database):
        from app.services.booking_service import host_accept_booking
        from tests.conftest import create_test_booking_with_payment, create_test_payment_settings

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="pay_at_property",
            payment_status="pay_at_property",
        )

        await host_accept_booking(str(booking["id"]), str(user["id"]))

        # Give fire-and-forget tasks a moment to register
        import asyncio
        await asyncio.sleep(0.1)
        mock_push.assert_called_once_with(str(booking["id"]))

    @patch("app.services.beds24_sync_service.handle_vayada_cancellation", new_callable=AsyncMock)
    @patch("app.services.beds24_sync_service.push_availability_for_booking", new_callable=AsyncMock)
    async def test_reject_booking_fires_sync(self, mock_push, mock_cancel, cleanup_database):
        from app.services.booking_service import host_reject_booking
        from tests.conftest import create_test_booking_with_payment, create_test_payment_settings

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="pay_at_property",
            payment_status="pay_at_property",
        )

        await host_reject_booking(str(booking["id"]), str(user["id"]))

        import asyncio
        await asyncio.sleep(0.1)
        mock_push.assert_called_once_with(str(booking["id"]))
        mock_cancel.assert_called_once_with(str(booking["id"]))


# ── Shutdown ───────────────────────────────────────────────────────


class TestShutdownCleanup:
    """Test that beds24 client close is wired in main.py."""

    async def test_beds24_close_client_exists(self, init_database):
        from app.services import beds24_service
        assert hasattr(beds24_service, "close_client")
        assert callable(beds24_service.close_client)
