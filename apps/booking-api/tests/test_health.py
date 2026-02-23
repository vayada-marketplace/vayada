"""
Tests for health endpoints.
"""


class TestHealth:
    async def test_root(self, client):
        resp = await client.get("/")
        assert resp.status_code == 200
        body = resp.json()
        assert "message" in body
        assert "Vayada" in body["message"]

    async def test_health(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["service"] == "vayada-booking-engine"

    async def test_health_db(self, client):
        resp = await client.get("/health/db")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["database"]["connected"] is True
