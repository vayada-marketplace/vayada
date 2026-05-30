from datetime import datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.checkin import to_camel

CheckoutInspectionStatus = Literal["ok", "issue", "neutral"]
CheckoutChargeStatus = Literal["pending", "paid", "waived"]


class CheckoutInspectionStep(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str = Field(default_factory=lambda: str(uuid4()))
    label: str = Field(max_length=120)
    ok_label: str = Field(default="OK", max_length=40)
    negative_label: str = Field(default="Issue", max_length=40)
    note_prompt: str = Field(default="Add details...", max_length=160)
    required: bool = True
    position: int = 0

    @field_validator("label", "ok_label", "negative_label", "note_prompt")
    @classmethod
    def validate_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Please complete every checkout inspection field.")
        return text


class CheckoutInspectionTemplateResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    steps: list[CheckoutInspectionStep] = []
    updated_at: str | None = None
    updated_by: str | None = None


class CheckoutInspectionTemplateUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    steps: list[CheckoutInspectionStep] = []

    @model_validator(mode="after")
    def normalize_steps(self):
        for idx, step in enumerate(self.steps):
            step.position = idx
        return self


class CheckoutInspectionResult(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    step_id: str
    label: str
    status: CheckoutInspectionStatus
    note: str | None = None
    completed_at: datetime | None = None


class BookingCheckoutComplete(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    inspection_results: list[CheckoutInspectionResult] = []
    pending_flags: list[dict] = []
    checkout_notes: str | None = None


class CheckoutChargeCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    label: str = Field(max_length=120)
    amount: float

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        label = value.strip()
        if not label:
            raise ValueError("Please add a label for this charge.")
        return label


class CheckoutChargeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    label: str
    amount: float
    original_amount: float
    status: CheckoutChargeStatus
    created_at: str
    settled_at: str | None = None
    waived_at: str | None = None


class CheckoutRecordResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    booking_id: str
    completed_at: str
    completed_by: str | None = None
    inspection_results: list[dict] = []
    charges_settled: list[dict] = []
    pending_flags: list[dict] = []
    checkout_notes: str | None = None
