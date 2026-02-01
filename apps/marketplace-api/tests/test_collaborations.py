"""
Tests for collaboration management endpoints.
"""
import pytest
from httpx import AsyncClient
from datetime import date, timedelta

from app.database import Database
from tests.conftest import (
    get_auth_headers,
    create_test_creator,
    create_test_hotel,
    create_test_listing,
    create_test_collaboration,
    create_test_platform,
)


class TestCreateCollaboration:
    """Tests for POST /collaborations"""

    async def test_creator_initiates_collaboration(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test creator initiating a collaboration."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.post(
            "/collaborations",
            json={
                "initiator_type": "creator",
                "listing_id": listing_id,
                "collaboration_type": "Free Stay",
                "why_great_fit": "I love this hotel and would create amazing content!",
                "free_stay_min_nights": 3,
                "free_stay_max_nights": 5,
                "travel_date_from": str(date.today() + timedelta(days=30)),
                "travel_date_to": str(date.today() + timedelta(days=35)),
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Reel", "quantity": 2, "status": "pending"},
                            {"type": "Story", "quantity": 5, "status": "pending"}
                        ]
                    }
                ],
                "consent": True
            },
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["initiator_type"] == "creator"
        assert data["status"] == "pending"
        assert data["listing_id"] == listing_id

    async def test_hotel_initiates_collaboration(
        self, client: AsyncClient, test_hotel_verified, test_creator_verified
    ):
        """Test hotel initiating a collaboration."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])
        creator_id = str(test_creator_verified["creator"]["id"])

        response = await client.post(
            "/collaborations",
            json={
                "initiator_type": "hotel",
                "listing_id": listing_id,
                "creator_id": creator_id,
                "collaboration_type": "Free Stay",
                "why_great_fit": "We think you'd be perfect for our brand!",
                "free_stay_min_nights": 4,
                "free_stay_max_nights": 7,
                "preferred_date_from": str(date.today() + timedelta(days=60)),
                "preferred_date_to": str(date.today() + timedelta(days=67)),
                "platform_deliverables": [
                    {
                        "platform": "TikTok",
                        "deliverables": [
                            {"type": "Video", "quantity": 3, "status": "pending"}
                        ]
                    }
                ]
            },
            headers=get_auth_headers(test_hotel_verified["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["initiator_type"] == "hotel"
        assert data["creator_id"] == creator_id

    async def test_create_with_paid_collaboration(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test creating paid collaboration."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.post(
            "/collaborations",
            json={
                "initiator_type": "creator",
                "listing_id": listing_id,
                "collaboration_type": "Paid",
                "why_great_fit": "Professional content creator",
                "paid_amount": 5000,
                "travel_date_from": str(date.today() + timedelta(days=30)),
                "travel_date_to": str(date.today() + timedelta(days=35)),
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Post", "quantity": 5, "status": "pending"}
                        ]
                    }
                ],
                "consent": True
            },
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["collaboration_type"] == "Paid"
        # paid_amount returned as string from Decimal
        assert float(data["paid_amount"]) == 5000

    async def test_create_with_discount_collaboration(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test creating discount collaboration."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.post(
            "/collaborations",
            json={
                "initiator_type": "creator",
                "listing_id": listing_id,
                "collaboration_type": "Discount",
                "why_great_fit": "Would love a discount stay",
                "discount_percentage": 50,
                "travel_date_from": str(date.today() + timedelta(days=30)),
                "travel_date_to": str(date.today() + timedelta(days=35)),
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [
                            {"type": "Story", "quantity": 10, "status": "pending"}
                        ]
                    }
                ],
                "consent": True
            },
            headers=get_auth_headers(test_creator_verified["token"])
        )

        assert response.status_code == 201
        data = response.json()
        assert data["collaboration_type"] == "Discount"
        assert data["discount_percentage"] == 50

    async def test_creator_cannot_initiate_as_hotel(
        self, client: AsyncClient, test_creator_verified, test_hotel_verified
    ):
        """Test creator cannot initiate as hotel."""
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.post(
            "/collaborations",
            json={
                "initiator_type": "hotel",  # Wrong type - creator trying to act as hotel
                "listing_id": listing_id,
                "creator_id": str(test_creator_verified["creator"]["id"]),
                "collaboration_type": "Free Stay",
                "why_great_fit": "Test",
                "platform_deliverables": [
                    {
                        "platform": "Instagram",
                        "deliverables": [{"type": "Post", "quantity": 1, "status": "pending"}]
                    }
                ]
            },
            headers=get_auth_headers(test_creator_verified["token"])
        )

        # API may return 403 (forbidden), 400 (bad request), or 422 (validation error) for this scenario
        assert response.status_code in [400, 403, 422]


class TestRespondToCollaboration:
    """Tests for POST /collaborations/{id}/respond"""

    async def test_accept_collaboration(
        self, client: AsyncClient, test_collaboration
    ):
        """Test accepting a collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Hotel accepts creator-initiated collaboration
        response = await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted", "response_message": "We'd love to work with you!"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "negotiating"  # Moves to negotiating first

    async def test_decline_collaboration(
        self, client: AsyncClient, test_collaboration
    ):
        """Test declining a collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "declined", "response_message": "Not a good fit right now"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "declined"

    async def test_cannot_respond_to_already_responded(
        self, client: AsyncClient, test_collaboration
    ):
        """Test cannot respond to already responded collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # First response
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Try to respond again
        response = await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "declined"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 400

    async def test_initiator_cannot_respond(
        self, client: AsyncClient, test_collaboration
    ):
        """Test initiator cannot respond to their own collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 403


class TestUpdateCollaborationTerms:
    """Tests for PUT /collaborations/{id}/terms"""

    async def test_update_collaboration_type(
        self, client: AsyncClient, test_collaboration
    ):
        """Test updating collaboration type."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # First accept to move to negotiating
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.put(
            f"/collaborations/{collab_id}/terms",
            json={
                "collaboration_type": "Paid",
                "paid_amount": 3000
            },
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["collaboration_type"] == "Paid"
        # paid_amount returned as string from Decimal
        assert float(data["paid_amount"]) == 3000

    async def test_update_nights(
        self, client: AsyncClient, test_collaboration
    ):
        """Test updating stay nights."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.put(
            f"/collaborations/{collab_id}/terms",
            json={
                "stay_nights": 5
            },
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["free_stay_min_nights"] == 5
        assert data["free_stay_max_nights"] == 5

    async def test_update_dates(
        self, client: AsyncClient, test_collaboration
    ):
        """Test updating travel dates."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        new_from = str(date.today() + timedelta(days=45))
        new_to = str(date.today() + timedelta(days=50))

        response = await client.put(
            f"/collaborations/{collab_id}/terms",
            json={
                "travel_date_from": new_from,
                "travel_date_to": new_to
            },
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["travel_date_from"] == new_from

    async def test_update_resets_agreement(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that updating terms resets the other party's agreement."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Hotel updates terms
        response = await client.put(
            f"/collaborations/{collab_id}/terms",
            json={"stay_nights": 7},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Hotel agreed (just made the update), creator agreement should be reset
        assert data["hotel_agreed_at"] is not None
        assert data["creator_agreed_at"] is None

    async def test_update_deliverables(
        self, client: AsyncClient, test_collaboration
    ):
        """Test updating deliverables."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        response = await client.put(
            f"/collaborations/{collab_id}/terms",
            json={
                "platform_deliverables": [
                    {
                        "platform": "TikTok",
                        "deliverables": [
                            {"type": "Video", "quantity": 5, "status": "pending"}
                        ]
                    }
                ]
            },
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platform_deliverables"]) == 1
        assert data["platform_deliverables"][0]["platform"] == "TikTok"


class TestApproveCollaboration:
    """Tests for POST /collaborations/{id}/approve"""

    async def test_single_approval(
        self, client: AsyncClient, test_collaboration
    ):
        """Test single party approval."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Creator approves
        response = await client.post(
            f"/collaborations/{collab_id}/approve",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["creator_agreed_at"] is not None
        # Hotel already agreed when accepting
        assert data["status"] == "accepted"  # Both agreed

    async def test_double_approval_finalizes(
        self, client: AsyncClient, test_collaboration
    ):
        """Test that double approval finalizes collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Accept first
        await client.post(
            f"/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        # Creator approves
        await client.post(
            f"/collaborations/{collab_id}/approve",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        # Verify collaboration is accepted
        collab = await Database.fetchrow(
            "SELECT status FROM collaborations WHERE id = $1",
            test_collaboration["collaboration"]["id"]
        )
        assert collab["status"] == "accepted"

    async def test_non_participant_cannot_approve(
        self, client: AsyncClient, test_collaboration, cleanup_database, init_database
    ):
        """Test that non-participant cannot approve."""
        other_creator = await create_test_creator()
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/approve",
            headers=get_auth_headers(other_creator["token"])
        )

        assert response.status_code == 403


class TestCancelCollaboration:
    """Tests for POST /collaborations/{id}/cancel"""

    async def test_creator_cancels(
        self, client: AsyncClient, test_collaboration
    ):
        """Test creator cancelling collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={"reason": "Change of plans"},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "cancelled"
        assert data["cancelled_at"] is not None

    async def test_hotel_cancels(
        self, client: AsyncClient, test_collaboration
    ):
        """Test hotel cancelling collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={"reason": "Fully booked"},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "cancelled"

    async def test_cancel_without_reason(
        self, client: AsyncClient, test_collaboration
    ):
        """Test cancelling without providing reason."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200

    async def test_cannot_cancel_already_cancelled(
        self, client: AsyncClient, test_collaboration
    ):
        """Test cannot cancel already cancelled collaboration."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Cancel first
        await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={},
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        # Try to cancel again
        response = await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={},
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 400

    async def test_non_participant_cannot_cancel(
        self, client: AsyncClient, test_collaboration, cleanup_database, init_database
    ):
        """Test non-participant cannot cancel."""
        other_creator = await create_test_creator()
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/cancel",
            json={},
            headers=get_auth_headers(other_creator["token"])
        )

        assert response.status_code == 403


class TestToggleDeliverable:
    """Tests for POST /collaborations/{id}/deliverables/{did}/toggle"""

    async def test_toggle_deliverable_status(
        self, client: AsyncClient, test_collaboration
    ):
        """Test toggling deliverable completion status."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Get deliverable ID
        deliverable = await Database.fetchrow(
            "SELECT id FROM collaboration_deliverables WHERE collaboration_id = $1 LIMIT 1",
            test_collaboration["collaboration"]["id"]
        )

        response = await client.post(
            f"/collaborations/{collab_id}/deliverables/{deliverable['id']}/toggle",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        # Check that one deliverable has changed status
        deliverable_found = False
        for pd in data["platform_deliverables"]:
            for d in pd["deliverables"]:
                if d["id"] == str(deliverable["id"]):
                    assert d["status"] == "completed"
                    deliverable_found = True
        assert deliverable_found

    async def test_toggle_deliverable_back(
        self, client: AsyncClient, test_collaboration
    ):
        """Test toggling deliverable back to pending."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        deliverable = await Database.fetchrow(
            "SELECT id FROM collaboration_deliverables WHERE collaboration_id = $1 LIMIT 1",
            test_collaboration["collaboration"]["id"]
        )

        # Toggle to completed
        await client.post(
            f"/collaborations/{collab_id}/deliverables/{deliverable['id']}/toggle",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        # Toggle back to pending
        response = await client.post(
            f"/collaborations/{collab_id}/deliverables/{deliverable['id']}/toggle",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for pd in data["platform_deliverables"]:
            for d in pd["deliverables"]:
                if d["id"] == str(deliverable["id"]):
                    assert d["status"] == "pending"

    async def test_toggle_deliverable_not_found(
        self, client: AsyncClient, test_collaboration
    ):
        """Test toggling non-existent deliverable."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/collaborations/{collab_id}/deliverables/00000000-0000-0000-0000-000000000000/toggle",
            headers=get_auth_headers(test_collaboration["creator"]["token"])
        )

        assert response.status_code == 404

    async def test_hotel_can_toggle_deliverable(
        self, client: AsyncClient, test_collaboration
    ):
        """Test hotel can toggle deliverable."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        deliverable = await Database.fetchrow(
            "SELECT id FROM collaboration_deliverables WHERE collaboration_id = $1 LIMIT 1",
            test_collaboration["collaboration"]["id"]
        )

        response = await client.post(
            f"/collaborations/{collab_id}/deliverables/{deliverable['id']}/toggle",
            headers=get_auth_headers(test_collaboration["hotel"]["token"])
        )

        assert response.status_code == 200


class TestCollaborationNotFound:
    """Tests for collaboration not found scenarios"""

    async def test_respond_not_found(
        self, client: AsyncClient, test_hotel
    ):
        """Test responding to non-existent collaboration."""
        response = await client.post(
            "/collaborations/00000000-0000-0000-0000-000000000000/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_hotel["token"])
        )

        assert response.status_code == 404

    async def test_update_terms_not_found(
        self, client: AsyncClient, test_creator
    ):
        """Test updating terms for non-existent collaboration."""
        response = await client.put(
            "/collaborations/00000000-0000-0000-0000-000000000000/terms",
            json={"stay_nights": 5},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 404

    async def test_approve_not_found(
        self, client: AsyncClient, test_creator
    ):
        """Test approving non-existent collaboration."""
        response = await client.post(
            "/collaborations/00000000-0000-0000-0000-000000000000/approve",
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 404

    async def test_cancel_not_found(
        self, client: AsyncClient, test_creator
    ):
        """Test cancelling non-existent collaboration."""
        response = await client.post(
            "/collaborations/00000000-0000-0000-0000-000000000000/cancel",
            json={},
            headers=get_auth_headers(test_creator["token"])
        )

        assert response.status_code == 404
