"""
Tests for health endpoint.
"""

from app.main import app
from httpx import ASGITransport, AsyncClient


class TestHealth:
    async def test_health_endpoint(self):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["service"] == "pms"
        assert body["scheduler"] == {
            "enabled": True,
            "running": False,
            "configuration_valid": True,
            "active_job_count": 9,
            "frozen_job_count": 0,
            "unknown_job_count": 0,
        }
        assert "active_jobs" not in body["scheduler"]
        assert "jobs" not in body["scheduler"]
