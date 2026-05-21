"""Tests for guest-initiated booking change requests (VAY-379).

Covers:
- preview surfaces price diff and availability
- price-reducing change blocked when booking already paid
- duplicate pending change requests blocked
- approve mutates booking dates / total
- decline leaves booking untouched
"""
import pytest
from unittest.mock import patch, AsyncMock

from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_room,
    get_auth_headers,
)


async def _make_confirmed_booking(check_in="2026-09-01", check_out="2026-09-05"):
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]), total_rooms=2)
    await create_test_room(str(hotel["id"]), str(room["id"]), room_number="201")
    await create_test_room(str(hotel["id"]), str(room["id"]), room_number="202")
    booking = await create_test_booking(
        str(hotel["id"]), str(room["id"]),
        check_in=check_in, check_out=check_out,
        guest_email="changeguest@example.com",
        nightly_rate=150.0, status="confirmed",
    )
    return user, hotel, room, booking


@patch("app.services.booking_change_service.send_host_change_request", new_callable=AsyncMock)
@patch("app.services.booking_change_service.send_guest_change_request_received", new_callable=AsyncMock)
@patch("app.services.booking_change_service.push_availability_for_room_type", new_callable=AsyncMock)
@patch("app.services.booking_change_service.push_ari_for_booking", new_callable=AsyncMock)
class TestChangeRequestFlow:
    async def test_preview_returns_price_diff_for_extended_stay(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        _user, hotel, _room, booking = await _make_confirmed_booking()

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request/preview",
            json={
                "guestEmail": "changeguest@example.com",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-08",  # +3 nights
                "addonIds": [],
                "addonQuantities": {},
                "addonDates": {},
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # 7 nights * 150 = 1050; old was 4*150 = 600
        assert body["oldTotal"] == 600.0
        assert body["newTotal"] == 1050.0
        assert body["priceDifference"] == 450.0
        assert body["blocked"] is False
        assert body["available"] is True

    async def test_preview_blocks_price_decrease_for_paid_booking(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        from app.database import Database
        _user, hotel, _room, booking = await _make_confirmed_booking()
        # Mark the booking as already paid (captured)
        await Database.execute(
            "UPDATE bookings SET payment_status = 'captured', payment_method = 'card' "
            "WHERE id = $1",
            booking["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request/preview",
            json={
                "guestEmail": "changeguest@example.com",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-03",  # shorten — price drops
                "addonIds": [],
                "addonQuantities": {},
                "addonDates": {},
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["priceDifference"] < 0
        assert body["blocked"] is True
        assert "already paid" in body["blockReason"].lower()

    async def test_submit_then_duplicate_blocked(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        _user, hotel, _room, booking = await _make_confirmed_booking()
        payload = {
            "guestEmail": "changeguest@example.com",
            "checkIn": "2026-09-01",
            "checkOut": "2026-09-08",
            "addonIds": [],
            "addonQuantities": {},
            "addonDates": {},
        }
        resp1 = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request",
            json=payload,
        )
        assert resp1.status_code == 200, resp1.text
        cr = resp1.json()
        assert cr["status"] == "pending"
        assert cr["priceDifference"] == 450.0

        # Second submission must be rejected.
        resp2 = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request",
            json=payload,
        )
        assert resp2.status_code == 400
        assert "pending" in resp2.json()["detail"].lower()

    async def test_approve_applies_change_to_booking(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        from app.database import Database
        user, hotel, _room, booking = await _make_confirmed_booking()
        # Submit a change request as the guest first.
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request",
            json={
                "guestEmail": "changeguest@example.com",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-08",
                "addonIds": [],
                "addonQuantities": {},
                "addonDates": {},
            },
        )
        assert resp.status_code == 200, resp.text

        # Patch decision-side emails so they don't try to fire.
        with patch(
            "app.services.booking_change_service.send_guest_change_request_approved",
            new_callable=AsyncMock,
        ), patch(
            "app.services.booking_change_service.send_host_change_request_decision",
            new_callable=AsyncMock,
        ):
            approve_resp = await client.post(
                f"/admin/bookings/{booking['id']}/change-request/approve",
                headers=get_auth_headers(user["token"]),
            )
        assert approve_resp.status_code == 200, approve_resp.text
        cr = approve_resp.json()
        assert cr["status"] == "approved"

        # Booking row should reflect new dates and total.
        row = await Database.fetchrow(
            "SELECT check_in, check_out, total_amount FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert str(row["check_in"]) == "2026-09-01"
        assert str(row["check_out"]) == "2026-09-08"
        assert float(row["total_amount"]) == 1050.0

    async def test_decline_leaves_booking_untouched(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        from app.database import Database
        user, hotel, _room, booking = await _make_confirmed_booking()
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request",
            json={
                "guestEmail": "changeguest@example.com",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-08",
                "addonIds": [],
                "addonQuantities": {},
                "addonDates": {},
            },
        )
        assert resp.status_code == 200

        with patch(
            "app.services.booking_change_service.send_guest_change_request_declined",
            new_callable=AsyncMock,
        ), patch(
            "app.services.booking_change_service.send_host_change_request_decision",
            new_callable=AsyncMock,
        ):
            decline_resp = await client.post(
                f"/admin/bookings/{booking['id']}/change-request/decline",
                json={"reason": "Fully booked that week"},
                headers=get_auth_headers(user["token"]),
            )
        assert decline_resp.status_code == 200, decline_resp.text
        cr = decline_resp.json()
        assert cr["status"] == "declined"
        assert cr["declineReason"] == "Fully booked that week"

        row = await Database.fetchrow(
            "SELECT check_in, check_out, total_amount FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert str(row["check_in"]) == "2026-09-01"
        assert str(row["check_out"]) == "2026-09-05"  # original
        assert float(row["total_amount"]) == 600.0

    async def test_preview_rejects_pending_only_for_non_confirmed(
        self, _ari, _push, _guest_email, _host_email, client, cleanup_database,
    ):
        # Pending booking — change requests are confirmed-only.
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            guest_email="pendingguest@example.com",
            status="pending",
        )
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/change-request/preview",
            json={
                "guestEmail": "pendingguest@example.com",
                "checkIn": "2026-06-01",
                "checkOut": "2026-06-08",
                "addonIds": [],
                "addonQuantities": {},
                "addonDates": {},
            },
        )
        assert resp.status_code == 400
        assert "confirmed" in resp.json()["detail"].lower()
