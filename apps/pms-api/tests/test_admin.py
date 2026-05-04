"""
Tests for /admin endpoints — hotel registration, setup status, room CRUD, booking management.
"""
import pytest
from unittest.mock import AsyncMock, patch
from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    get_auth_headers,
    generate_test_slug,
)


# ── Hotel Registration ────────────────────────────────────────────


class TestRegisterHotel:
    async def test_register_hotel(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "My Hotel", "slug": slug, "contactEmail": "info@hotel.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "My Hotel"
        assert body["slug"] == slug
        assert body["contactEmail"] == "info@hotel.com"
        assert body["userId"] == str(user["id"])

    async def test_register_hotel_idempotent(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        payload = {"name": "Hotel One", "slug": slug, "contactEmail": "a@b.com"}
        headers = get_auth_headers(user["token"])

        resp1 = await client.post("/admin/register-hotel", json=payload, headers=headers)
        assert resp1.status_code == 201
        hotel_id = resp1.json()["id"]

        # Second call updates slug/name to keep in sync with booking engine
        resp2 = await client.post(
            "/admin/register-hotel",
            json={"name": "Updated Name", "slug": "updated-slug", "contactEmail": "updated@b.com"},
            headers=headers,
        )
        assert resp2.status_code == 201
        assert resp2.json()["id"] == hotel_id
        assert resp2.json()["name"] == "Updated Name"
        assert resp2.json()["slug"] == "updated-slug"

    async def test_register_hotel_requires_auth(self, client):
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
        )
        assert resp.status_code == 401

    async def test_register_hotel_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="creator")
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403


# ── Setup Status ──────────────────────────────────────────────────


