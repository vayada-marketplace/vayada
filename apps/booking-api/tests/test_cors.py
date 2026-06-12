"""CORS coverage for browser-facing booking API origins."""

from app.main import app
from httpx import ASGITransport, AsyncClient


async def cors_preflight(origin: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.options(
            "/api/hotels/hotel-alpenrose",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "content-type",
            },
        )


class TestCors:
    async def test_allows_explicit_custom_domain_booking_origin(self):
        resp = await cors_preflight("https://booking.tigalombok.com")

        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == "https://booking.tigalombok.com"
        assert resp.headers["access-control-allow-credentials"] == "true"

    async def test_rejects_unconfigured_credentialed_origin(self):
        resp = await cors_preflight("https://evil.example.com")

        assert resp.status_code == 400
        assert "access-control-allow-origin" not in resp.headers
