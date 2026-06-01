import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

MODULE_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class ModuleActivation(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    module_id: str
    is_active: bool
    activated_at: datetime | None = None
    deactivated_at: datetime | None = None
    updated_at: datetime


class ModuleActivationsResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    hotel_id: str
    active_modules: list[str]
    activations: list[ModuleActivation]


class ModuleActivationUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    module_id: str = Field(min_length=1, max_length=64)
    is_active: bool

    @field_validator("module_id")
    @classmethod
    def validate_module_id(cls, value: str) -> str:
        if not MODULE_ID_PATTERN.fullmatch(value):
            raise ValueError("moduleId must be kebab-case")
        return value
