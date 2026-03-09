import logging

from fastapi import APIRouter, Depends, Query
from app.dependencies import require_hotel_admin
from app.repositories.dashboard_repo import DashboardRepository
from app.models.dashboard import (
    StatsResponse,
    BookingsBySourceResponse,
    ConversionFunnelResponse,
    SparklineResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/dashboard/stats", response_model=StatsResponse)
async def get_dashboard_stats(
    range: str = Query("today", pattern="^(today|week|month)$"),
    user_id: str = Depends(require_hotel_admin),
):
    return await DashboardRepository.get_stats(user_id, range)


@router.get("/dashboard/bookings-by-source", response_model=BookingsBySourceResponse)
async def get_bookings_by_source(
    range: str = Query("month", pattern="^(today|week|month)$"),
    user_id: str = Depends(require_hotel_admin),
):
    return await DashboardRepository.get_bookings_by_source(user_id, range)


@router.get("/dashboard/conversion-funnel", response_model=ConversionFunnelResponse)
async def get_conversion_funnel(
    range: str = Query("month", pattern="^(today|week|month)$"),
    user_id: str = Depends(require_hotel_admin),
):
    return await DashboardRepository.get_conversion_funnel(user_id, range)


@router.get("/dashboard/sparklines", response_model=SparklineResponse)
async def get_sparklines(
    range: str = Query("today", pattern="^(today|week|month)$"),
    user_id: str = Depends(require_hotel_admin),
):
    return await DashboardRepository.get_sparklines(user_id, range)
