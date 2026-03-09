from pydantic import BaseModel
from typing import Optional


class StatsResponse(BaseModel):
    revenue: float
    revenue_previous: float
    bookings: int
    bookings_previous: int
    avg_nightly_rate: float
    avg_nightly_rate_previous: float
    page_views: int
    page_views_previous: int
    next_arrival: Optional[str] = None
    live_since: Optional[str] = None


class SourceBreakdown(BaseModel):
    source: str
    revenue: float
    percentage: float
    count: int


class BookingsBySourceResponse(BaseModel):
    total_revenue: float
    sources: list[SourceBreakdown]


class FunnelStep(BaseModel):
    label: str
    value: int
    percentage: float


class ConversionFunnelResponse(BaseModel):
    steps: list[FunnelStep]


class SparklineResponse(BaseModel):
    revenue: list[float]
    bookings: list[int]
    avg_rate: list[float]
    page_views: list[int]
