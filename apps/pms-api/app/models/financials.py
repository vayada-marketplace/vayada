from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


InvoiceStatus = Literal["draft", "sent", "paid", "partial", "overdue", "voided"]

ManualPaymentMethod = Literal["cash", "bank_transfer", "manual_card", "other"]


class InvoiceListItem(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    invoice_number: str
    booking_id: str
    booking_reference: str
    guest_first_name: str
    guest_last_name: str
    guest_email: str
    check_in: str
    check_out: str
    room_number: str | None = None
    room_name: str
    currency: str
    total_amount: float
    amount_paid: float
    balance_due: float
    status: InvoiceStatus
    issued_at: str


class InvoiceListResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    invoices: list[InvoiceListItem]
    total: int
    counts: dict[str, int]
    limit: int
    offset: int


class InvoiceCharge(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    description: str
    detail: str
    amount: float


class InvoicePayment(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    method: str
    method_label: str
    amount: float
    currency: str
    reference: str | None = None
    status: str
    recorded_at: str


class InvoiceDetail(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    invoice_number: str
    booking_id: str
    booking_reference: str
    guest_first_name: str
    guest_last_name: str
    guest_email: str
    guest_phone: str
    room_number: str | None = None
    room_name: str
    check_in: str
    check_out: str
    nights: int
    currency: str
    charges: list[InvoiceCharge]
    subtotal: float
    total_amount: float
    payments: list[InvoicePayment]
    amount_paid: float
    balance_due: float
    status: InvoiceStatus
    issued_at: str


class RecordPaymentRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    amount: float = Field(gt=0)
    payment_method: ManualPaymentMethod
    reference: str | None = None

    @field_validator("reference")
    @classmethod
    def trim_reference(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None


class FinancialsSummary(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    revenue_mtd: float
    revenue_mtd_delta_pct: float | None = None
    outstanding: float
    overdue_count: int
    currency: str


class PaymentLedgerEntry(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    invoice_number: str
    booking_id: str
    booking_reference: str
    guest_first_name: str
    guest_last_name: str
    method: str
    method_label: str
    amount: float
    currency: str
    reference: str | None = None
    status: str
    recorded_at: str


class PaymentLedgerResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payments: list[PaymentLedgerEntry]
    total: int
    limit: int
    offset: int
