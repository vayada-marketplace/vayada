"""Tests for the new booking-detail endpoints introduced in VAY-495:

- Internal notes (list/create/delete).
- Additional guests (list/create/update/delete + capacity cap).
- Reason-required cancel.
"""

from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_user,
    get_auth_headers,
)


class TestBookingNotes:
    async def test_create_and_list_notes(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        # Empty to start.
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json() == {"notes": []}

        # Create one.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "Guest is allergic to peanuts."},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 201, resp.text
        created = resp.json()
        assert created["body"] == "Guest is allergic to peanuts."
        assert created["bookingId"] == booking_id
        assert created["authorName"]  # captured from auth user

        # Listed back.
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        notes = resp.json()["notes"]
        assert len(notes) == 1
        assert notes[0]["id"] == created["id"]

    async def test_empty_body_rejected(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "   "},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_other_hotel_cannot_access(self, client, hotel_with_booking):
        booking_id = str(hotel_with_booking["booking"]["id"])

        other = await create_test_user(email="other@example.com")
        await create_test_hotel(str(other["id"]))
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(other["token"]),
        )
        assert resp.status_code == 404

    async def test_delete_note(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "Temp"},
            headers=get_auth_headers(token),
        )
        note_id = resp.json()["id"]

        resp = await client.delete(
            f"/admin/bookings/{booking_id}/notes/{note_id}",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 204

        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        assert resp.json()["notes"] == []


class TestAdditionalGuests:
    async def test_capacity_capped_at_adults_minus_booker(self, client, hotel_with_booking):
        """A 2-adult booking has 1 booker + 1 additional guest slot."""
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        await Database.execute(
            "UPDATE bookings SET adults = 2, children = 0 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        # First add succeeds.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Alex", "lastName": "Doe"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["position"] == 1

        # Second add hits the cap.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Beta"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_update_then_delete(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE bookings SET adults = 4 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Old"},
            headers=get_auth_headers(token),
        )
        guest_id = resp.json()["id"]

        resp = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={"firstName": "New", "passportNumber": "P12345"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["firstName"] == "New"
        assert resp.json()["passportNumber"] == "P12345"

        resp = await client.delete(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 204


class TestCancelWithReason:
    async def test_reason_required(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "   "},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_cancel_records_reason_as_note(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        # Mark confirmed so the cancel path runs normally.
        await Database.execute(
            "UPDATE bookings SET status = 'confirmed' WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "Guest no longer travelling"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cancelled"

        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        notes = resp.json()["notes"]
        assert any("Guest no longer travelling" in n["body"] for n in notes)

    async def test_double_cancel_rejected(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )
        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "again"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400
