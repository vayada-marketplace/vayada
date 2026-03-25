from pydantic import BaseModel, ConfigDict
from typing import Optional


class PropertySettingsResponse(BaseModel):
    slug: str
    property_name: str
    reservation_email: str
    phone_number: str
    whatsapp_number: str
    address: str
    timezone: str
    default_currency: str
    supported_currencies: list[str]
    supported_languages: list[str]
    check_in_time: str
    check_out_time: str
    custom_domain: str | None
    pay_at_property_enabled: bool
    pay_at_hotel_methods: list[str]
    free_cancellation_days: int
    email_notifications: bool
    new_booking_alerts: bool
    payment_alerts: bool
    weekly_reports: bool
    refer_a_guest_enabled: bool
    instagram: str
    facebook: str
    twitter: str
    youtube: str
    billing_active_plan: str
    billing_commission_rate: float
    billing_fixed_fee: float
    billing_pending_switch: Optional[str]
    payout_account_holder: str
    payout_iban: str
    payout_bank_name: str
    payout_swift: str


class PropertySettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    property_name: Optional[str] = None
    reservation_email: Optional[str] = None
    phone_number: Optional[str] = None
    whatsapp_number: Optional[str] = None
    address: Optional[str] = None
    timezone: Optional[str] = None
    default_currency: Optional[str] = None
    supported_currencies: Optional[list[str]] = None
    supported_languages: Optional[list[str]] = None
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    custom_domain: Optional[str] = None
    pay_at_property_enabled: Optional[bool] = None
    pay_at_hotel_methods: Optional[list[str]] = None
    free_cancellation_days: Optional[int] = None
    email_notifications: Optional[bool] = None
    new_booking_alerts: Optional[bool] = None
    payment_alerts: Optional[bool] = None
    weekly_reports: Optional[bool] = None
    refer_a_guest_enabled: Optional[bool] = None
    instagram: Optional[str] = None
    facebook: Optional[str] = None
    twitter: Optional[str] = None
    youtube: Optional[str] = None
    billing_active_plan: Optional[str] = None
    billing_commission_rate: Optional[float] = None
    billing_fixed_fee: Optional[float] = None
    billing_pending_switch: Optional[str] = None
    payout_account_holder: Optional[str] = None
    payout_iban: Optional[str] = None
    payout_bank_name: Optional[str] = None
    payout_swift: Optional[str] = None
