"""
Tests for /api/hotels public endpoints — hotel details, addons, exchange rates.
"""

from unittest.mock import AsyncMock, patch


class TestGetHotel:
    async def test_get_hotel_found(self, client, hotel_with_property):
        hotel = hotel_with_property["hotel"]
        slug = hotel["slug"]
        resp = await client.get(f"/api/hotels/{slug}")
        assert resp.status_code == 200
        body = resp.json()
        # Verify camelCase keys from alias_generator
        assert body["starRating"] == hotel["star_rating"]
        assert body["heroImage"] == hotel["hero_image"]
        assert body["checkInTime"] == "15:00"
        assert body["checkOutTime"] == "11:00"
        assert body["contact"]["address"] == hotel["contact_address"]
        assert body["name"] == hotel["name"]

    async def test_get_hotel_not_found(self, client):
        resp = await client.get("/api/hotels/nonexistent-slug")
        assert resp.status_code == 404

    async def test_get_hotel_redirects_old_slug(self, client, hotel_with_property):
        """VAY-394: a slug the property used before being renamed must 301 to
        the canonical so booking-confirmation-email links keep working."""
        from app.database import Database

        hotel = hotel_with_property["hotel"]
        await Database.execute(
            "UPDATE booking_hotels SET previous_slugs = ARRAY['legacy-slug']::text[] WHERE id = $1",
            hotel["id"],
        )

        resp = await client.get("/api/hotels/legacy-slug", follow_redirects=False)
        assert resp.status_code == 301
        assert resp.headers["location"] == f"/api/hotels/{hotel['slug']}?lang=en"

    async def test_get_hotel_with_lang_param(self, client, hotel_with_property):
        hotel = hotel_with_property["hotel"]
        slug = hotel["slug"]
        # Request with German locale — no translation exists, should fall back to English
        resp = await client.get(f"/api/hotels/{slug}?lang=de")
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == hotel["name"]

    async def test_get_hotel_exposes_timezone(self, client, hotel_with_property):
        """timezone is exposed on the hotel response so the booking-engine
        frontend can do property-local date math (e.g. cancellation deadline
        comparison for VAY-370)."""
        hotel = hotel_with_property["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}")
        assert resp.status_code == 200
        body = resp.json()
        assert "timezone" in body
        assert body["timezone"] == hotel["timezone"]

    async def test_get_hotel_instant_book_default_false(self, client, hotel_with_property):
        """instantBook defaults to false and is exposed on the hotel response so
        the booking-engine frontend can branch its checkout copy.
        """
        hotel = hotel_with_property["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}")
        assert resp.status_code == 200
        assert resp.json()["instantBook"] is False

    async def test_get_hotel_instant_book_true(self, client, hotel_with_property):
        from app.database import Database

        hotel = hotel_with_property["hotel"]
        await Database.execute(
            "UPDATE booking_hotels SET instant_book = true WHERE id = $1", hotel["id"]
        )
        resp = await client.get(f"/api/hotels/{hotel['slug']}")
        assert resp.status_code == 200
        assert resp.json()["instantBook"] is True

    async def test_get_hotel_exposes_public_canonical_urls(self, client, hotel_with_property):
        from app.database import Database

        hotel = hotel_with_property["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["canonicalUrl"] == f"https://{hotel['slug']}.booking.vayada.com/en"
        assert body["bookingBaseUrl"] == f"https://{hotel['slug']}.booking.vayada.com"
        assert body["customDomainUrl"] is None

        await Database.execute(
            "UPDATE booking_hotels SET custom_domain = 'book.example.com' WHERE id = $1",
            hotel["id"],
        )
        with patch(
            "app.services.hotel_service.cloudflare_service.get_hostname_status",
            new=AsyncMock(return_value={"status": "active", "ssl_status": "active"}),
        ):
            custom_resp = await client.get(f"/api/hotels/{hotel['slug']}")
        assert custom_resp.status_code == 200
        custom_body = custom_resp.json()
        assert custom_body["canonicalUrl"] == "https://book.example.com/en"
        assert custom_body["bookingBaseUrl"] == "https://book.example.com"
        assert custom_body["customDomainUrl"] == "https://book.example.com"

    async def test_get_hotel_ignores_unverified_custom_domain(self, client, hotel_with_property):
        from app.database import Database

        hotel = hotel_with_property["hotel"]
        await Database.execute(
            "UPDATE booking_hotels SET custom_domain = 'pending.example.com' WHERE id = $1",
            hotel["id"],
        )

        with patch(
            "app.services.hotel_service.cloudflare_service.get_hostname_status",
            new=AsyncMock(return_value={"status": "pending", "ssl_status": "initializing"}),
        ):
            resp = await client.get(f"/api/hotels/{hotel['slug']}?lang=de")

        assert resp.status_code == 200
        body = resp.json()
        assert body["canonicalUrl"] == f"https://{hotel['slug']}.booking.vayada.com/de"
        assert body["bookingBaseUrl"] == f"https://{hotel['slug']}.booking.vayada.com"
        assert body["customDomainUrl"] is None

    async def test_resolve_domain_requires_verified_custom_domain(
        self, client, hotel_with_property
    ):
        from app.database import Database

        hotel = hotel_with_property["hotel"]
        await Database.execute(
            "UPDATE booking_hotels SET custom_domain = 'pending.example.com' WHERE id = $1",
            hotel["id"],
        )

        with patch(
            "app.services.hotel_service.cloudflare_service.get_hostname_status",
            new=AsyncMock(return_value={"status": "pending", "ssl_status": "initializing"}),
        ):
            pending_resp = await client.get("/api/resolve-domain?domain=pending.example.com")
        assert pending_resp.status_code == 404

        with patch(
            "app.services.hotel_service.cloudflare_service.get_hostname_status",
            new=AsyncMock(return_value={"status": "active", "ssl_status": "active"}),
        ):
            active_resp = await client.get("/api/resolve-domain?domain=pending.example.com")
        assert active_resp.status_code == 200
        assert active_resp.json() == {"slug": hotel["slug"]}


class TestGetAddons:
    async def test_get_addons_empty(self, client, hotel_with_property):
        hotel = hotel_with_property["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/addons")
        assert resp.status_code == 200
        assert resp.json() == []


class TestExchangeRates:
    async def test_exchange_rates_default(self, client):
        resp = await client.get("/api/exchange-rates")
        assert resp.status_code == 200
        body = resp.json()
        assert body["base"] == "EUR"
        assert "rates" in body
        assert isinstance(body["rates"], dict)

    async def test_exchange_rates_with_base(self, client):
        resp = await client.get("/api/exchange-rates?base=USD")
        assert resp.status_code == 200
        body = resp.json()
        assert body["base"] == "USD"
        assert "rates" in body
