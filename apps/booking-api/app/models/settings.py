from pydantic import BaseModel
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
    email_notifications: bool
    new_booking_alerts: bool
    payment_alerts: bool
    weekly_reports: bool


class PropertySettingsUpdate(BaseModel):
    property_name: Optional[str] = None
    reservation_email: Optional[str] = None
    phone_number: Optional[str] = None
    whatsapp_number: Optional[str] = None
    address: Optional[str] = None
    timezone: Optional[str] = None
    default_currency: Optional[str] = None
    supported_currencies: Optional[list[str]] = None
    supported_languages: Optional[list[str]] = None
    email_notifications: Optional[bool] = None
    new_booking_alerts: Optional[bool] = None
    payment_alerts: Optional[bool] = None
    weekly_reports: Optional[bool] = None
