from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models.utils import to_camel


class PromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    code: str
    discount_type: str
    discount_value: float
    valid_from: date | None = None
    valid_until: date | None = None
    is_active: bool
    max_uses: int | None = None
    use_count: int
    created_at: datetime | None = None


class CreatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: str
    discount_type: str = "percentage"
    discount_value: float
    valid_from: date | None = None
    valid_until: date | None = None
    is_active: bool = True
    max_uses: int | None = None


class UpdatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: str | None = None
    discount_type: str | None = None
    discount_value: float | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    is_active: bool | None = None
    max_uses: int | None = None


class ValidatePromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    valid: bool
    code: str
    discount_type: str | None = None
    discount_value: float | None = None
    message: str
