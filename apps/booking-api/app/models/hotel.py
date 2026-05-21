from pydantic import BaseModel, ConfigDict
from typing import Dict, Optional, List

from app.models.utils import to_camel


class HotelContact(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    address: str
    phone: str
    email: str
    whatsapp: Optional[str] = None


class HotelSocialLinks(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    facebook: Optional[str] = None
    instagram: Optional[str] = None
    tiktok: Optional[str] = None
    youtube: Optional[str] = None


class HotelBranding(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    primary_color: str
    accent_color: Optional[str] = None
    font_pairing: Optional[str] = None
    logo_url: Optional[str] = None
    favicon_url: Optional[str] = None


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
    supported_currencies: List[str] = []
    hero_image: str
    images: List[str]
    amenities: List[str]
    check_in_time: str
    check_out_time: str
    timezone: str = "UTC"
    contact: HotelContact
    social_links: Optional[HotelSocialLinks] = None
    booking_filters: List[str] = []
    custom_filters: Dict[str, str] = {}
    filter_rooms: Dict[str, List[str]] = {}
    branding: Optional[HotelBranding] = None
    default_language: str = "en"
    supported_languages: List[str] = ["en"]
    refer_a_guest_enabled: bool = False
    instant_book: bool = False


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
    pay_at_hotel_methods: List[str] = []
    online_card_payment: bool = False
    bank_transfer: bool = False
    free_cancellation_days: int = 7
    special_requests_enabled: bool = True
    arrival_time_enabled: bool = False
    guest_count_enabled: bool = False
    terms_text: str = ""
    cancellation_policy_text: str = ""
    bank_details: Optional[BankDetails] = None


# Re-export addon models for backwards compatibility
from app.models.addon import (  # noqa: E402, F401
    AddonResponse,
    CreateAddonRequest,
    UpdateAddonRequest,
    AddonSettingsResponse,
    AddonSettingsUpdate,
)
