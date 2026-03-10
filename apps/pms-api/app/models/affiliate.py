from pydantic import BaseModel, ConfigDict, EmailStr
from typing import Optional


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class AffiliateRegister(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    full_name: str
    email: EmailStr
    social_media: str = ""
    user_type: str = "guest"  # 'guest' or 'creator'
    payment_method: str = "stripe"  # 'stripe', 'paypal', or 'bank'
    paypal_email: str = ""
    bank_iban: str = ""


class AffiliateResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    referral_code: str
    full_name: str
    email: str
    social_media: str
    user_type: str
    payment_method: str
    paypal_email: str
    bank_iban: str
    commission_pct: float
    status: str
    created_at: str


class AffiliateAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    referral_code: str
    full_name: str
    email: str
    social_media: str
    user_type: str
    payment_method: str
    paypal_email: str
    bank_iban: str
    commission_pct: float
    status: str
    created_at: str
    updated_at: str
    stripe_connect_account_id: Optional[str] = None
    stripe_connect_onboarded: bool = False
    xendit_channel_code: Optional[str] = None
    xendit_account_number: Optional[str] = None
    xendit_account_holder_name: Optional[str] = None
    # Stats from LEFT JOIN
    booking_count: int = 0
    total_revenue: float = 0.0
    total_commission: float = 0.0
    click_count: int = 0
    conversion_rate: float = 0.0


class AffiliateStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'approved', 'rejected', or 'suspended'


class AffiliateCommissionUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    commission_pct: float
