"""FIXED_PLAN_BILLING_MODE=frozen: legacy billing stops writing (VAY-1362)."""

from unittest.mock import AsyncMock, patch

import pytest
from app.config import Settings, settings
from app.routers import admin_payments
from app.services import fixed_plan_billing, stripe_service
from fastapi import HTTPException

HOTEL = "hotel-1"
ACTIVE = {
    "hotel_id": HOTEL,
    "stripe_billing_customer_id": "cus_fixed",
    "stripe_billing_subscription_id": "sub_fixed",
    "stripe_billing_status": "active",
    "stripe_billing_current_period_end": None,
    "stripe_billing_cancel_at_period_end": False,
}


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(settings, "FIXED_PLAN_BILLING_MODE", "frozen")


def test_mode_defaults_to_legacy_and_fails_closed_on_unknown_values(monkeypatch):
    monkeypatch.delenv("FIXED_PLAN_BILLING_MODE", raising=False)
    assert Settings(_env_file=None).fixed_plan_billing_mode() == "legacy"
    assert Settings(_env_file=None).fixed_plan_billing_frozen is False

    monkeypatch.setattr(settings, "FIXED_PLAN_BILLING_MODE", " Frozen ")
    assert settings.fixed_plan_billing_frozen is True

    monkeypatch.setattr(settings, "FIXED_PLAN_BILLING_MODE", "paused")
    with pytest.raises(ValueError, match="FIXED_PLAN_BILLING_MODE"):
        settings.fixed_plan_billing_mode()


async def test_frozen_checkout_and_cancel_refuse_before_any_stripe_call(frozen):
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=ACTIVE),
        ) as get_settings,
        patch.object(stripe_service, "create_fixed_plan_checkout", new=AsyncMock()) as checkout,
        patch.object(
            stripe_service, "cancel_billing_subscription_at_period_end", new=AsyncMock()
        ) as cancel,
    ):
        with pytest.raises(fixed_plan_billing.FixedPlanBillingFrozenError, match="support"):
            await fixed_plan_billing.create_checkout(HOTEL, "user-1")
        with pytest.raises(fixed_plan_billing.FixedPlanBillingFrozenError):
            await fixed_plan_billing.cancel_at_period_end(HOTEL)

    get_settings.assert_not_awaited()
    checkout.assert_not_awaited()
    cancel.assert_not_awaited()


async def test_frozen_routes_answer_409_with_a_clear_message(frozen):
    with patch.object(admin_payments, "get_hotel_id", new=AsyncMock(return_value=HOTEL)):
        with pytest.raises(HTTPException) as checkout:
            await admin_payments.create_fixed_plan_checkout(user_id="user-1")
        with pytest.raises(HTTPException) as cancel:
            await admin_payments.cancel_fixed_plan_subscription(user_id="user-1")

    assert checkout.value.status_code == 409
    assert cancel.value.status_code == 409
    assert "moving to the new platform" in checkout.value.detail
    assert cancel.value.detail == checkout.value.detail


async def test_frozen_status_is_read_only(frozen):
    quote = {
        "amount_cents": 3_000,
        "currency": "EUR",
        "room_count": 1,
        "config": {"billing_active_plan": "fixed"},
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=ACTIVE),
        ),
        patch.object(fixed_plan_billing, "fixed_plan_quote", new=AsyncMock(return_value=quote)),
        patch.object(fixed_plan_billing, "sync_subscription_price", new=AsyncMock()) as sync,
    ):
        status = await fixed_plan_billing.billing_status(HOTEL)

    sync.assert_not_awaited()
    assert status["plan"] == "fixed"
    assert status["status"] == "active"
    assert status["canManageBilling"] is True
    assert status["frozen"] is True


async def test_frozen_price_syncs_are_no_ops(frozen):
    with (
        patch.object(fixed_plan_billing.Database, "get_pool", new=AsyncMock()) as get_pool,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "list_fixed_plan_subscriptions",
            new=AsyncMock(return_value=[ACTIVE]),
        ) as list_subscriptions,
        patch.object(stripe_service, "update_fixed_plan_price", new=AsyncMock()) as update_price,
    ):
        await fixed_plan_billing.sync_subscription_price(ACTIVE)
        await fixed_plan_billing.sync_all_subscription_prices()
        await fixed_plan_billing.sync_subscription_price_for_hotel(HOTEL)

    get_pool.assert_not_awaited()
    list_subscriptions.assert_not_awaited()
    update_price.assert_not_awaited()


async def test_frozen_portal_keeps_working(frozen):
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=ACTIVE),
        ),
        patch.object(
            stripe_service,
            "create_billing_portal_session",
            new=AsyncMock(return_value="https://billing.stripe.test/portal"),
        ) as portal,
    ):
        url = await fixed_plan_billing.create_portal(HOTEL)

    assert url == "https://billing.stripe.test/portal"
    portal.assert_awaited_once()


ADOPTED_SUBSCRIPTION = {
    "id": "sub_fixed",
    "customer_id": "cus_fixed",
    "metadata": {
        "hotel_id": HOTEL,
        "vayada_payment_kind": "fixed_plan",
        "vayada_legacy_adoption": "v1",
    },
    "status": "past_due",
    "cancel_at_period_end": False,
    "current_period_end": 1_800_000_000,
    "item_id": "si_fixed",
    "product_id": "prod_fixed",
    "unit_amount": 3_000,
}


async def test_unfrozen_legacy_never_writes_a_target_adopted_subscription():
    """Defence in depth: a redeploy that drops the frozen mode leaves adopted hotels alone."""
    assert settings.fixed_plan_billing_frozen is False
    upsert = AsyncMock()
    with (
        patch.object(
            stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=ADOPTED_SUBSCRIPTION),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_billing_subscription_id",
            new=AsyncMock(return_value=ACTIVE),
        ),
        patch.object(fixed_plan_billing.HotelPaymentSettingsRepository, "upsert", new=upsert),
        patch.object(
            fixed_plan_billing.hotel_identity_service, "set_billing_plan", new=AsyncMock()
        ) as set_plan,
    ):
        await fixed_plan_billing.activate_subscription(HOTEL, "sub_fixed")
        assert await fixed_plan_billing.update_subscription_state("sub_fixed") is None

    upsert.assert_not_awaited()
    set_plan.assert_not_awaited()


async def test_unfrozen_price_sync_skips_a_target_adopted_subscription():
    dirty = {
        **ACTIVE,
        "stripe_billing_subscription_item_id": "si_fixed",
        "stripe_billing_product_id": "prod_fixed",
        "stripe_billing_room_count": 1,
        "stripe_billing_amount_cents": 3_000,
        "stripe_billing_price_version": 4,
    }
    quote = {"amount_cents": 3_500, "currency": "EUR", "room_count": 2, "config": {}}
    with (
        patch.object(fixed_plan_billing, "fixed_plan_quote", new=AsyncMock(return_value=quote)),
        patch.object(
            stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=ADOPTED_SUBSCRIPTION),
        ),
        patch.object(stripe_service, "update_fixed_plan_price", new=AsyncMock()) as update_price,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "complete_billing_price_sync",
            new=AsyncMock(),
        ) as complete,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository, "upsert", new=AsyncMock()
        ) as upsert,
    ):
        await fixed_plan_billing._sync_subscription_price_locked(dirty)

    update_price.assert_not_awaited()
    upsert.assert_not_awaited()
    complete.assert_awaited_once_with(HOTEL, 4)
