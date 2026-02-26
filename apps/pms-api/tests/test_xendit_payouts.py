"""
Tests for Xendit payout integration: config, models, service, repositories,
admin endpoints, webhook, and scheduler dispatch.
"""
import json
import hmac
import hashlib
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, AsyncMock, MagicMock

from tests.conftest import (
    create_test_user,
    create_test_hotel,
    create_test_room_type,
    create_test_booking,
    create_test_booking_with_payment,
    create_test_payment_settings,
    create_test_affiliate,
    get_auth_headers,
)
from app.database import Database
from app.config import settings


# ── Config ────────────────────────────────────────────────────────


class TestXenditConfig:
    """Verify Xendit config fields are present."""

    async def test_xendit_secret_key_exists(self, init_database):
        assert hasattr(settings, "XENDIT_SECRET_KEY")

    async def test_xendit_webhook_secret_exists(self, init_database):
        assert hasattr(settings, "XENDIT_WEBHOOK_SECRET")

    async def test_xendit_test_values_loaded(self, init_database):
        assert settings.XENDIT_SECRET_KEY == "xnd_test_fake"
        assert settings.XENDIT_WEBHOOK_SECRET == "xendit_webhook_test_secret"


# ── Models ────────────────────────────────────────────────────────


class TestXenditModels:
    """Verify Xendit-related pydantic models."""

    async def test_hotel_payment_settings_xendit_fields(self, init_database):
        from app.models.payment import HotelPaymentSettings

        s = HotelPaymentSettings(
            payment_provider="xendit",
            xendit_channel_code="ID_BCA",
            xendit_account_number="1234567890",
            xendit_account_holder_name="John Doe",
        )
        assert s.payment_provider == "xendit"
        assert s.xendit_channel_code == "ID_BCA"
        assert s.xendit_account_number == "1234567890"
        assert s.xendit_account_holder_name == "John Doe"

    async def test_hotel_payment_settings_defaults(self, init_database):
        from app.models.payment import HotelPaymentSettings

        s = HotelPaymentSettings()
        assert s.payment_provider == "stripe"
        assert s.xendit_channel_code is None
        assert s.xendit_account_number is None
        assert s.xendit_account_holder_name is None

    async def test_hotel_payment_settings_update_xendit_fields(self, init_database):
        from app.models.payment import HotelPaymentSettingsUpdate

        u = HotelPaymentSettingsUpdate(
            payment_provider="xendit",
            xendit_channel_code="ID_MANDIRI",
        )
        data = u.model_dump(exclude_unset=True)
        assert data["payment_provider"] == "xendit"
        assert data["xendit_channel_code"] == "ID_MANDIRI"
        assert "xendit_account_number" not in data

    async def test_xendit_bank_details_request(self, init_database):
        from app.models.payment import XenditBankDetailsRequest

        req = XenditBankDetailsRequest(
            channel_code="ID_BCA",
            account_number="123456",
            account_holder_name="Test User",
        )
        assert req.channel_code == "ID_BCA"
        assert req.account_number == "123456"
        assert req.account_holder_name == "Test User"

    async def test_xendit_bank_details_camel_alias(self, init_database):
        from app.models.payment import XenditBankDetailsRequest

        req = XenditBankDetailsRequest.model_validate(
            {"channelCode": "ID_BNI", "accountNumber": "999", "accountHolderName": "Alias Test"}
        )
        assert req.channel_code == "ID_BNI"

    async def test_affiliate_admin_response_xendit_fields(self, init_database):
        from app.models.affiliate import AffiliateAdminResponse

        a = AffiliateAdminResponse(
            id="test-id",
            hotel_id="hotel-id",
            referral_code="abc123",
            full_name="Test",
            email="test@test.com",
            social_media="",
            user_type="guest",
            payment_method="xendit",
            paypal_email="",
            bank_iban="",
            commission_pct=10.0,
            status="approved",
            created_at="2026-01-01",
            updated_at="2026-01-01",
            xendit_channel_code="ID_BCA",
            xendit_account_number="1234",
            xendit_account_holder_name="Test User",
        )
        assert a.xendit_channel_code == "ID_BCA"
        assert a.xendit_account_number == "1234"
        assert a.xendit_account_holder_name == "Test User"

    async def test_affiliate_admin_response_xendit_defaults(self, init_database):
        from app.models.affiliate import AffiliateAdminResponse

        a = AffiliateAdminResponse(
            id="test-id",
            hotel_id="hotel-id",
            referral_code="abc123",
            full_name="Test",
            email="test@test.com",
            social_media="",
            user_type="guest",
            payment_method="paypal",
            paypal_email="",
            bank_iban="",
            commission_pct=10.0,
            status="pending",
            created_at="2026-01-01",
            updated_at="2026-01-01",
        )
        assert a.xendit_channel_code is None
        assert a.xendit_account_number is None
        assert a.xendit_account_holder_name is None


