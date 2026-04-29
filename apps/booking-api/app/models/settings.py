from pydantic import BaseModel, ConfigDict
from typing import Optional


class PropertySettingsResponse(BaseModel):
    # booking_hotels.id — the canonical hotel identifier. After the
    # multi-hotel-ids migration this is the same UUID as the PMS
    # hotels.id for this property. Clients use it for the
    # X-Hotel-Id header and for passing to POST /admin/register-hotel.
    id: Optional[str] = None
    slug: str
    property_name: str
    reservation_email: str
    phone_number: str
    whatsapp_number: str
    address: str
    timezone: str
    default_currency: str
    default_language: str
    supported_currencies: list[str]
    supported_languages: list[str]
    check_in_time: str
    check_out_time: str
    check_in_from: str = ''
    check_in_until: str = ''
    check_out_from: str = ''
    check_out_until: str = ''
    custom_domain: str | None
    pay_at_property_enabled: bool
    pay_at_hotel_methods: list[str]
    online_card_payment: bool
    bank_transfer: bool
    free_cancellation_days: int
    email_notifications: bool
    new_booking_alerts: bool
    payment_alerts: bool
    weekly_reports: bool
    refer_a_guest_enabled: bool
    special_requests_enabled: bool
    arrival_time_enabled: bool
    guest_count_enabled: bool
    instagram: str
    facebook: str
    tiktok: str
    youtube: str
    billing_active_plan: str
    billing_commission_rate: float
    billing_fixed_fee: float
    billing_pending_switch: Optional[str]
    billing_switch_effective_date: Optional[str] = None
    # Per-source platform fees (read-only for the hotel; Vayada admin owns these).
    booking_engine_fee_pct: float = 2.0
    channel_manager_fee_pct: float = 3.0
    affiliate_platform_fee_pct: float = 2.0
    # Live room count + projected Fixed-plan fee at that count.
    active_room_count: int = 0
    fixed_plan_projected_monthly_fee: float = 0.0
    payout_account_holder: str
    payout_account_type: str
    payout_iban: str
    payout_account_number: str
    payout_bank_name: str
    payout_swift: str
    terms_text: str = ''
    cancellation_policy_text: str = ''


class PropertySettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    property_name: Optional[str] = None
    reservation_email: Optional[str] = None
    phone_number: Optional[str] = None
    whatsapp_number: Optional[str] = None
    address: Optional[str] = None
    timezone: Optional[str] = None
    default_currency: Optional[str] = None
    default_language: Optional[str] = None
    supported_currencies: Optional[list[str]] = None
    supported_languages: Optional[list[str]] = None
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    check_in_from: Optional[str] = None
    check_in_until: Optional[str] = None
    check_out_from: Optional[str] = None
    check_out_until: Optional[str] = None
    custom_domain: Optional[str] = None
    pay_at_property_enabled: Optional[bool] = None
    pay_at_hotel_methods: Optional[list[str]] = None
    online_card_payment: Optional[bool] = None
    bank_transfer: Optional[bool] = None
    free_cancellation_days: Optional[int] = None
    email_notifications: Optional[bool] = None
    new_booking_alerts: Optional[bool] = None
    payment_alerts: Optional[bool] = None
    weekly_reports: Optional[bool] = None
    refer_a_guest_enabled: Optional[bool] = None
    special_requests_enabled: Optional[bool] = None
    arrival_time_enabled: Optional[bool] = None
    guest_count_enabled: Optional[bool] = None
    instagram: Optional[str] = None
    facebook: Optional[str] = None
    tiktok: Optional[str] = None
    youtube: Optional[str] = None
    # billing_active_plan is intentionally not exposed here: the active plan
    # only flips via the pending-switch flow (see _apply_pending_plan_switch_if_due).
    # Direct PATCH would bypass the scheduled effective date.
    billing_commission_rate: Optional[float] = None
    billing_fixed_fee: Optional[float] = None
    billing_pending_switch: Optional[str] = None
    payout_account_holder: Optional[str] = None
    payout_account_type: Optional[str] = None
    payout_iban: Optional[str] = None
    payout_account_number: Optional[str] = None
    payout_bank_name: Optional[str] = None
    payout_swift: Optional[str] = None
    terms_text: Optional[str] = None
    cancellation_policy_text: Optional[str] = None
