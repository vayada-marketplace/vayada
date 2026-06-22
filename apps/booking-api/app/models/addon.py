from pydantic import BaseModel, ConfigDict

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
    duration: str | None = None
    per_person: bool | None = None
    per_night: bool | None = None
    location: str = ""
    max_guests: str = ""
    highlights: list[str] = []
    included_items: list[str] = []


class CreateAddonRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    description: str = ""
    price: float
    currency: str = "EUR"
    category: str = "experience"
    image: str = ""
    duration: str | None = None
    per_person: bool | None = None
    per_night: bool | None = None
    location: str | None = None
    max_guests: str | None = None
    highlights: list[str] | None = None
    included_items: list[str] | None = None


class UpdateAddonRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str | None = None
    description: str | None = None
    price: float | None = None
    currency: str | None = None
    category: str | None = None
    image: str | None = None
    duration: str | None = None
    per_person: bool | None = None
    per_night: bool | None = None
    location: str | None = None
    max_guests: str | None = None
    highlights: list[str] | None = None
    included_items: list[str] | None = None


class AddonReorderRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    ordered_addon_ids: list[str]


class AddonSettingsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    show_addons_step: bool = True
    group_addons_by_category: bool = True


class AddonSettingsUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    show_addons_step: bool | None = None
    group_addons_by_category: bool | None = None
