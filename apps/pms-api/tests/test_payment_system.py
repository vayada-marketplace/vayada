"""
Tests for the payment system: Stripe integration, host approval flow,
payment settings, cancellation policies, and payouts.
"""
import pytest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch, AsyncMock, MagicMock
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_booking_with_payment,
    create_test_payment_settings,
    create_test_cancellation_policy,
    create_test_affiliate,
    get_auth_headers,
)
from app.database import Database


# ── Mock Stripe responses ────────────────────────────────────────


def mock_create_payment_intent(**kwargs):
    return {
        "id": "pi_test_123456",
        "client_secret": "pi_test_123456_secret_abc",
        "status": "requires_payment_method",
    }


def mock_capture_payment_intent(pi_id, **kwargs):
    return {"id": pi_id, "status": "succeeded"}


def mock_cancel_payment_intent(pi_id):
    return {"id": pi_id, "status": "canceled"}


def mock_create_refund(pi_id, amount=None):
    return {"id": "re_test_123", "status": "succeeded", "amount": amount or 10000}


STRIPE_MOCKS = {
    "app.services.stripe_service.create_payment_intent": AsyncMock(side_effect=mock_create_payment_intent),
    "app.services.stripe_service.capture_payment_intent": AsyncMock(side_effect=mock_capture_payment_intent),
    "app.services.stripe_service.cancel_payment_intent": AsyncMock(side_effect=mock_cancel_payment_intent),
    "app.services.stripe_service.create_refund": AsyncMock(side_effect=mock_create_refund),
}


def stripe_patches():
    """Return a list of patch context managers for all Stripe calls."""
    return [patch(k, v) for k, v in STRIPE_MOCKS.items()]


# ── Booking Request (Public) ─────────────────────────────────────


class TestCreateBookingRequest:
    """Tests for POST /api/hotels/{slug}/bookings (new payment flow)."""

    async def test_create_booking_card_payment(self, client, hotel_with_rooms):
        """Card booking creates a payment intent and returns client_secret."""
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_card",
            stripe_connect_onboarded=True,
        )

        with patch("app.services.stripe_service.create_payment_intent", new_callable=AsyncMock) as mock_pi:
            mock_pi.return_value = {
                "id": "pi_test_card",
                "client_secret": "pi_test_card_secret_xyz",
                "status": "requires_payment_method",
            }

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Alice",
                    "guestLastName": "Tester",
                    "guestEmail": "alice@test.com",
                    "guestPhone": "+1234567890",
                    "checkIn": "2026-09-01",
                    "checkOut": "2026-09-04",
                    "adults": 2,
                    "children": 0,
                    "paymentMethod": "card",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentMethod"] == "card"
        assert body["clientSecret"] == "pi_test_card_secret_xyz"
        assert body["booking"]["status"] == "pending"
        assert body["booking"]["guestFirstName"] == "Alice"
        assert body["booking"]["totalAmount"] == 450.0  # 150 * 3 nights
        mock_pi.assert_called_once()

    async def test_create_booking_pay_at_property(self, client, cleanup_database):
        """Pay-at-property booking requires the setting to be enabled."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Bob",
                "guestLastName": "Property",
                "guestEmail": "bob@test.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentMethod"] == "pay_at_property"
        assert body["clientSecret"] is None
        assert body["booking"]["status"] == "pending"

    async def test_booking_rejected_when_method_not_allowed_for_rate(self, client, cleanup_database):
        """Rate-level rate_payment_methods list must gate booking creation."""
        import json as _json
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        # Flexible rate allows only card + bank_transfer — NOT pay_at_property
        await Database.execute(
            "UPDATE room_types SET rate_payment_methods = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": ["card", "bank_transfer"]}),
            str(room["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Alice",
                "guestLastName": "Tester",
                "guestEmail": "alice@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-04",
                "adults": 2,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
            },
        )
        assert resp.status_code == 400
        assert "not allowed" in resp.json()["detail"].lower()

    async def test_booking_allowed_when_method_in_rate_list(self, client, cleanup_database):
        """An allowed method for the selected rate should go through."""
        import json as _json
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            "UPDATE room_types SET rate_payment_methods = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": ["card", "pay_at_property"]}),
            str(room["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Bob",
                "guestLastName": "Tester",
                "guestEmail": "bob@test.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["paymentMethod"] == "pay_at_property"

    async def test_booking_null_rate_methods_uses_hotel_defaults(self, client, cleanup_database):
        """When rate_payment_methods is NULL, hotel-level flags govern — legacy behavior."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        # No rate_payment_methods set — should fall through to hotel defaults.

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Cat",
                "guestLastName": "Tester",
                "guestEmail": "cat@test.com",
                "guestPhone": "+111",
                "checkIn": "2026-09-20",
                "checkOut": "2026-09-22",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200

    async def test_card_booking_rejected_when_stripe_not_onboarded(self, client, cleanup_database):
        """Card booking must fail loudly (not silently fall back to pay-at-property)
        when the hotel hasn't finished Stripe Connect onboarding.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        # Pay-at-property enabled AND online card toggled on, but Connect
        # onboarding never finished — the old code would silently switch to
        # pay-at-property, which is exactly Bug 1.
        await create_test_payment_settings(
            str(hotel["id"]),
            pay_at_property_enabled=True,
            stripe_connect_account_id=None,
            stripe_connect_onboarded=False,
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Alice",
                "guestLastName": "Tester",
                "guestEmail": "alice@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-04",
                "adults": 2,
                "paymentMethod": "card",
            },
        )
        assert resp.status_code == 400

    async def test_pay_at_property_rejected_when_disabled(self, client, hotel_with_rooms):
        """Pay-at-property fails if not enabled for the hotel."""
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Fail",
                "guestLastName": "Test",
                "guestEmail": "fail@test.com",
                "guestPhone": "+111",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 400


# ── Confirm Authorization ────────────────────────────────────────


class TestConfirmAuthorization:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/confirm-authorization."""

    async def test_confirm_authorization(self, client, cleanup_database):
        """Confirming authorization updates payment status."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="card", payment_status="unpaid",
        )

        # Insert a payment record
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_auth", "pending",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/confirm-authorization"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "authorized"

    async def test_confirm_authorization_non_pending(self, client, cleanup_database):
        """Cannot confirm authorization on non-pending booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            status="confirmed", payment_status="captured",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/confirm-authorization"
        )
        assert resp.status_code == 400


