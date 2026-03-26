from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import date, datetime

from app.models.utils import to_camel


class PromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    code: str
    discount_type: str
    discount_value: float
    valid_from: Optional[date] = None
    valid_until: Optional[date] = None
    is_active: bool
    max_uses: Optional[int] = None
    use_count: int
    created_at: Optional[datetime] = None


class CreatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: str
    discount_type: str = 'percentage'
    discount_value: float
    valid_from: Optional[date] = None
    valid_until: Optional[date] = None
    is_active: bool = True
    max_uses: Optional[int] = None


class UpdatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: Optional[str] = None
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    valid_from: Optional[date] = None
    valid_until: Optional[date] = None
    is_active: Optional[bool] = None
    max_uses: Optional[int] = None


class ValidatePromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    valid: bool
    code: str
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    message: str
