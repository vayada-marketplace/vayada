from pydantic import BaseModel, ConfigDict
from typing import Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class BookingRequestResponse(BaseModel):
    """Booking + payment info returned after request creation."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    booking: dict
    client_secret: Optional[str] = None
    payment_method: str


class PaymentResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    amount: float
    currency: str
    status: str
    payment_method: str
    card_last_four: Optional[str] = None
    card_brand: Optional[str] = None
    created_at: str


class HotelPaymentSettings(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    stripe_connect_account_id: Optional[str] = None
    stripe_connect_onboarded: bool = False
    platform_fee_type: str = "percentage"
    platform_fee_value: float = 8.00
    platform_fee_with_affiliate: float = 2.00
    pay_at_property_enabled: bool = False
    payment_provider: str = "stripe"
    xendit_channel_code: Optional[str] = None
    xendit_account_number: Optional[str] = None
    xendit_account_holder_name: Optional[str] = None
    default_currency: str = "EUR"


class HotelPaymentSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    platform_fee_type: Optional[str] = None
    platform_fee_value: Optional[float] = None
    platform_fee_with_affiliate: Optional[float] = None
    pay_at_property_enabled: Optional[bool] = None
    payment_provider: Optional[str] = None
    xendit_channel_code: Optional[str] = None
    xendit_account_number: Optional[str] = None
    xendit_account_holder_name: Optional[str] = None
    default_currency: Optional[str] = None


class CancellationPolicy(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    free_cancellation_days: int = 7
    partial_refund_pct: float = 0.00


class CancellationPolicyUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    free_cancellation_days: Optional[int] = None
    partial_refund_pct: Optional[float] = None


class PayoutResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    booking_reference: Optional[str] = None
    recipient_type: str
    amount: float
    currency: str
    status: str
    scheduled_for: str
    completed_at: Optional[str] = None


class StripeConnectAccountRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    email: str
    country: str = "AT"


class XenditBankDetailsRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    channel_code: str
    account_number: str
    account_holder_name: str
