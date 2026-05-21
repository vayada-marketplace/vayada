"""Tests for the canonical-hotel-name read path used by booking emails.

Covers ``hotel_identity_service.get_name`` and
``BookingRepository.get_by_id`` / ``lookup`` which overlay the canonical
name onto the JOIN'd local copy. The bug that motivated these (VAY-393)
was: a hotel renamed in booking_db kept showing its old name in
confirmation emails because pms.hotels.name was never resynced.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.repositories.booking_repo import BookingRepository
from app.services import hotel_identity_service


class TestGetName:
    async def test_returns_name_when_row_present(self):
        with patch("app.services.hotel_identity_service.app_settings") as mock_settings, \
             patch("app.services.hotel_identity_service.BookingEngineDatabase.fetchval",
                   new=AsyncMock(return_value="Tiga Lombok")):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await hotel_identity_service.get_name("hotel-123")
        assert result == "Tiga Lombok"

    async def test_returns_none_when_row_missing(self):
        with patch("app.services.hotel_identity_service.app_settings") as mock_settings, \
             patch("app.services.hotel_identity_service.BookingEngineDatabase.fetchval",
                   new=AsyncMock(return_value=None)):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await hotel_identity_service.get_name("missing-hotel")
        assert result is None

    async def test_returns_none_when_be_db_unconfigured(self):
        with patch("app.services.hotel_identity_service.app_settings") as mock_settings:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = ""
            result = await hotel_identity_service.get_name("hotel-123")
        assert result is None

    async def test_returns_none_and_logs_on_db_error(self):
        with patch("app.services.hotel_identity_service.app_settings") as mock_settings, \
             patch("app.services.hotel_identity_service.BookingEngineDatabase.fetchval",
                   new=AsyncMock(side_effect=RuntimeError("connection refused"))), \
             patch("app.services.hotel_identity_service.logger") as mock_logger:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await hotel_identity_service.get_name("broken-hotel")
        assert result is None
        mock_logger.warning.assert_called_once()
        assert "broken-hotel" in str(mock_logger.warning.call_args)

    async def test_empty_string_treated_as_missing(self):
        with patch("app.services.hotel_identity_service.app_settings") as mock_settings, \
             patch("app.services.hotel_identity_service.BookingEngineDatabase.fetchval",
                   new=AsyncMock(return_value="")):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await hotel_identity_service.get_name("hotel-123")
        assert result is None


class TestBookingRepoCanonicalNameOverlay:
    """``get_by_id`` and ``lookup`` should prefer the booking_db name
    over the JOIN'd ``pms.hotels.name`` so a renamed property doesn't
    leak the old name into confirmation emails."""

    @staticmethod
    def _row(hotel_name: str) -> dict:
        return {
            "id": "booking-1",
            "hotel_id": "hotel-1",
            "hotel_name": hotel_name,
            "hotel_slug": "tiga-lombok",
            "guest_email": "g@example.com",
            "booking_reference": "VAY-ABC123",
        }

    async def test_get_by_id_overlays_canonical_name(self):
        stale_row = self._row("Villa Sava")
        with patch("app.repositories.booking_repo.Database.fetchrow",
                   new=AsyncMock(return_value=stale_row)), \
             patch("app.repositories.booking_repo.hotel_identity_service.get_name",
                   new=AsyncMock(return_value="Tiga Lombok")):
            result = await BookingRepository.get_by_id("booking-1")
        assert result["hotel_name"] == "Tiga Lombok"

    async def test_get_by_id_falls_back_when_canonical_missing(self):
        stale_row = self._row("Villa Sava")
        with patch("app.repositories.booking_repo.Database.fetchrow",
                   new=AsyncMock(return_value=stale_row)), \
             patch("app.repositories.booking_repo.hotel_identity_service.get_name",
                   new=AsyncMock(return_value=None)):
            result = await BookingRepository.get_by_id("booking-1")
        assert result["hotel_name"] == "Villa Sava"

    async def test_get_by_id_returns_none_when_no_booking(self):
        with patch("app.repositories.booking_repo.Database.fetchrow",
                   new=AsyncMock(return_value=None)), \
             patch("app.repositories.booking_repo.hotel_identity_service.get_name",
                   new=AsyncMock()) as mock_get_name:
            result = await BookingRepository.get_by_id("missing")
        assert result is None
        mock_get_name.assert_not_called()

    async def test_lookup_overlays_canonical_name(self):
        stale_row = self._row("Villa Sava")
        with patch("app.repositories.booking_repo.Database.fetchrow",
                   new=AsyncMock(return_value=stale_row)), \
             patch("app.repositories.booking_repo.hotel_identity_service.get_name",
                   new=AsyncMock(return_value="Tiga Lombok")):
            result = await BookingRepository.lookup("VAY-ABC123", "g@example.com")
        assert result["hotel_name"] == "Tiga Lombok"
