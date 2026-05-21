from pydantic import BaseModel


class StatsResponse(BaseModel):
    revenue: float
    revenue_previous: float
    bookings: int
    bookings_previous: int
    avg_nightly_rate: float
    avg_nightly_rate_previous: float
    page_views: int
    page_views_previous: int
    next_arrival: str | None = None
    live_since: str | None = None


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


class PageViewBucket(BaseModel):
    date: str
    count: int


class PageViewsTimelineResponse(BaseModel):
    window_start: str
    window_end: str
    previous_window_start: str
    previous_window_end: str
    buckets: list[PageViewBucket]
    previous_buckets: list[PageViewBucket]
    total: int
    previous_total: int
    has_previous_data: bool
