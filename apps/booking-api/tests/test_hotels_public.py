"""
Tests for /api/hotels public endpoints — hotel details, rooms, addons, exchange rates.
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


class TestGetRooms:
    async def test_get_rooms_empty(self, client, hotel_with_property):
        hotel = hotel_with_property["hotel"]
        resp = await client.get(f"/api/hotels/{hotel['slug']}/rooms")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_get_rooms_nonexistent_slug(self, client):
        resp = await client.get("/api/hotels/nonexistent-slug/rooms")
        assert resp.status_code == 200
        assert resp.json() == []


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
