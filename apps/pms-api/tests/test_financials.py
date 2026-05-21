"""
Tests for the PMS Financials section (admin_financials router).

Covers:
- Listing invoices with status filter + counts.
- Invoice detail endpoint.
- Recording manual payments and the resulting status transitions
  (sent → partial → paid).
- Summary aggregation (revenue MTD + outstanding + overdue count).
"""

from datetime import date, datetime, timedelta, timezone

from tests.conftest import (
    create_test_booking,
    create_test_booking_with_payment,
    create_test_hotel,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


class TestListInvoices:
    async def test_lists_invoice_for_each_booking(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            guest_email="alice@example.com",
            status="confirmed",
        )

        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert len(body["invoices"]) == 1
        invoice = body["invoices"][0]
        assert invoice["invoiceNumber"].startswith("INV-")
        assert invoice["guestEmail"] == "alice@example.com"
        assert invoice["balanceDue"] == invoice["totalAmount"]
        assert invoice["status"] in {"sent", "overdue", "draft"}

    async def test_status_filter_and_counts(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            guest_email="confirmed@example.com",
            status="confirmed",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-09-01",
            check_out="2026-09-05",
            guest_email="pending@example.com",
            status="pending",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-10-01",
            check_out="2026-10-05",
            guest_email="cancelled@example.com",
            status="cancelled",
        )

        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        counts = body["counts"]
        assert counts["draft"] == 1
        assert counts["voided"] == 1
        assert counts["sent"] + counts["overdue"] == 1

        resp_voided = await client.get(
            "/admin/financials/invoices?status=voided",
            headers=get_auth_headers(user["token"]),
        )
        assert resp_voided.status_code == 200
        body_voided = resp_voided.json()
        assert body_voided["total"] == 1
        assert body_voided["invoices"][0]["status"] == "voided"

    async def test_other_hotels_invoices_are_isolated(self, client, cleanup_database):
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        room_a = await create_test_room_type(str(hotel_a["id"]))
        await create_test_booking(
            str(hotel_a["id"]),
            str(room_a["id"]),
            guest_email="hotel-a@example.com",
        )

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        # user_b has their own hotel but no bookings, so the list is empty.
        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 0


class TestInvoiceDetail:
    async def test_returns_charges_and_totals(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            nightly_rate=200.0,
            status="confirmed",
        )

        resp = await client.get(
            f"/admin/financials/invoices/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["nights"] == 4
        assert body["totalAmount"] == 800.0
        assert body["amountPaid"] == 0
        assert body["balanceDue"] == 800.0
        assert len(body["charges"]) == 1
        assert body["charges"][0]["amount"] == 800.0


class TestRecordPayment:
    async def test_partial_then_full_payment_status_transitions(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            nightly_rate=250.0,
            status="confirmed",
            payment_method="pay_at_property",
            payment_status="unpaid",
        )

        # Partial payment
        resp = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 400.0, "paymentMethod": "cash", "reference": "till-1"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["amountPaid"] == 400.0
        assert body["balanceDue"] == 600.0
        assert body["status"] == "partial"
        assert len(body["payments"]) == 1
        assert body["payments"][0]["method"] == "cash"
        assert body["payments"][0]["reference"] == "till-1"

        # Final payment closes the invoice
        resp2 = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 600.0, "paymentMethod": "bank_transfer"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 201
        body2 = resp2.json()
        assert body2["amountPaid"] == 1000.0
        assert body2["balanceDue"] == 0
        assert body2["status"] == "paid"
        assert len(body2["payments"]) == 2

        # Recording extra now is a 400.
        resp3 = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 1.0, "paymentMethod": "cash"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp3.status_code == 400

    async def test_overpayment_is_rejected(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            nightly_rate=100.0,
            status="confirmed",
        )
        resp = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 999999.0, "paymentMethod": "cash"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400


class TestSummary:
    async def test_aggregates_revenue_and_outstanding(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        # Future stay, no payment yet → counts toward outstanding.
        future_start = (date.today() + timedelta(days=30)).isoformat()
        future_end = (date.today() + timedelta(days=33)).isoformat()
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=200.0,
            status="confirmed",
        )
        # Past stay, also unpaid → overdue.
        past_start = (date.today() - timedelta(days=30)).isoformat()
        past_end = (date.today() - timedelta(days=27)).isoformat()
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=past_start,
            check_out=past_end,
            nightly_rate=300.0,
            status="confirmed",
            guest_email="past@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # 200 × 3 + 300 × 3 = 1500 outstanding
        assert body["outstanding"] == 1500.0
        assert body["overdueCount"] == 1
        assert body["currency"] == "EUR"

    async def test_pending_bookings_excluded_from_summary(self, client, cleanup_database):
        """Pending booking requests (host hasn't accepted yet) must not
        contribute to revenue, outstanding, or overdue counts — VAY-334.

        Their `total_amount` already includes addon/upsell revenue at
        creation time, so counting them would show revenue for stays
        that may still expire or be rejected.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        future_start = (date.today() + timedelta(days=30)).isoformat()
        future_end = (date.today() + timedelta(days=33)).isoformat()
        # Confirmed → contributes 200 × 3 = 600 to revenue/outstanding.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=200.0,
            status="confirmed",
            guest_email="confirmed@example.com",
        )
        # Pending → must NOT contribute, even though total_amount is set.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=500.0,
            status="pending",
            guest_email="pending@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["revenueMtd"] == 600.0
        assert body["outstanding"] == 600.0
        assert body["overdueCount"] == 0
