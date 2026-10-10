"""VAY-1362: guest booking routes act only on bookings of the hotel in the path slug.

The ALB answers 410 for a migrated hotel's /api/hotels/<slug>/bookings* paths.
A call through another hotel's slug, or through an encoded spelling of the path
that an ALB rule would not match, must answer 404 and must not refund, email,
or change any row.
"""

import json
import uuid
from contextlib import ExitStack
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import quote

import pytest
from app.database import Database

from tests.conftest import (
    create_test_booking_with_payment,
    create_test_cancellation_policy,
    create_test_hotel,
    create_test_room_type,
    create_test_user,
)

GUEST_EMAIL = "slug-scope@test.com"

EMAIL_SENDERS = [
    "send_booking_request_notification",
    "send_guest_booking_withdrawn",
    "send_host_booking_withdrawn",
    "send_guest_cancellation_refund",
    "send_host_guest_cancelled",
]


@pytest.fixture
def side_effects():
    """Mock Stripe, the guest/host emails and every fire-and-forget task."""
    stripe = {
        name: AsyncMock(return_value={"id": f"slug_{uuid.uuid4().hex[:8]}", "status": status})
        for name, status in [
            ("create_refund", "succeeded"),
            ("cancel_payment_intent", "canceled"),
            ("capture_payment_intent", "succeeded"),
            ("retrieve_payment_intent", "requires_capture"),
        ]
    }
    emails = {name: AsyncMock(return_value=True) for name in EMAIL_SENDERS}
    tasks = MagicMock(side_effect=lambda coro: coro.close())
    with ExitStack() as stack:
        for name, mock in stripe.items():
            stack.enter_context(patch(f"app.services.stripe_service.{name}", mock))
        for name, mock in emails.items():
            stack.enter_context(patch(f"app.services.booking_service.{name}", mock))
        stack.enter_context(patch("app.services.booking_service._create_task", tasks))
        yield {"stripe": stripe, "emails": emails, "tasks": tasks}


def assert_no_side_effects(mocks):
    for name, mock in {**mocks["stripe"], **mocks["emails"]}.items():
        assert not mock.called, f"{name} was called"
    assert not mocks["tasks"].called, "a background task was scheduled"