# ── Xendit Service ────────────────────────────────────────────────


class TestXenditService:
    """Unit tests for xendit_service module."""

    async def test_create_payout(self, init_database):
        from app.services import xendit_service

        mock_payout = MagicMock()
        mock_payout.id = "disb_test_123"
        mock_payout.reference_id = "ref-001"
        mock_payout.status = "ACCEPTED"
        mock_payout.amount = 500000

        with patch.object(xendit_service.payout_api, "create_payout", return_value=mock_payout):
            result = await xendit_service.create_payout(
                reference_id="ref-001",
                channel_code="ID_BCA",
                account_number="1234567890",
                account_holder_name="John Doe",
                amount=500000,
                currency="IDR",
                description="Test payout",
            )

        assert result["id"] == "disb_test_123"
        assert result["reference_id"] == "ref-001"
        assert result["status"] == "ACCEPTED"
        assert result["amount"] == 500000

    async def test_get_payout(self, init_database):
        from app.services import xendit_service

        mock_payout = MagicMock()
        mock_payout.id = "disb_test_456"
        mock_payout.reference_id = "ref-002"
        mock_payout.status = "SUCCEEDED"
        mock_payout.amount = 1000000

        with patch.object(xendit_service.payout_api, "get_payout_by_id", return_value=mock_payout):
            result = await xendit_service.get_payout("disb_test_456")

        assert result["id"] == "disb_test_456"
        assert result["status"] == "SUCCEEDED"


# ── Affiliate Repository: Xendit ──────────────────────────────────


