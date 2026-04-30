from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from decimal import Decimal


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


# ── Room type mapping ────────────────────────────────────────────────

class ChannexRoomTypeMappingResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    room_type_id: str
    room_type_name: Optional[str] = None
    channex_room_type_id: str
    created_at: str


# ── Rate plan mapping ────────────────────────────────────────────────

class ChannexRatePlanMappingResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    room_type_id: str
    channex_rate_plan_id: str
    channex_room_type_id: str
    sell_mode: str
    plan_name: str = "standard"
    channel: str = "direct"
    meal_plan_code: int = 0
    created_at: str


# ── Booking mapping ──────────────────────────────────────────────────

class ChannexBookingMappingResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    booking_id: str
    channex_booking_id: str
    channel_source: str
    last_synced_at: Optional[str] = None
    created_at: str


# ── Sync status ──────────────────────────────────────────────────────

class ChannexSyncStatusResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    is_connected: bool
    channex_property_id: Optional[str] = None
    room_types_provisioned: int = 0
    rate_plans_provisioned: int = 0
    last_booking_sync_at: Optional[str] = None
    last_ari_sync_at: Optional[str] = None


# ── Channel markups ──────────────────────────────────────────────────

class ChannelMarkup(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    channel: str
    markup_pct: Decimal = Field(ge=-50, le=200)


class ChannelMarkupsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    markups: List[ChannelMarkup]


class ChannelMarkupsUpdateRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    markups: List[ChannelMarkup]


# ── Connected channels ───────────────────────────────────────────────

class ConnectedChannel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    # Normalized internal key: "booking.com", "airbnb", "expedia", or "other"
    key: str
    # Raw Channex application code (e.g. "BookingCom", "Airbnb")
    application: str
    title: Optional[str] = None
    is_active: bool = True


class ConnectedChannelsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    channels: List[ConnectedChannel]
