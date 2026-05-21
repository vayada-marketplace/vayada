import logging

from fastapi import APIRouter, Depends, Query

from app.dependencies import require_current_hotel
from app.models.dashboard import (
    BookingsBySourceResponse,
    ConversionFunnelResponse,
    PageViewsTimelineResponse,
    SparklineResponse,
    StatsResponse,
)
from app.repositories.dashboard_repo import DashboardRepository

logger = logging.getLogger(__name__)

router = APIRouter()


# All four dashboard endpoints scope by the currently-selected hotel
# (X-Hotel-Id header) instead of WHERE user_id LIMIT 1. Without this,
# a user with multiple properties would always see stats for whichever
# hotel happened to come back first in an unordered query.


@router.get("/dashboard/stats", response_model=StatsResponse)
async def get_dashboard_stats(
    range: str = Query("today", pattern="^(today|week|month)$"),
    hotel: dict = Depends(require_current_hotel),
):
    return await DashboardRepository.get_stats(hotel, range)


@router.get("/dashboard/bookings-by-source", response_model=BookingsBySourceResponse)
async def get_bookings_by_source(
    range: str = Query("month", pattern="^(today|week|month)$"),
    hotel: dict = Depends(require_current_hotel),
):
    return await DashboardRepository.get_bookings_by_source(hotel, range)


@router.get("/dashboard/conversion-funnel", response_model=ConversionFunnelResponse)
async def get_conversion_funnel(
    range: str = Query("month", pattern="^(today|week|month)$"),
    hotel: dict = Depends(require_current_hotel),
):
    return await DashboardRepository.get_conversion_funnel(hotel, range)


@router.get("/dashboard/sparklines", response_model=SparklineResponse)
async def get_sparklines(
    range: str = Query("today", pattern="^(today|week|month)$"),
    hotel: dict = Depends(require_current_hotel),
):
    return await DashboardRepository.get_sparklines(hotel, range)


@router.get("/dashboard/page-views", response_model=PageViewsTimelineResponse)
async def get_page_views_timeline(
    week_offset: int = Query(0, ge=0, le=520),
    hotel: dict = Depends(require_current_hotel),
):
    return await DashboardRepository.get_page_views_timeline(hotel, week_offset)
