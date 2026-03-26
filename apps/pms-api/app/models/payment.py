from pydantic import BaseModel, ConfigDict, field_validator
from typing import Literal, Optional


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


VALID_XENDIT_CHANNEL_CODES = {
    "ID_BCA", "ID_MANDIRI", "ID_BNI", "ID_BRI", "ID_PERMATA", "ID_CIMB",
}


class HotelPaymentSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    platform_fee_type: Optional[Literal["percentage", "flat"]] = None
    platform_fee_value: Optional[float] = None
    platform_fee_with_affiliate: Optional[float] = None
    pay_at_property_enabled: Optional[bool] = None
    payment_provider: Optional[Literal["stripe", "xendit"]] = None
    xendit_channel_code: Optional[str] = None
    xendit_account_number: Optional[str] = None
    xendit_account_holder_name: Optional[str] = None
    default_currency: Optional[str] = None

    @field_validator("xendit_channel_code")
    @classmethod
    def validate_channel_code(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_XENDIT_CHANNEL_CODES:
            raise ValueError(f"Invalid channel code. Must be one of: {', '.join(sorted(VALID_XENDIT_CHANNEL_CODES))}")
        return v


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

    @field_validator("channel_code")
    @classmethod
    def validate_channel_code(cls, v: str) -> str:
        if v not in VALID_XENDIT_CHANNEL_CODES:
            raise ValueError(f"Invalid channel code. Must be one of: {', '.join(sorted(VALID_XENDIT_CHANNEL_CODES))}")
        return v

    @field_validator("account_number")
    @classmethod
    def validate_account_number(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Account number is required")
        if not v.isdigit():
            raise ValueError("Account number must contain only digits")
        if len(v) < 5 or len(v) > 20:
            raise ValueError("Account number must be between 5 and 20 digits")
        return v

    @field_validator("account_holder_name")
    @classmethod
    def validate_account_holder_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Account holder name is required")
        if len(v) > 100:
            raise ValueError("Account holder name must be 100 characters or fewer")
        return v
