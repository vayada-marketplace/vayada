"""
Tests for /api/hotels public endpoints — hotel details, addons, exchange rates.
"""


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

    async def test_get_hotel_with_lang_param(self, client, hotel_with_property):
        hotel = hotel_with_property["hotel"]
        slug = hotel["slug"]
        # Request with German locale — no translation exists, should fall back to English
        resp = await client.get(f"/api/hotels/{slug}?lang=de")
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == hotel["name"]

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
