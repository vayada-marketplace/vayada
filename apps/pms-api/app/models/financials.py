from datetime import datetime
from typing import Dict, List, Literal, Optional

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
    room_number: Optional[str] = None
    room_name: str
    currency: str
    total_amount: float
    amount_paid: float
    balance_due: float
    status: InvoiceStatus
    issued_at: str


class InvoiceListResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    invoices: List[InvoiceListItem]
    total: int
    counts: Dict[str, int]
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
    reference: Optional[str] = None
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
    room_number: Optional[str] = None
    room_name: str
    check_in: str
    check_out: str
    nights: int
    currency: str
    charges: List[InvoiceCharge]
    subtotal: float
    total_amount: float
    payments: List[InvoicePayment]
    amount_paid: float
    balance_due: float
    status: InvoiceStatus
    issued_at: str


class RecordPaymentRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    amount: float = Field(gt=0)
    payment_method: ManualPaymentMethod
    reference: Optional[str] = None

    @field_validator("reference")
    @classmethod
    def trim_reference(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        return v or None


class FinancialsSummary(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    revenue_mtd: float
    revenue_mtd_delta_pct: Optional[float] = None
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
    reference: Optional[str] = None
    status: str
    recorded_at: str


class PaymentLedgerResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    payments: List[PaymentLedgerEntry]
    total: int
    limit: int
    offset: int
