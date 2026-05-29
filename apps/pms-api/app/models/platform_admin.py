from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


PropertyStatus = Literal["live", "demo", "test"]
Granularity = Literal["daily", "weekly", "monthly"]


class PlatformProperty(CamelModel):
    id: str
    name: str
    slug: str
    status: PropertyStatus
    created_at: str


class MetricDelta(CamelModel):
    value: float | None
    label: str


class GrowthMetric(CamelModel):
    key: str
    label: str
    value: str
    raw_value: float | int | None
    delta: MetricDelta | None = None


class ChartPoint(CamelModel):
    key: str
    label: str
    value: int


class GrowthDashboardResponse(CamelModel):
    properties: list[PlatformProperty]
    selected_property_ids: list[str]
    exclude_test_data: bool
    granularity: Granularity
    booking_property_id: str | None = None
    metrics: list[GrowthMetric]
    page_views: list[ChartPoint]
    booking_requests: list[ChartPoint]
    live_properties: list[ChartPoint]
    empty_message: str | None = None


class UpdatePlatformPropertyStatusRequest(CamelModel):
    status: PropertyStatus = Field(..., description="Platform classification for analytics")
