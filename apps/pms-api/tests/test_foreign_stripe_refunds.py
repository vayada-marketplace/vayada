"""Refunds the new API makes on the shared connected accounts are not this service's (VAY-2205)."""

from unittest.mock import AsyncMock, patch

import pytest


async def _post_refund_event(client, refund: dict, event_type: str = "refund.updated"):
    with patch("app.services.stripe_service.construct_webhook_event") as construct_event:
        construct_event.return_value = {"type": event_type, "data": {"object": refund}}
        return await client.post(
            "/webhooks/stripe/connect",
            content=b"{}",
            headers={"stripe-signature": "test"},
        )


@pytest.mark.parametrize(
    "refund",
    [
        # Marked by the new API.
        {
            "id": "re_v2_marked",
            "status": "succeeded",
            "payment_intent": "pi_v2_marked",
            "metadata": {"vayada_source": "pricing_v2"},
        },
        # A payment intent this service never took.
        {"id": "re_v2_unknown", "status": "pending", "payment_intent": "pi_v2_unknown"},
    ],
)
async def test_foreign_refund_events_are_acknowledged_without_reconciling(client, refund):
    with patch(
        "app.services.booking_service.reconcile_stripe_refund_event", new_callable=AsyncMock
    ) as reconcile:
        response = await _post_refund_event(client, refund)

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok"}
    reconcile.assert_not_awaited()


async def test_refunds_of_legacy_payments_are_still_reconciled(client):
    refund = {"id": "re_legacy_pending", "status": "pending", "payment_intent": "pi_legacy"}
    with (
        patch(
            "app.repositories.payment_repo.PaymentRepository.get_by_stripe_pi",
            new_callable=AsyncMock,
            return_value={"id": "payment_1"},
        ),
        patch(
            "app.services.booking_service.reconcile_stripe_refund_event",
            new_callable=AsyncMock,
            return_value={"id": "payment_1"},
        ) as reconcile,
    ):
        response = await _post_refund_event(client, refund, "refund.created")

    assert response.status_code == 200, response.text
    reconcile.assert_awaited_once()
    # A legacy payment's refund without its prepared command still fails loudly, as before.
    with (
        patch(
            "app.repositories.payment_repo.PaymentRepository.get_by_stripe_pi",
            new_callable=AsyncMock,
            return_value={"id": "payment_1"},
        ),
        pytest.raises(RuntimeError, match="no prepared payment command"),
    ):
        await _post_refund_event(client, refund, "refund.created")
