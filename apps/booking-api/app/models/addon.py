from pydantic import BaseModel, ConfigDict
from typing import Optional

from app.models.utils import to_camel


class AddonResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    description: str
    price: float
    currency: str
    category: str
    image: str
    duration: Optional[str] = None
    per_person: Optional[bool] = None


class CreateAddonRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    description: str = ''
    price: float
    currency: str = 'EUR'
    category: str = 'experience'
    image: str = ''
    duration: Optional[str] = None
    per_person: Optional[bool] = None


class UpdateAddonRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    category: Optional[str] = None
    image: Optional[str] = None
    duration: Optional[str] = None
    per_person: Optional[bool] = None


class AddonSettingsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    show_addons_step: bool = True
    group_addons_by_category: bool = True


class AddonSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    show_addons_step: Optional[bool] = None
    group_addons_by_category: Optional[bool] = None
