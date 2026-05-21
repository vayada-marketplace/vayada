from pydantic import BaseModel


class DesignSettingsResponse(BaseModel):
    hero_image: str
    hero_heading: str
    hero_subtext: str
    primary_color: str
    accent_color: str
    font_pairing: str
    booking_filters: list[str] = []
    custom_filters: dict[str, str] = {}
    filter_rooms: dict[str, list[str]] = {}


class DesignSettingsUpdate(BaseModel):
    hero_image: str | None = None
    hero_heading: str | None = None
    hero_subtext: str | None = None
    primary_color: str | None = None
    accent_color: str | None = None
    font_pairing: str | None = None
    booking_filters: list[str] | None = None
    custom_filters: dict[str, str] | None = None
    filter_rooms: dict[str, list[str]] | None = None
