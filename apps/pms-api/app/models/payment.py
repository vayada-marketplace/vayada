from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class BookingRequestResponse(BaseModel):
    """Booking + payment info returned after request creation."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    booking: dict
    client_secret: str | None = None
    payment_method: str


class PaymentResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    amount: float
    currency: str
    status: str
    payment_method: str
    card_last_four: str | None = None
    card_brand: str | None = None
    created_at: str


class HotelPaymentSettings(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    stripe_connect_account_id: str | None = None
    stripe_connect_onboarded: bool = False
    platform_fee_type: str = "percentage"
    platform_fee_value: float = 8.00
    platform_fee_with_affiliate: float = 2.00
    pay_at_property_enabled: bool = False
    online_card_payment: bool = False
    bank_transfer: bool = False
    xendit_payments_enabled: bool = False
    payment_provider: str = "stripe"
    xendit_channel_code: str | None = None
    xendit_account_number: str | None = None
    xendit_account_holder_name: str | None = None
    default_currency: str = "EUR"


VALID_XENDIT_CHANNEL_CODES = {
    "ID_BCA",
    "ID_MANDIRI",
    "ID_BNI",
    "ID_BRI",
    "ID_PERMATA",
    "ID_CIMB",
}


class HotelPaymentSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    platform_fee_type: Literal["percentage", "flat"] | None = None
    platform_fee_value: float | None = None
    platform_fee_with_affiliate: float | None = None
    pay_at_property_enabled: bool | None = None
    online_card_payment: bool | None = None
    bank_transfer: bool | None = None
    xendit_payments_enabled: bool | None = None
    payment_provider: Literal["stripe", "xendit", "vayada"] | None = None
    xendit_channel_code: str | None = None
    xendit_account_number: str | None = None
    xendit_account_holder_name: str | None = None
    default_currency: str | None = None

    @field_validator("xendit_channel_code")
    @classmethod
    def validate_channel_code(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_XENDIT_CHANNEL_CODES:
            raise ValueError(
                f"Invalid channel code. Must be one of: {', '.join(sorted(VALID_XENDIT_CHANNEL_CODES))}"
            )
        return v


class CancellationPolicy(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    free_cancellation_days: int = 7
    partial_refund_pct: float = 0.00


class PaymentSettingsResponse(BaseModel):
    """Wrapper for GET /admin/payment-settings: payment settings + cancellation policy."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payment_settings: HotelPaymentSettings
    cancellation_policy: CancellationPolicy


class CancellationPolicyUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    free_cancellation_days: int | None = None
    partial_refund_pct: float | None = None


class PayoutResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    booking_reference: str | None = None
    recipient_type: str
    amount: float
    currency: str
    status: str
    scheduled_for: str
    completed_at: str | None = None


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
            raise ValueError(
                f"Invalid channel code. Must be one of: {', '.join(sorted(VALID_XENDIT_CHANNEL_CODES))}"
            )
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