async def _hotels_with_card_booking(*, status, payment_status, payment_row_status):
    """A hotel with one card booking and payment row, plus a second hotel."""
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    other_hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]))
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    booking = await create_test_booking_with_payment(
        str(hotel["id"]),
        str(room["id"]),
        check_in=(date.today() + timedelta(days=30)).isoformat(),
        check_out=(date.today() + timedelta(days=34)).isoformat(),
        status=status,
        payment_method="card",
        payment_status=payment_status,
        guest_email=GUEST_EMAIL,
    )
    await Database.execute(
        """INSERT INTO payments (booking_id, amount, currency, payment_method,
                                 stripe_payment_intent_id, status)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        str(booking["id"]),
        600.0,
        "EUR",
        "card",
        f"pi_slug_{uuid.uuid4().hex[:8]}",
        payment_row_status,
    )
    return hotel, other_hotel, booking


async def _snapshot(booking_id) -> tuple:
    booking = await Database.fetchrow("SELECT * FROM bookings WHERE id = $1", booking_id)
    payments = await Database.fetch(
        "SELECT * FROM payments WHERE booking_id = $1 ORDER BY id", booking_id
    )
    return dict(booking), [dict(p) for p in payments]


async def _post(client, slug, booking_id, action):
    body = None if action == "confirm-authorization" else {"guest_email": GUEST_EMAIL}
    return await client.post(f"/api/hotels/{slug}/bookings/{booking_id}/{action}", json=body)


PENDING_UNPAID = {"status": "pending", "payment_status": "unpaid", "payment_row_status": "pending"}
PENDING_AUTHORIZED = {
    "status": "pending",
    "payment_status": "authorized",
    "payment_row_status": "authorized",
}
CONFIRMED_CAPTURED = {
    "status": "confirmed",
    "payment_status": "captured",
    "payment_row_status": "captured",
}


@pytest.mark.parametrize(
    ("action", "state", "stripe_call", "email"),
    [
        ("confirm-authorization", PENDING_UNPAID, None, "send_booking_request_notification"),
        ("withdraw", PENDING_AUTHORIZED, "cancel_payment_intent", "send_guest_booking_withdrawn"),
        ("cancel-preview", CONFIRMED_CAPTURED, None, None),
        ("cancel", CONFIRMED_CAPTURED, "create_refund", "send_guest_cancellation_refund"),
    ],
)
async def test_matching_slug_works_as_before(
    client, cleanup_database, side_effects, action, state, stripe_call, email
):
    hotel, _, booking = await _hotels_with_card_booking(**state)

    resp = await _post(client, hotel["slug"], booking["id"], action)

    assert resp.status_code == 200, resp.text
    if stripe_call:
        side_effects["stripe"][stripe_call].assert_called_once()
    if email:
        side_effects["emails"][email].assert_called_once()


@pytest.mark.parametrize(
    ("action", "state"),
    [
        ("confirm-authorization", PENDING_UNPAID),
        ("withdraw", PENDING_AUTHORIZED),
        ("cancel-preview", CONFIRMED_CAPTURED),
        ("cancel", CONFIRMED_CAPTURED),
    ],
)
async def test_other_hotel_slug_is_404_without_side_effects(
    client, cleanup_database, side_effects, action, state
):
    _, other_hotel, booking = await _hotels_with_card_booking(**state)
    before = await _snapshot(booking["id"])

    resp = await _post(client, other_hotel["slug"], booking["id"], action)

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Booking not found"
    assert await _snapshot(booking["id"]) == before
    assert_no_side_effects(side_effects)


@pytest.mark.parametrize(
    "action", ["confirm-authorization", "withdraw", "cancel-preview", "cancel"]
)
async def test_unknown_booking_is_404(client, cleanup_database, side_effects, action):
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))

    resp = await _post(client, hotel["slug"], uuid.uuid4(), action)

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Booking not found"
    assert_no_side_effects(side_effects)


async def test_confirm_authorization_draft_under_other_hotel_slug_is_404(
    client, cleanup_database, side_effects
):
    """The draft handle never reaches Stripe or materializes a booking."""
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    other_hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]))
    draft = await Database.fetchrow(
        """INSERT INTO booking_drafts (hotel_id, room_type_id, check_in, check_out,
                                       booking_reference, stripe_payment_intent_id,
                                       payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *""",
        str(hotel["id"]),
        str(room["id"]),
        date.today() + timedelta(days=30),
        date.today() + timedelta(days=33),
        f"VAY-D{uuid.uuid4().hex[:5].upper()}",
        f"pi_slug_draft_{uuid.uuid4().hex[:8]}",
        json.dumps({}),
        datetime.now(UTC) + timedelta(minutes=15),
    )

    resp = await _post(client, other_hotel["slug"], draft["id"], "confirm-authorization")

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Booking not found"
    after = await Database.fetchrow("SELECT * FROM booking_drafts WHERE id = $1", draft["id"])
    assert dict(after) == dict(draft)
    bookings = await Database.fetch("SELECT id FROM bookings WHERE hotel_id = $1", str(hotel["id"]))
    assert bookings == []
    assert_no_side_effects(side_effects)


GUEST_ROUTES = [
    ("confirm-authorization", PENDING_UNPAID),
    ("withdraw", PENDING_AUTHORIZED),
    ("cancel-preview", CONFIRMED_CAPTURED),
    ("cancel", CONFIRMED_CAPTURED),
]


@pytest.mark.parametrize(("action", "state"), GUEST_ROUTES)
async def test_encoded_slug_is_404_without_side_effects(
    client, cleanup_database, side_effects, action, state
):
    """``%70mstest-…`` decodes to the booking's own slug but would not match an ALB rule."""
    hotel, _, booking = await _hotels_with_card_booking(**state)
    before = await _snapshot(booking["id"])
    encoded_slug = f"%{ord(hotel['slug'][0]):02X}{hotel['slug'][1:]}"

    resp = await _post(client, encoded_slug, booking["id"], action)

    assert resp.status_code == 404, resp.text
    assert await _snapshot(booking["id"]) == before
    assert_no_side_effects(side_effects)


async def test_encoded_bookings_segment_is_404_without_side_effects(
    client, cleanup_database, side_effects
):
    hotel, _, booking = await _hotels_with_card_booking(**CONFIRMED_CAPTURED)
    before = await _snapshot(booking["id"])

    resp = await client.post(
        f"/api/hotels/{hotel['slug']}/%62ookings/{booking['id']}/cancel",
        json={"guest_email": GUEST_EMAIL},
    )

    assert resp.status_code == 404, resp.text
    assert await _snapshot(booking["id"]) == before
    assert_no_side_effects(side_effects)


async def test_canonical_path_check_covers_the_router_and_keeps_unicode_slugs(
    client, cleanup_database
):
    """A Unicode slug resolves in the canonical (browser) encoding only."""
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]), slug=f"pmstest-hôtel-{uuid.uuid4().hex[:6]}")
    canonical = quote(hotel["slug"], safe="")

    ok = await client.get(f"/api/hotels/{canonical}/payment-settings")
    lowercase_hex = await client.get(f"/api/hotels/{canonical.lower()}/payment-settings")

    assert ok.status_code == 200, ok.text
    assert lowercase_hex.status_code == 404, lowercase_hex.text