class TestSetupStatus:
    async def test_setup_status_no_hotel(self, client, cleanup_database):
        """Setup-status auto-registers a hotel from auth profile."""
        user = await create_test_user()
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # Auto-register creates hotel from auth profile, so registered is True
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_registered_no_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_complete(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is True
        assert body["roomCount"] == 1


# ── Admin Room Types ──────────────────────────────────────────────


class TestAdminRoomTypes:
    async def test_list_room_types_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_create_room_type(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Standard Room",
                "description": "A nice room",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 10,
                "bedType": "Queen",
                "amenities": ["WiFi", "TV"],
                "features": ["City View"],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Standard Room"
        assert body["baseRate"] == 100.0
        assert body["totalRooms"] == 10
        assert body["bedType"] == "Queen"
        assert body["amenities"] == ["WiFi", "TV"]
        assert body["isActive"] is True

    async def test_create_room_type_auto_creates_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        room_type_id = resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert len(rooms) == 3
        assert {r["roomNumber"] for r in rooms} == {
            "Garden King 1",
            "Garden King 2",
            "Garden King 3",
        }

    async def test_duplicate_room_type_auto_creates_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        original_id = create_resp.json()["id"]

        dup_resp = await client.post(
            f"/admin/room-types/{original_id}/duplicate",
            headers=get_auth_headers(user["token"]),
        )
        assert dup_resp.status_code == 201
        clone_id = dup_resp.json()["id"]
        assert dup_resp.json()["name"] == "Garden King (Copy)"

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        clone_rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == clone_id]
        assert len(clone_rooms) == 2
        assert {r["roomNumber"] for r in clone_rooms} == {
            "Garden King (Copy) 1",
            "Garden King (Copy) 2",
        }

    async def test_rename_room_type_renames_auto_named_rooms(self, client, cleanup_database):
        """VAY-322: when a room type is renamed, the auto-generated room
        numbers ("Garden King 1", "Garden King 2", ...) must adopt the new
        name so the calendar stops showing the stale prefix."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Garden Queen"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200
        assert rename_resp.json()["name"] == "Garden Queen"

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert len(rooms) == 3
        assert {r["roomNumber"] for r in rooms} == {
            "Garden Queen 1",
            "Garden Queen 2",
            "Garden Queen 3",
        }

    async def test_rename_room_type_preserves_manually_named_rooms(self, client, cleanup_database):
        """VAY-322: rooms whose numbers don't follow the auto pattern (e.g.
        the user renamed one to "101") must NOT be rewritten on rename."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        room_to_rename = next(
            r for r in rooms_resp.json()
            if r["roomTypeId"] == room_type_id and r["roomNumber"] == "Garden King 1"
        )
        manual_rename = await client.patch(
            f"/admin/rooms/{room_to_rename['id']}",
            json={"roomNumber": "Penthouse"},
            headers=get_auth_headers(user["token"]),
        )
        assert manual_rename.status_code == 200

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Garden Queen"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Penthouse", "Garden Queen 2"}

    async def test_update_room_type_without_name_change_keeps_room_numbers(self, client, cleanup_database):
        """A PATCH that doesn't include a name change must not touch the
        room_number column."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        room_type_id = create_resp.json()["id"]

        rate_only = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"baseRate": 200.0},
            headers=get_auth_headers(user["token"]),
        )
        assert rate_only.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Garden King 1", "Garden King 2"}

    async def test_get_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Deluxe Suite"

    async def test_get_room_type_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_resolved_rate_uses_season_when_base_rate_zero(
        self, client, cleanup_database
    ):
        """When base_rate=0 and a season covers the check-in date, the
        resolved-rate endpoint must return the season rate — same logic the
        booking engine uses — so the calendar's New Booking modal pre-fills
        the actual price the guest would pay."""
        import json
        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), base_rate=0.0)
        seasons = [
            {
                "name": "High Season",
                "start_date": "2026-06-01",
                "end_date": "2026-08-31",
                "rate": 250.0,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            json.dumps(seasons),
            room["id"],
        )

        resp = await client.get(
            f"/admin/room-types/{room['id']}/resolved-rate?check_in=2026-07-15",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["nightlyRate"] == 250.0
        assert body["currency"] == "EUR"

    async def test_resolved_rate_invalid_check_in(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.get(
            f"/admin/room-types/{room['id']}/resolved-rate?check_in=not-a-date",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_resolved_rate_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types/00000000-0000-0000-0000-000000000000/resolved-rate?check_in=2026-07-15",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_update_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"name": "Updated Suite", "baseRate": 200.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "Updated Suite"
        assert body["baseRate"] == 200.0

    async def test_delete_room_type(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Verify gone
        resp2 = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 404

    async def test_delete_room_type_with_bookings_fails(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        room = hotel_with_booking["room"]

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 409

    async def test_list_room_types(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["name"] == "Deluxe Suite"

    async def test_create_room_type_with_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "NR Room",
                "description": "Room with non-refundable rate",
                "baseRate": 200.0,
                "nonRefundableRate": 170.0,
                "maxOccupancy": 2,
                "totalRooms": 5,
                "bedType": "King",
                "amenities": ["WiFi"],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] == 170.0

    async def test_create_room_type_without_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Flex Only Room",
                "description": "Room without non-refundable rate",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
                "bedType": "Queen",
                "amenities": [],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] is None

    async def test_update_non_refundable_rate(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": 120.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["nonRefundableRate"] == 120.0

    async def test_clear_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), non_refundable_rate=130.0)

        # Verify it was set
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json()["nonRefundableRate"] == 130.0

        # Clear it by setting to null
        resp2 = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": None},
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 200
        assert resp2.json()["nonRefundableRate"] is None

    async def test_cannot_access_other_hotels_room(self, client, hotel_with_rooms):
        """A second hotel user cannot access the first hotel's rooms."""
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        room = hotel_with_rooms["room"]
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(other_user["token"]),
        )
        assert resp.status_code == 404

    async def test_create_room_defaults_flexible_cancellation_type_to_free(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Default Room",
                "description": "",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
                "bedType": "Queen",
                "amenities": [],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["flexibleCancellationType"] == "free"
        assert body["partialRefundCancelWindowDays"] == 30
        assert body["partialRefundAmountPercent"] == 50

    async def test_update_to_partial_refund_cancellation_type(
        self, client, hotel_with_rooms
    ):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={
                "flexibleCancellationType": "partial_refund",
                "partialRefundCancelWindowDays": 14,
                "partialRefundAmountPercent": 75,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["flexibleCancellationType"] == "partial_refund"
        assert body["partialRefundCancelWindowDays"] == 14
        assert body["partialRefundAmountPercent"] == 75

    async def test_invalid_flexible_cancellation_type_rejected(
        self, client, hotel_with_rooms
    ):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"flexibleCancellationType": "bogus"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_invalid_partial_refund_percent_rejected(
        self, client, hotel_with_rooms
    ):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"partialRefundAmountPercent": 150},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_patch_triggers_channex_cancellation_push(
        self, client, hotel_with_rooms
    ):
        """Changing flexible-cancellation fields fires the Channex sync."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.push_cancellation_policy_for_room_type",
            new_callable=AsyncMock,
        ) as push:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"flexibleCancellationType": "partial_refund"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            # asyncio.create_task schedules but may not complete before
            # the request returns; await any pending task explicitly.
            import asyncio
            await asyncio.sleep(0)
            push.assert_awaited_once()
            assert push.await_args.args[1] == str(room["id"])

    async def test_patch_unrelated_field_does_not_trigger_channex_push(
        self, client, hotel_with_rooms
    ):
        """A PATCH that doesn't touch cancellation fields skips the sync."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.push_cancellation_policy_for_room_type",
            new_callable=AsyncMock,
        ) as push:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"name": "Renamed"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio
            await asyncio.sleep(0)
            push.assert_not_awaited()

    async def test_patch_meal_plans_triggers_channex_reprovision(
        self, client, hotel_with_rooms
    ):
        """Adding a meal plan re-provisions Channex (so breakfast variants
        like 'BDC Standard (Breakfast)' get created) and pushes ARI."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with (
            patch(
                "app.routers.admin_room_types.provision_property",
                new_callable=AsyncMock,
            ) as provision,
            patch(
                "app.routers.admin_room_types.push_ari_for_hotel",
                new_callable=AsyncMock,
            ) as ari,
        ):
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"mealPlans": [{"code": 1, "surcharge": 100000, "chargePer": "person"}]},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio
            await asyncio.sleep(0)
            provision.assert_awaited_once()
            ari.assert_awaited_once()
            assert provision.await_args.args[0] == str(room["hotel_id"])

    async def test_patch_meal_plans_swallows_no_connection_error(
        self, client, hotel_with_rooms
    ):
        """ValueError from provision_property (no Channex connection) is
        swallowed silently — meal plans on hotels without a CM still save."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with (
            patch(
                "app.routers.admin_room_types.provision_property",
                new_callable=AsyncMock,
                side_effect=ValueError("No active Channex connection"),
            ),
            patch(
                "app.routers.admin_room_types.push_ari_for_hotel",
                new_callable=AsyncMock,
            ) as ari,
        ):
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"mealPlans": [{"code": 1, "surcharge": 100000}]},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio
            await asyncio.sleep(0)
            ari.assert_not_awaited()

    async def test_patch_unrelated_field_does_not_trigger_meal_plan_resync(
        self, client, hotel_with_rooms
    ):
        """PATCH without mealPlans should NOT re-provision."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.provision_property",
            new_callable=AsyncMock,
        ) as provision:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"name": "Renamed"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio
            await asyncio.sleep(0)
            provision.assert_not_awaited()


# ── Admin Bookings ────────────────────────────────────────────────


class TestAdminBookings:
    async def test_list_bookings_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["bookings"] == []
        assert body["total"] == 0

    async def test_list_bookings(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert len(body["bookings"]) == 1
        assert body["bookings"][0]["guestEmail"] == "guest@example.com"

    async def test_list_bookings_filter_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings?status=pending",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

        resp2 = await client.get(
            "/admin/bookings?status=confirmed",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.json()["total"] == 0

    async def test_get_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.get(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["guestFirstName"] == "John"
        assert body["guestLastName"] == "Doe"
        assert body["status"] == "pending"

    async def test_get_booking_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_confirm_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "confirmed"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "confirmed"

    async def test_cancel_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "cancelled"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    async def test_invalid_booking_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "invalid_status"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_list_bookings_pagination(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Create 3 bookings
        for i in range(3):
            await create_test_booking(
                str(hotel["id"]),
                str(room["id"]),
                check_in=f"2026-0{i+7}-01",
                check_out=f"2026-0{i+7}-05",
                guest_email=f"guest{i}@example.com",
            )

        resp = await client.get(
            "/admin/bookings?limit=2&offset=0",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["total"] == 3
        assert len(body["bookings"]) == 2
        assert body["limit"] == 2
        assert body["offset"] == 0

        resp2 = await client.get(
            "/admin/bookings?limit=2&offset=2",
            headers=get_auth_headers(user["token"]),
        )
        body2 = resp2.json()
        assert len(body2["bookings"]) == 1


# ── Hotel Deletion ────────────────────────────────────────────────


class TestHotelDeletionImpact:
    async def test_no_bookings_no_channels(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/hotel/deletion-impact",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["upcomingBookingsCount"] == 0
        assert body["connectedChannelsCount"] == 0

    async def test_counts_upcoming_bookings(self, client, cleanup_database):
        from datetime import date, timedelta

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        future_in = (date.today() + timedelta(days=10)).isoformat()
        future_out = (date.today() + timedelta(days=12)).isoformat()
        past_in = (date.today() - timedelta(days=20)).isoformat()
        past_out = (date.today() - timedelta(days=18)).isoformat()

        await create_test_booking(str(hotel["id"]), str(room["id"]),
                                  check_in=future_in, check_out=future_out,
                                  guest_email="future@example.com")
        await create_test_booking(str(hotel["id"]), str(room["id"]),
                                  check_in=future_in, check_out=future_out,
                                  guest_email="cancelled@example.com",
                                  status="cancelled")
        await create_test_booking(str(hotel["id"]), str(room["id"]),
                                  check_in=past_in, check_out=past_out,
                                  guest_email="past@example.com")

        resp = await client.get(
            "/admin/hotel/deletion-impact",
            headers=get_auth_headers(user["token"]),
        )
        # Cancelled and past bookings excluded; only the one upcoming counts.
        assert resp.json()["upcomingBookingsCount"] == 1


class TestDeleteHotel:
    async def test_delete_owned_hotel(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.delete(
            "/admin/hotel",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Subsequent GET is a 404 because no hotel exists for the user
        # (setup-status would auto-create one — use a direct repo lookup
        # via the admin endpoint instead).
        from app.repositories.hotel_repo import HotelRepository
        assert await HotelRepository.get_by_id(str(hotel["id"])) is None

    async def test_delete_cascades_bookings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(str(hotel["id"]), str(room["id"]))

        resp = await client.delete(
            "/admin/hotel",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        from app.database import Database
        remaining = await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1", str(hotel["id"])
        )
        assert remaining == 0

    async def test_delete_other_users_hotel_forbidden(self, client, cleanup_database):
        owner = await create_test_user()
        owned = await create_test_hotel(str(owner["id"]))
        attacker = await create_test_user()

        resp = await client.delete(
            "/admin/hotel",
            headers={
                **get_auth_headers(attacker["token"]),
                "X-Hotel-Id": str(owned["id"]),
            },
        )
        # X-Hotel-Id mismatch — 403 from get_hotel_id ownership check
        assert resp.status_code == 403

    async def test_delete_calls_channex_when_connected(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        from app.repositories.channex_mapping_repo import ChannexConnectionRepository
        await ChannexConnectionRepository.upsert(str(hotel["id"]))
        await ChannexConnectionRepository.set_property_id(
            str(hotel["id"]), "11111111-1111-1111-1111-111111111111"
        )

        with patch(
            "app.services.channex_service.delete_property",
            new=AsyncMock(return_value=None),
        ) as mock_delete, patch(
            "app.services.channex_service.get_platform_api_key",
            return_value="test-key",
        ):
            resp = await client.delete(
                "/admin/hotel",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 204
        mock_delete.assert_awaited_once()
        # Called with the configured property id and force=True
        args, kwargs = mock_delete.call_args
        assert str(args[1]) == "11111111-1111-1111-1111-111111111111"
        assert kwargs.get("force") is True

    async def test_delete_succeeds_even_if_channex_fails(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        from app.repositories.channex_mapping_repo import ChannexConnectionRepository
        await ChannexConnectionRepository.upsert(str(hotel["id"]))
        await ChannexConnectionRepository.set_property_id(
            str(hotel["id"]), "11111111-1111-1111-1111-111111111111"
        )

        with patch(
            "app.services.channex_service.delete_property",
            new=AsyncMock(side_effect=Exception("Channex 500")),
        ), patch(
            "app.services.channex_service.get_platform_api_key",
            return_value="test-key",
        ):
            resp = await client.delete(
                "/admin/hotel",
                headers=get_auth_headers(user["token"]),
            )

        # The user has been warned manual OTA cleanup may be needed —
        # don't block the local delete on a Channex hiccup.
        assert resp.status_code == 204
        from app.repositories.hotel_repo import HotelRepository
        assert await HotelRepository.get_by_id(str(hotel["id"])) is None