# ── Host Accept/Reject (Admin) ──────────────────────────────────


class TestHostAcceptReject:
    """Tests for POST /admin/bookings/{id}/accept and /reject."""

    async def test_host_accept_captures_payment(self, client, cleanup_database):
        """Accepting a booking captures the Stripe payment."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="card", payment_status="authorized",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_capture", "authorized",
        )

        with patch("app.services.stripe_service.capture_payment_intent", new_callable=AsyncMock) as mock_capture:
            mock_capture.return_value = {"id": "pi_test_capture", "status": "succeeded"}

            resp = await client.post(
                f"/admin/bookings/{booking['id']}/accept",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "confirmed"
        assert body["paymentStatus"] == "captured"
        assert body["platformFeeAmount"] is not None
        assert body["propertyPayoutAmount"] is not None
        mock_capture.assert_called_once_with("pi_test_capture")

    async def test_host_accept_pay_at_property(self, client, cleanup_database):
        """Accepting a pay-at-property booking just confirms it."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="pay_at_property", payment_status="pay_at_property",
        )

        resp = await client.post(
            f"/admin/bookings/{booking['id']}/accept",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "confirmed"

    async def test_host_reject_releases_hold(self, client, cleanup_database):
        """Rejecting a booking cancels the Stripe payment intent."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="card", payment_status="authorized",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_reject", "authorized",
        )

        with patch("app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_reject", "status": "canceled"}

            resp = await client.post(
                f"/admin/bookings/{booking['id']}/reject",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "cancelled"
        mock_cancel.assert_called_once_with("pi_test_reject")

    async def test_accept_non_pending_fails(self, client, cleanup_database):
        """Cannot accept a booking that's already confirmed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            status="confirmed", payment_status="captured",
        )

        resp = await client.post(
            f"/admin/bookings/{booking['id']}/accept",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_reject_requires_auth(self, client, cleanup_database):
        """Reject endpoint requires authentication."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
        )

        resp = await client.post(f"/admin/bookings/{booking['id']}/reject")
        assert resp.status_code == 401


# ── Guest Withdraw ───────────────────────────────────────────────


class TestGuestWithdraw:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/withdraw."""

    async def test_guest_withdraw(self, client, cleanup_database):
        """Guest can withdraw a pending booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="card", payment_status="authorized",
            guest_email="withdraw@test.com",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_withdraw", "authorized",
        )

        with patch("app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_withdraw", "status": "canceled"}

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
                json={"guest_email": "withdraw@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "withdrawn"
        mock_cancel.assert_called_once()

    async def test_withdraw_wrong_email(self, client, cleanup_database):
        """Cannot withdraw with wrong email."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            guest_email="correct@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
            json={"guest_email": "wrong@test.com"},
        )
        assert resp.status_code == 400

    async def test_withdraw_confirmed_booking_fails(self, client, cleanup_database):
        """Cannot withdraw a confirmed booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            status="confirmed", payment_status="captured",
            guest_email="guest@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
            json={"guest_email": "guest@test.com"},
        )
        assert resp.status_code == 400


# ── Guest Cancellation ───────────────────────────────────────────


class TestGuestCancellation:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/cancel."""

    async def test_cancel_confirmed_booking_full_refund(self, client, cleanup_database):
        """Cancel far in advance triggers full refund."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)

        # Check-in far away (30 days) → full refund
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            check_in="2026-09-01", check_out="2026-09-05",
            status="confirmed", payment_method="card", payment_status="captured",
            guest_email="cancel@test.com",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_refund", "captured",
        )

        with patch("app.services.stripe_service.create_refund", new_callable=AsyncMock) as mock_refund:
            mock_refund.return_value = {"id": "re_test", "status": "succeeded", "amount": 60000}

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
                json={"guest_email": "cancel@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        mock_refund.assert_called_once()

    async def test_cancel_pending_fails(self, client, cleanup_database):
        """Cannot cancel a pending booking (use withdraw instead)."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            guest_email="cancel@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
            json={"guest_email": "cancel@test.com"},
        )
        assert resp.status_code == 400

    async def test_cancel_preview_partial_refund_within_window(
        self, client, cleanup_database
    ):
        """Room with partial-refund cancellation type returns the configured
        percentage when guest cancels at least N days before check-in."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await Database.execute(
            "UPDATE room_types SET flexible_cancellation_type = 'partial_refund', "
            "partial_refund_cancel_window_days = 30, partial_refund_amount_percent = 50 "
            "WHERE id = $1",
            str(room["id"]),
        )

        check_in = (date.today() + timedelta(days=35)).isoformat()
        check_out = (date.today() + timedelta(days=39)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            check_in=check_in, check_out=check_out,
            status="confirmed", payment_method="card", payment_status="captured",
            guest_email="partial@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "partial@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 50
        assert body["refundAmount"] == 300.0  # 50% of 4 nights × €150

    async def test_cancel_preview_partial_refund_after_window(
        self, client, cleanup_database
    ):
        """Cancellation after the window returns 0 refund regardless of
        the hotel-wide free_cancellation_days policy."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(
            str(hotel["id"]), free_cancellation_days=7
        )
        await Database.execute(
            "UPDATE room_types SET flexible_cancellation_type = 'partial_refund', "
            "partial_refund_cancel_window_days = 30, partial_refund_amount_percent = 50 "
            "WHERE id = $1",
            str(room["id"]),
        )

        check_in = (date.today() + timedelta(days=20)).isoformat()
        check_out = (date.today() + timedelta(days=24)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            check_in=check_in, check_out=check_out,
            status="confirmed", payment_method="card", payment_status="captured",
            guest_email="partial@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "partial@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 0
        assert body["refundAmount"] == 0

    async def test_cancel_preview_free_cancellation_unchanged(
        self, client, cleanup_database
    ):
        """Default free-cancellation rooms still use the hotel-wide policy."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(
            str(hotel["id"]), free_cancellation_days=7
        )

        check_in = (date.today() + timedelta(days=14)).isoformat()
        check_out = (date.today() + timedelta(days=18)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            check_in=check_in, check_out=check_out,
            status="confirmed", payment_method="card", payment_status="captured",
            guest_email="free@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "free@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 100
        assert body["refundAmount"] == 600.0


# ── Booking Status Polling ───────────────────────────────────────


class TestBookingStatus:
    """Tests for GET /api/hotels/{slug}/bookings/status."""

    async def test_get_booking_status(self, client, cleanup_database):
        """Polling endpoint returns current status."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            guest_email="poll@test.com",
            payment_method="card", payment_status="authorized",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/bookings/status",
            params={
                "reference": booking["booking_reference"],
                "email": "poll@test.com",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "pending"
        assert body["paymentStatus"] == "authorized"
        assert body["hostResponseDeadline"] is not None

    async def test_status_not_found(self, client, hotel_with_rooms):
        """Status endpoint returns 404 for unknown booking."""
        hotel = hotel_with_rooms["hotel"]

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/bookings/status",
            params={"reference": "VAY-NONEXIST", "email": "nobody@test.com"},
        )
        assert resp.status_code == 404


# ── Payment Settings (Public) ────────────────────────────────────


class TestPaymentSettingsPublic:
    """Tests for GET /api/hotels/{slug}/payment-settings."""

    async def test_payment_settings_defaults(self, client, hotel_with_rooms):
        """Returns defaults when no settings configured."""
        hotel = hotel_with_rooms["hotel"]

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/payment-settings"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["payAtPropertyEnabled"] is False
        assert body["freeCancellationDays"] == 7

    async def test_payment_settings_with_config(self, client, cleanup_database):
        """Returns configured values."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=14)

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/payment-settings"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["payAtPropertyEnabled"] is True
        assert body["freeCancellationDays"] == 14

    async def test_payment_settings_unknown_hotel(self, client, init_database):
        resp = await client.get("/api/hotels/nonexistent-slug/payment-settings")
        assert resp.status_code == 404

    async def test_online_card_gated_when_stripe_not_onboarded(self, client, cleanup_database):
        """onlineCardPayment must be false if the hotel turned the flag on
        but never finished Stripe Connect onboarding — otherwise the guest
        sees a card form that can't actually charge.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'stripe', NULL, FALSE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is False

    async def test_online_card_exposed_when_stripe_onboarded(self, client, cleanup_database):
        """onlineCardPayment is true when Stripe Connect onboarding finished."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'stripe', 'acct_test_onboarded', TRUE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is True

    async def test_online_card_exposed_for_vayada_provider(self, client, cleanup_database):
        """vayada provider charges on the platform account — no Connect check needed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'vayada', NULL, FALSE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is True


# ── Payment Settings (Admin) ─────────────────────────────────────


class TestPaymentSettingsAdmin:
    """Tests for GET/PATCH /admin/payment-settings."""

    async def test_get_payment_settings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]))

        resp = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        ps = body["paymentSettings"]
        assert ps["platformFeeType"] == "percentage"
        assert ps["platformFeeValue"] == 8.0
        cp = body["cancellationPolicy"]
        assert cp["freeCancellationDays"] == 7

    async def test_update_payment_settings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
            json={
                "platformFeeType": "flat",
                "platformFeeValue": 25.0,
                "payAtPropertyEnabled": True,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "updated"

        # Verify via GET
        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        ps = resp2.json()["paymentSettings"]
        assert ps["platformFeeType"] == "flat"
        assert ps["platformFeeValue"] == 25.0
        assert ps["payAtPropertyEnabled"] is True

    async def test_payment_settings_requires_auth(self, client):
        resp = await client.get("/admin/payment-settings")
        assert resp.status_code == 401


# ── Cancellation Policy (Admin) ──────────────────────────────────


class TestCancellationPolicyAdmin:
    """Tests for PATCH /admin/cancellation-policy."""

    async def test_update_cancellation_policy(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/cancellation-policy",
            headers=get_auth_headers(user["token"]),
            json={
                "freeCancellationDays": 14,
                "partialRefundPct": 50.0,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "updated"

        # Verify via GET
        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        cp = resp2.json()["cancellationPolicy"]
        assert cp["freeCancellationDays"] == 14
        assert cp["partialRefundPct"] == 50.0


# ── Payouts (Admin) ──────────────────────────────────────────────


class TestPayoutsAdmin:
    """Tests for GET /admin/payouts."""

    async def test_list_payouts_empty(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/payouts",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["payouts"] == []
        assert body["total"] == 0

    async def test_payouts_requires_auth(self, client):
        resp = await client.get("/admin/payouts")
        assert resp.status_code == 401


# ── Payout Service Unit Tests ────────────────────────────────────


class TestPayoutService:
    """Unit tests covering the plan × channel × affiliate fee matrix."""

    def _call(self, **overrides):
        from app.services.payout_service import calculate_split

        defaults = dict(
            total_amount=1000.0,
            plan="commission",
            channel="direct",
            booking_engine_fee_pct=2.0,
            channel_manager_fee_pct=3.0,
            affiliate_platform_fee_pct=2.0,
            has_affiliate=False,
            effective_affiliate_commission_pct=0.0,
        )
        defaults.update(overrides)
        return calculate_split(defaults.pop("total_amount"), **defaults)

    async def test_fixed_plan_direct_no_affiliate(self, init_database):
        result = self._call(plan="fixed")
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_fixed_plan_ota_no_affiliate(self, init_database):
        result = self._call(plan="fixed", channel="booking_com")
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_fixed_plan_direct_with_affiliate(self, init_database):
        result = self._call(
            plan="fixed",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 2% affiliate platform fee + 5% affiliate commission
        assert result == {
            "platform_fee": 20.0,
            "affiliate_commission": 50.0,
            "property_payout": 930.0,
        }

    async def test_commission_plan_direct_no_affiliate(self, init_database):
        result = self._call(plan="commission")
        assert result == {
            "platform_fee": 20.0,   # 2% BE fee
            "affiliate_commission": 0.0,
            "property_payout": 980.0,
        }

    async def test_commission_plan_ota_no_affiliate(self, init_database):
        result = self._call(plan="commission", channel="airbnb")
        assert result == {
            "platform_fee": 30.0,   # 3% channel-manager fee
            "affiliate_commission": 0.0,
            "property_payout": 970.0,
        }

    async def test_commission_plan_direct_with_affiliate(self, init_database):
        result = self._call(
            plan="commission",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 2% BE fee (affiliate fee doesn't stack on commission plan) + 5% commission
        assert result == {
            "platform_fee": 20.0,
            "affiliate_commission": 50.0,
            "property_payout": 930.0,
        }

    async def test_commission_plan_ota_with_affiliate(self, init_database):
        result = self._call(
            plan="commission",
            channel="booking_com",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 3% channel fee (affiliate fee doesn't stack on commission plan) + 5% commission
        assert result == {
            "platform_fee": 30.0,
            "affiliate_commission": 50.0,
            "property_payout": 920.0,
        }

    async def test_affiliate_commission_additive_not_capped(self, init_database):
        """High affiliate commission (10%) is paid in full, on top of the platform fee."""
        result = self._call(
            plan="commission",
            has_affiliate=True,
            effective_affiliate_commission_pct=10.0,
        )
        assert result == {
            "platform_fee": 20.0,     # 2% BE only; affiliate fee doesn't stack
            "affiliate_commission": 100.0,  # 10% of 1000, not clamped
            "property_payout": 880.0,
        }

    async def test_commission_plan_custom_direct_rate(self, init_database):
        """Property-configured 8% direct rate is honoured (regression for VAY-318)."""
        result = self._call(plan="commission", booking_engine_fee_pct=8.0)
        assert result == {
            "platform_fee": 80.0,
            "affiliate_commission": 0.0,
            "property_payout": 920.0,
        }

    async def test_commission_plan_zero_ota_rate(self, init_database):
        """Property-configured 0% OTA rate means no platform fee on channel bookings."""
        result = self._call(
            plan="commission",
            channel="booking_com",
            channel_manager_fee_pct=0.0,
        )
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_empty_channel_falls_back_to_direct(self, init_database):
        """An empty channel falls back to the direct rate (VAY-318 spec)."""
        result = self._call(
            plan="commission",
            channel="",
            booking_engine_fee_pct=8.0,
            channel_manager_fee_pct=15.0,
        )
        # Should use the (lower) direct rate, not the OTA rate.
        assert result["platform_fee"] == 80.0


class TestFetchBillingConfig:
    """Tests for the cross-DB billing-config lookup that backs platform-fee calc.

    Regression for VAY-318: when the booking_hotels row is missing or the
    cross-DB lookup fails, we must NOT silently fall back to a non-zero
    percentage — that historically charged Fixed-plan hotels 2% on top of
    their monthly subscription and under-billed Commission-plan hotels with
    custom rates.
    """

    async def test_default_is_zero_fee(self, init_database):
        """The fallback config charges nothing — safe default for missing rows."""
        from app.services.payout_service import DEFAULT_BILLING_CONFIG

        assert DEFAULT_BILLING_CONFIG["booking_engine_fee_pct"] == 0.0
        assert DEFAULT_BILLING_CONFIG["channel_manager_fee_pct"] == 0.0
        assert DEFAULT_BILLING_CONFIG["affiliate_platform_fee_pct"] == 0.0

    async def test_no_booking_db_url_returns_defaults(self, init_database):
        """Test/dev path: no booking_db configured → defaults."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG, fetch_billing_config,
        )

        with patch("app.services.payout_service.app_settings") as mock_settings:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = ""
            result = await fetch_billing_config("any-hotel-id")

        assert result == DEFAULT_BILLING_CONFIG
        # Must be a copy — callers mutate the dict freely.
        assert result is not DEFAULT_BILLING_CONFIG

    async def test_missing_row_logs_error_and_returns_defaults(self, init_database):
        """A missing booking_hotels row is logged at error level (data-integrity issue)."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG, fetch_billing_config,
        )

        with patch("app.services.payout_service.app_settings") as mock_settings, \
             patch("app.services.payout_service.BookingEngineDatabase.fetchrow",
                   new=AsyncMock(return_value=None)), \
             patch("app.services.payout_service.logger") as mock_logger:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("missing-hotel-id")

        assert result == DEFAULT_BILLING_CONFIG
        mock_logger.error.assert_called_once()
        assert "missing-hotel-id" in str(mock_logger.error.call_args)

    async def test_query_exception_logs_error_and_returns_defaults(self, init_database):
        """A cross-DB exception is logged at error level and falls back safely."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG, fetch_billing_config,
        )

        with patch("app.services.payout_service.app_settings") as mock_settings, \
             patch("app.services.payout_service.BookingEngineDatabase.fetchrow",
                   new=AsyncMock(side_effect=RuntimeError("connection refused"))), \
             patch("app.services.payout_service.logger") as mock_logger:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("hotel-with-broken-conn")

        assert result == DEFAULT_BILLING_CONFIG
        mock_logger.error.assert_called_once()

    async def test_row_present_returns_configured_values(self, init_database):
        """A real row returns the per-hotel configured percentages and active plan."""
        from app.services.payout_service import fetch_billing_config

        row = {
            "billing_active_plan": "commission",
            "booking_engine_fee_pct": 8.00,
            "channel_manager_fee_pct": 0.00,
            "affiliate_platform_fee_pct": 2.00,
        }
        with patch("app.services.payout_service.app_settings") as mock_settings, \
             patch("app.services.payout_service.BookingEngineDatabase.fetchrow",
                   new=AsyncMock(return_value=row)):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("hotel-id")

        assert result == {
            "active_plan": "commission",
            "booking_engine_fee_pct": 8.0,
            "channel_manager_fee_pct": 0.0,
            "affiliate_platform_fee_pct": 2.0,
        }


# ── Expire Booking (Scheduler) ──────────────────────────────────


class TestExpireBooking:
    """Tests for the booking expiry service function."""

    async def test_expire_pending_booking(self, cleanup_database):
        """Expired booking gets status=expired and hold released."""
        from app.services.booking_service import expire_booking

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Booking with deadline in the past
        expired_deadline = datetime.now(timezone.utc) - timedelta(hours=1)
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            payment_method="card", payment_status="authorized",
            host_response_deadline=expired_deadline,
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]), 600.0, "EUR", "card", "pi_test_expire", "authorized",
        )

        with patch("app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_expire", "status": "canceled"}
            await expire_booking(str(booking["id"]))

        # Verify booking is expired
        updated = await Database.fetchrow(
            "SELECT status, payment_status FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert updated["status"] == "expired"
        assert updated["payment_status"] == "cancelled"
        mock_cancel.assert_called_once_with("pi_test_expire")

    async def test_expire_already_confirmed_noop(self, cleanup_database):
        """Expiring a confirmed booking is a no-op."""
        from app.services.booking_service import expire_booking

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]), str(room["id"]),
            status="confirmed", payment_status="captured",
        )

        await expire_booking(str(booking["id"]))

        updated = await Database.fetchrow(
            "SELECT status FROM bookings WHERE id = $1", booking["id"]
        )
        assert updated["status"] == "confirmed"  # unchanged
