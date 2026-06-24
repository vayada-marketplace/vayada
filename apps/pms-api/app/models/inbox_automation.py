from datetime import datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


TemplateCategory = Literal["pre_arrival", "in_stay", "post_stay", "general"]
TriggerEvent = Literal["before_check_in", "day_of_check_in", "after_check_out", "day_of_check_out"]
AutomationAudience = Literal["all", "direct", "ota", "booking.com", "airbnb"]
DeliveryChannel = Literal["smart", "ota_only", "email_only"]


class MessageTemplate(_Camel):
    id: str
    name: str
    category: str
    icon: str
    content: str
    is_default: bool = False
    sort_order: int = 0
    created_at: datetime
    updated_at: datetime


class MessageTemplateCreate(_Camel):
    name: str
    category: TemplateCategory = "general"
    icon: str = "chat"
    content: str = ""
    sort_order: int = 0


class MessageTemplateUpdate(_Camel):
    name: str | None = None
    category: TemplateCategory | None = None
    icon: str | None = None
    content: str | None = None
    sort_order: int | None = None


class TemplateListResponse(_Camel):
    templates: list[MessageTemplate]


class TemplateRenderResponse(_Camel):
    content: str
    variables: dict[str, str]


class GuestAutomation(_Camel):
    id: str
    template_id: str | None = None
    template_name: str | None = None
    name: str
    icon: str
    description: str
    trigger_event: str
    days_offset: int
    send_time: time
    audience: str
    delivery_channel: str
    is_active: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime


class GuestAutomationCreate(_Camel):
    template_id: str | None = None
    name: str
    icon: str = "calendar"
    description: str = ""
    trigger_event: TriggerEvent = "before_check_in"
    days_offset: int = 1
    send_time: time = time(10, 0)
    audience: AutomationAudience = "all"
    delivery_channel: DeliveryChannel = "smart"
    is_active: bool = True
    sort_order: int = 0


class GuestAutomationUpdate(_Camel):
    template_id: str | None = None
    name: str | None = None
    icon: str | None = None
    description: str | None = None
    trigger_event: TriggerEvent | None = None
    days_offset: int | None = None
    send_time: time | None = None
    audience: AutomationAudience | None = None
    delivery_channel: DeliveryChannel | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class AutomationListResponse(_Camel):
    automations: list[GuestAutomation]


class VariablePreviewResponse(_Camel):
    variables: dict[str, str]