class TestAffiliateRepoXendit:
    """Tests for affiliate_repo.update_xendit_details."""

    async def test_update_xendit_details(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        from app.repositories.affiliate_repo import AffiliateRepository

        updated = await AffiliateRepository.update_xendit_details(
            str(aff["id"]),
            channel_code="ID_BCA",
            account_number="1234567890",
            account_holder_name="Test User",
        )

        assert updated["payment_method"] == "xendit"
        assert updated["xendit_channel_code"] == "ID_BCA"
        assert updated["xendit_account_number"] == "1234567890"
        assert updated["xendit_account_holder_name"] == "Test User"

    async def test_update_xendit_details_not_found(self, cleanup_database):
        from app.repositories.affiliate_repo import AffiliateRepository

        result = await AffiliateRepository.update_xendit_details(
            "00000000-0000-0000-0000-000000000000",
            channel_code="ID_BCA",
            account_number="123",
            account_holder_name="Nobody",
        )
        assert result is None


# ── Payout Repository: xendit_payout_id ───────────────────────────


class TestPayoutRepoXendit:
    """Tests for payout_repo.update_status with xendit_payout_id."""

    async def test_update_status_with_xendit_payout_id(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        from app.repositories.payout_repo import PayoutRepository

        payout = await PayoutRepository.create(
            booking_id=str(booking["id"]),
            recipient_type="hotel",
            recipient_id=str(hotel["id"]),
            amount=100.0,
            currency="IDR",
            scheduled_for=datetime.now(timezone.utc),
        )

        updated = await PayoutRepository.update_status(
            str(payout["id"]),
            "completed",
            xendit_payout_id="disb_test_789",
        )
        assert updated["status"] == "completed"
        assert updated["xendit_payout_id"] == "disb_test_789"
        assert updated["completed_at"] is not None

    async def test_update_status_without_provider_id(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        from app.repositories.payout_repo import PayoutRepository

        payout = await PayoutRepository.create(
            booking_id=str(booking["id"]),
            recipient_type="hotel",
            recipient_id=str(hotel["id"]),
            amount=100.0,
            currency="EUR",
            scheduled_for=datetime.now(timezone.utc),
        )

        updated = await PayoutRepository.update_status(str(payout["id"]), "processing")
        assert updated["status"] == "processing"
        assert updated["xendit_payout_id"] is None
        assert updated["stripe_transfer_id"] is None

    async def test_update_status_with_stripe_transfer_id(self, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        from app.repositories.payout_repo import PayoutRepository

        payout = await PayoutRepository.create(
            booking_id=str(booking["id"]),
            recipient_type="hotel",
            recipient_id=str(hotel["id"]),
            amount=100.0,
            currency="EUR",
            scheduled_for=datetime.now(timezone.utc),
        )

        updated = await PayoutRepository.update_status(
            str(payout["id"]),
            "completed",
            stripe_transfer_id="tr_stripe_123",
        )
        assert updated["status"] == "completed"
        assert updated["stripe_transfer_id"] == "tr_stripe_123"
        assert updated["xendit_payout_id"] is None


# ── Admin Endpoint: Affiliate Xendit Bank Details ─────────────────


class TestAdminAffiliateXendit:
    """Tests for POST /admin/affiliates/{id}/xendit/bank-details."""

    async def test_save_xendit_bank_details(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        # Approve first
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1", aff["id"]
        )

        resp = await client.post(
            f"/admin/affiliates/{aff['id']}/xendit/bank-details",
            headers=get_auth_headers(user["token"]),
            json={
                "channelCode": "ID_BCA",
                "accountNumber": "1234567890",
                "accountHolderName": "Test Affiliate",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentMethod"] == "xendit"
        assert body["xenditChannelCode"] == "ID_BCA"
        assert body["xenditAccountNumber"] == "1234567890"
        assert body["xenditAccountHolderName"] == "Test Affiliate"

    async def test_save_xendit_bank_details_not_approved(self, client, cleanup_database):
        """Cannot save Xendit details for non-approved affiliate."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))  # status=pending

        resp = await client.post(
            f"/admin/affiliates/{aff['id']}/xendit/bank-details",
            headers=get_auth_headers(user["token"]),
            json={
                "channelCode": "ID_BCA",
                "accountNumber": "1234567890",
                "accountHolderName": "Test",
            },
        )
        assert resp.status_code == 400

    async def test_save_xendit_bank_details_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/affiliates/00000000-0000-0000-0000-000000000000/xendit/bank-details",
            headers=get_auth_headers(user["token"]),
            json={
                "channelCode": "ID_BCA",
                "accountNumber": "123",
                "accountHolderName": "Nobody",
            },
        )
        assert resp.status_code == 404

    async def test_save_xendit_bank_details_other_user(self, client, cleanup_database):
        """Cannot save Xendit details for another user's affiliate."""
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        aff = await create_test_affiliate(str(hotel_a["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1", aff["id"]
        )

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        resp = await client.post(
            f"/admin/affiliates/{aff['id']}/xendit/bank-details",
            headers=get_auth_headers(user_b["token"]),
            json={
                "channelCode": "ID_BCA",
                "accountNumber": "123",
                "accountHolderName": "Intruder",
            },
        )
        assert resp.status_code == 404

    async def test_save_xendit_bank_details_requires_auth(self, client, cleanup_database):
        resp = await client.post(
            "/admin/affiliates/00000000-0000-0000-0000-000000000000/xendit/bank-details",
            json={
                "channelCode": "ID_BCA",
                "accountNumber": "123",
                "accountHolderName": "No Auth",
            },
        )
        assert resp.status_code == 403


# ── Admin: Payment Settings with Xendit Fields ───────────────────


class TestAdminPaymentSettingsXendit:
    """Tests for Xendit fields in GET/PATCH /admin/payment-settings."""

    async def test_get_payment_settings_includes_xendit_fields(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]))

        resp = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        ps = resp.json()["paymentSettings"]
        assert "paymentProvider" in ps
        assert ps["paymentProvider"] == "stripe"
        assert "xenditChannelCode" in ps
        assert "xenditAccountNumber" in ps
        assert "xenditAccountHolderName" in ps

    async def test_update_payment_settings_to_xendit(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]))

        resp = await client.patch(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
            json={
                "paymentProvider": "xendit",
                "xenditChannelCode": "ID_MANDIRI",
                "xenditAccountNumber": "9876543210",
                "xenditAccountHolderName": "Hotel Owner",
            },
        )
        assert resp.status_code == 200

        # Verify via GET
        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        ps = resp2.json()["paymentSettings"]
        assert ps["paymentProvider"] == "xendit"
        assert ps["xenditChannelCode"] == "ID_MANDIRI"
        assert ps["xenditAccountNumber"] == "9876543210"
        assert ps["xenditAccountHolderName"] == "Hotel Owner"

    async def test_update_payment_settings_back_to_stripe(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]))

        # Set to Xendit first
        await client.patch(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
            json={"paymentProvider": "xendit"},
        )

        # Switch back to Stripe
        resp = await client.patch(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
            json={"paymentProvider": "stripe"},
        )
        assert resp.status_code == 200

        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.json()["paymentSettings"]["paymentProvider"] == "stripe"


# ── Admin: Affiliate Detail includes Xendit fields ────────────────


class TestAdminAffiliateDetailXendit:
    """Verify affiliate detail response includes Xendit fields."""

    async def test_affiliate_detail_has_xendit_fields(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))

        resp = await client.get(
            f"/admin/affiliates/{aff['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "xenditChannelCode" in body
        assert "xenditAccountNumber" in body
        assert "xenditAccountHolderName" in body
        assert body["xenditChannelCode"] is None

    async def test_affiliate_detail_after_xendit_setup(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1", aff["id"]
        )

        # Save Xendit details
        await client.post(
            f"/admin/affiliates/{aff['id']}/xendit/bank-details",
            headers=get_auth_headers(user["token"]),
            json={
                "channelCode": "ID_BRI",
                "accountNumber": "5555555",
                "accountHolderName": "BRI User",
            },
        )

        resp = await client.get(
            f"/admin/affiliates/{aff['id']}",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["xenditChannelCode"] == "ID_BRI"
        assert body["xenditAccountNumber"] == "5555555"
        assert body["xenditAccountHolderName"] == "BRI User"
        assert body["paymentMethod"] == "xendit"


# ── Webhook: Xendit ───────────────────────────────────────────────


class TestXenditWebhook:
    """Tests for POST /webhooks/xendit."""

    async def test_xendit_webhook_payout_succeeded(self, client, cleanup_database):
        """Successful payout webhook updates payout status to completed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        # Create a payout with xendit_payout_id
        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status, xendit_payout_id)
            VALUES ($1, 'hotel', $2, 100.0, 'IDR', now(), 'processing', 'disb_webhook_test')
            RETURNING *
            """,
            str(booking["id"]), str(hotel["id"]),
        )

        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({
                "event": "payout.succeeded",
                "data": {
                    "id": "disb_webhook_test",
                    "status": "SUCCEEDED",
                    "reference_id": f"hotel-{payout['id']}",
                },
            }),
            headers={
                "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 200

        # Verify payout is completed
        updated = await Database.fetchrow(
            "SELECT status, completed_at FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "completed"
        assert updated["completed_at"] is not None

    async def test_xendit_webhook_payout_failed(self, client, cleanup_database):
        """Failed payout webhook updates payout status to failed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status, xendit_payout_id)
            VALUES ($1, 'hotel', $2, 100.0, 'IDR', now(), 'processing', 'disb_fail_test')
            RETURNING *
            """,
            str(booking["id"]), str(hotel["id"]),
        )

        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({
                "event": "payout.failed",
                "data": {
                    "id": "disb_fail_test",
                    "status": "FAILED",
                },
            }),
            headers={
                "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 200

        updated = await Database.fetchrow(
            "SELECT status FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "failed"

    async def test_xendit_webhook_missing_token(self, client, init_database):
        """Missing callback token returns 400."""
        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({"event": "payout.succeeded", "data": {"id": "test"}}),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 400

    async def test_xendit_webhook_invalid_token(self, client, init_database):
        """Invalid callback token returns 400."""
        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({"event": "payout.succeeded", "data": {"id": "test"}}),
            headers={
                "x-callback-token": "wrong_token",
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 400

    async def test_xendit_webhook_unknown_payout_id(self, client, init_database):
        """Unknown payout ID in webhook is handled gracefully."""
        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({
                "event": "payout.succeeded",
                "data": {"id": "disb_nonexistent", "status": "SUCCEEDED"},
            }),
            headers={
                "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 200

    async def test_xendit_webhook_no_payout_id(self, client, init_database):
        """Webhook without payout ID returns ok."""
        resp = await client.post(
            "/webhooks/xendit",
            content=json.dumps({"event": "some.event", "data": {}}),
            headers={
                "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 200


# ── Scheduler: Property Payouts with Xendit ───────────────────────


class TestSchedulerPropertyPayoutsXendit:
    """Tests for process_property_payouts dispatching to Xendit."""

    async def test_property_payout_via_xendit(self, cleanup_database):
        """Hotel with payment_provider='xendit' uses Xendit for payouts."""
        from app.services.scheduler import process_property_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        # Create payment settings with xendit provider
        await Database.execute(
            """
            INSERT INTO hotel_payment_settings (
                hotel_id, payment_provider, xendit_channel_code,
                xendit_account_number, xendit_account_holder_name
            ) VALUES ($1, 'xendit', 'ID_BCA', '1234567890', 'Hotel Owner')
            ON CONFLICT (hotel_id) DO UPDATE SET
                payment_provider = 'xendit',
                xendit_channel_code = 'ID_BCA',
                xendit_account_number = '1234567890',
                xendit_account_holder_name = 'Hotel Owner'
            """,
            str(hotel["id"]),
        )

        # Create a due payout
        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'hotel', $2, 500.0, 'IDR', $3, 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(hotel["id"]),
            datetime.now(timezone.utc) - timedelta(hours=1),
        )

        with patch("app.services.xendit_service.create_payout", new_callable=AsyncMock) as mock_xen:
            mock_xen.return_value = {"id": "disb_sched_hotel", "reference_id": f"hotel-{payout['id']}", "status": "ACCEPTED", "amount": 500}
            await process_property_payouts()

        mock_xen.assert_called_once()
        call_kwargs = mock_xen.call_args
        assert call_kwargs.kwargs["channel_code"] == "ID_BCA"
        assert call_kwargs.kwargs["account_number"] == "1234567890"

        updated = await Database.fetchrow(
            "SELECT status, xendit_payout_id FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "completed"
        assert updated["xendit_payout_id"] == "disb_sched_hotel"

    async def test_property_payout_via_stripe_unchanged(self, cleanup_database):
        """Hotel with payment_provider='stripe' still uses Stripe."""
        from app.services.scheduler import process_property_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_stripe",
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'hotel', $2, 200.0, 'EUR', $3, 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(hotel["id"]),
            datetime.now(timezone.utc) - timedelta(hours=1),
        )

        with patch("app.services.stripe_service.create_transfer", new_callable=AsyncMock) as mock_stripe:
            mock_stripe.return_value = {"id": "tr_sched_hotel", "amount": 20000}
            await process_property_payouts()

        mock_stripe.assert_called_once()

        updated = await Database.fetchrow(
            "SELECT status, stripe_transfer_id FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "completed"
        assert updated["stripe_transfer_id"] == "tr_sched_hotel"

    async def test_property_payout_xendit_missing_bank_details_skips(self, cleanup_database):
        """Hotel with Xendit provider but no bank details → payout stays scheduled."""
        from app.services.scheduler import process_property_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]), status="confirmed"
        )

        # Xendit provider but no bank details
        await Database.execute(
            """
            INSERT INTO hotel_payment_settings (hotel_id, payment_provider)
            VALUES ($1, 'xendit')
            ON CONFLICT (hotel_id) DO UPDATE SET payment_provider = 'xendit'
            """,
            str(hotel["id"]),
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'hotel', $2, 300.0, 'IDR', $3, 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(hotel["id"]),
            datetime.now(timezone.utc) - timedelta(hours=1),
        )

        await process_property_payouts()

        updated = await Database.fetchrow(
            "SELECT status FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "scheduled"


# ── Scheduler: Affiliate Payouts with Xendit ──────────────────────


class TestSchedulerAffiliatePayoutsXendit:
    """Tests for process_affiliate_payouts dispatching to Xendit."""

    async def test_affiliate_payout_via_xendit(self, cleanup_database):
        """Affiliate with payment_method='xendit' uses Xendit for payouts."""
        from app.services.scheduler import process_affiliate_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            status="confirmed",
            check_in="2025-12-01", check_out="2025-12-05",
        )
        aff = await create_test_affiliate(str(hotel["id"]))

        # Set up Xendit details on affiliate
        await Database.execute(
            """
            UPDATE affiliates
            SET status = 'approved', payment_method = 'xendit',
                xendit_channel_code = 'ID_MANDIRI',
                xendit_account_number = '9876543210',
                xendit_account_holder_name = 'Aff Mandiri'
            WHERE id = $1
            """,
            aff["id"],
        )

        # Create affiliate payout for Jan 2026 (previous month of Feb 2026 run)
        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'affiliate', $2, 50.0, 'IDR', '2026-01-15', 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(aff["id"]),
        )

        # Mock datetime to February 2026 so it processes January payouts
        mock_now = datetime(2026, 2, 1, 2, 0, tzinfo=timezone.utc)
        with (
            patch("app.services.scheduler.datetime") as mock_dt,
            patch("app.services.xendit_service.create_payout", new_callable=AsyncMock) as mock_xen,
        ):
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_xen.return_value = {"id": "disb_aff_xen", "reference_id": f"affiliate-{payout['id']}", "status": "ACCEPTED", "amount": 50}
            await process_affiliate_payouts()

        mock_xen.assert_called_once()
        call_kwargs = mock_xen.call_args
        assert call_kwargs.kwargs["channel_code"] == "ID_MANDIRI"
        assert call_kwargs.kwargs["account_number"] == "9876543210"
        assert call_kwargs.kwargs["account_holder_name"] == "Aff Mandiri"

        updated = await Database.fetchrow(
            "SELECT status, xendit_payout_id FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "completed"
        assert updated["xendit_payout_id"] == "disb_aff_xen"

    async def test_affiliate_payout_via_stripe_unchanged(self, cleanup_database):
        """Affiliate with payment_method='stripe' still uses Stripe."""
        from app.services.scheduler import process_affiliate_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            status="confirmed",
            check_in="2025-12-01", check_out="2025-12-05",
        )
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            """
            UPDATE affiliates
            SET status = 'approved', payment_method = 'stripe',
                stripe_connect_account_id = 'acct_aff_stripe',
                stripe_connect_onboarded = true
            WHERE id = $1
            """,
            aff["id"],
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'affiliate', $2, 75.0, 'EUR', '2026-01-15', 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(aff["id"]),
        )

        mock_now = datetime(2026, 2, 1, 2, 0, tzinfo=timezone.utc)
        with (
            patch("app.services.scheduler.datetime") as mock_dt,
            patch("app.services.stripe_service.create_transfer", new_callable=AsyncMock) as mock_stripe,
        ):
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_stripe.return_value = {"id": "tr_aff_stripe", "amount": 7500}
            await process_affiliate_payouts()

        mock_stripe.assert_called_once()

        updated = await Database.fetchrow(
            "SELECT status, stripe_transfer_id FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "completed"
        assert updated["stripe_transfer_id"] == "tr_aff_stripe"

    async def test_affiliate_payout_paypal_skipped(self, cleanup_database):
        """Affiliate with payment_method='paypal' is skipped for manual handling."""
        from app.services.scheduler import process_affiliate_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            status="confirmed",
            check_in="2025-12-01", check_out="2025-12-05",
        )
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            "UPDATE affiliates SET status = 'approved' WHERE id = $1", aff["id"]
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'affiliate', $2, 30.0, 'EUR', '2026-01-15', 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(aff["id"]),
        )

        mock_now = datetime(2026, 2, 1, 2, 0, tzinfo=timezone.utc)
        with patch("app.services.scheduler.datetime") as mock_dt:
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            await process_affiliate_payouts()

        # Payout should remain scheduled (skipped)
        updated = await Database.fetchrow(
            "SELECT status FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "scheduled"

    async def test_affiliate_payout_xendit_missing_details_skipped(self, cleanup_database):
        """Affiliate with xendit method but missing bank details is skipped."""
        from app.services.scheduler import process_affiliate_payouts

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]), str(room["id"]),
            status="confirmed",
            check_in="2025-12-01", check_out="2025-12-05",
        )
        aff = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            """
            UPDATE affiliates
            SET status = 'approved', payment_method = 'xendit'
            WHERE id = $1
            """,
            aff["id"],
        )

        payout = await Database.fetchrow(
            """
            INSERT INTO payouts (booking_id, recipient_type, recipient_id, amount, currency, scheduled_for, status)
            VALUES ($1, 'affiliate', $2, 40.0, 'IDR', '2026-01-15', 'scheduled')
            RETURNING *
            """,
            str(booking["id"]),
            str(aff["id"]),
        )

        mock_now = datetime(2026, 2, 1, 2, 0, tzinfo=timezone.utc)
        with patch("app.services.scheduler.datetime") as mock_dt:
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            await process_affiliate_payouts()

        updated = await Database.fetchrow(
            "SELECT status FROM payouts WHERE id = $1", payout["id"]
        )
        assert updated["status"] == "scheduled"
