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
    payment_method: str = "paypal"  # 'paypal' or 'bank'
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
    # Stats from LEFT JOIN
    booking_count: int = 0
    total_revenue: float = 0.0
    total_commission: float = 0.0


class AffiliateStatusUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    status: str  # 'approved', 'rejected', or 'suspended'


class AffiliateCommissionUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    commission_pct: float
