from pydantic import BaseModel, ConfigDict

from app.models.utils import to_camel


class HotelContact(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    address: str
    phone: str
    email: str
    whatsapp: str | None = None


class HotelSocialLinks(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    facebook: str | None = None
    instagram: str | None = None
    tiktok: str | None = None
    youtube: str | None = None


class HotelBranding(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    primary_color: str
    accent_color: str | None = None
    font_pairing: str | None = None
    logo_url: str | None = None
    favicon_url: str | None = None


class PointOfInterest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    label: str
    travel_time: str
    color: str
    latitude: float
    longitude: float
    position: int = 0


class HotelResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    slug: str
    description: str
    location: str
    country: str
    star_rating: int
    currency: str
    supported_currencies: list[str] = []
    hero_image: str
    images: list[str]
    amenities: list[str]
    check_in_time: str
    check_out_time: str
    timezone: str = "UTC"
    contact: HotelContact
    social_links: HotelSocialLinks | None = None
    booking_filters: list[str] = []
    custom_filters: dict[str, str] = {}
    filter_rooms: dict[str, list[str]] = {}
    branding: HotelBranding | None = None
    default_language: str = "en"
    supported_languages: list[str] = ["en"]
    refer_a_guest_enabled: bool = False
    instant_book: bool = False
    map_view_enabled: bool = False
    show_room_detail_map: bool = False
    points_of_interest: list[PointOfInterest] = []


class BankDetails(BaseModel):
    """Payout bank details exposed to the guest at checkout when a hotel
    accepts bank-transfer payments."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    account_holder: str = ""
    account_type: str = "iban"
    iban: str = ""
    account_number: str = ""
    bank_name: str = ""
    swift: str = ""


class PaymentSettingsResponse(BaseModel):
    """Public payment-settings shape consumed by the booking-engine
    frontend at checkout — see GET /api/hotels/{slug}/payment-settings."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    pay_at_property_enabled: bool = False
    pay_at_hotel_methods: list[str] = []
    online_card_payment: bool = False
    bank_transfer: bool = False
    paypal_enabled: bool = False
    paypal_email: str = ""
    paypal_payment_window_hours: int = 24
    free_cancellation_days: int = 7
    special_requests_enabled: bool = True
    arrival_time_enabled: bool = False
    guest_count_enabled: bool = False
    terms_text: str = ""
    cancellation_policy_text: str = ""
    bank_details: BankDetails | None = None


# Re-export addon models for backwards compatibility
from app.models.addon import (  # noqa: E402, F401
    AddonResponse,
    AddonSettingsResponse,
    AddonSettingsUpdate,
    CreateAddonRequest,
    UpdateAddonRequest,
)
