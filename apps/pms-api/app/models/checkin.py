from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


ChecklistStepType = Literal["checkbox", "text", "amount"]


class ChecklistStep(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str = Field(default_factory=lambda: str(uuid4()))
    label: str = Field(max_length=120)
    type: ChecklistStepType = "checkbox"
    required: bool = False
    system: bool = False
    position: int = 0

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        label = value.strip()
        if not label:
            raise ValueError("Please add a label for this step.")
        return label


class ChecklistTemplateResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    steps: list[ChecklistStep] = []
    updated_at: str | None = None
    updated_by: str | None = None


class ChecklistTemplateUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    steps: list[ChecklistStep] = []

    @model_validator(mode="after")
    def normalize_steps(self):
        for idx, step in enumerate(self.steps):
            step.system = False
            step.position = idx
        return self


class CheckinStepResult(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    step_id: str
    label: str
    type: ChecklistStepType
    value: Any = None
    completed_at: str | None = None


class CheckinPendingFlag(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    step_id: str
    label: str
