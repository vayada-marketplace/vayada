import logging
from datetime import date
from typing import Any

import asyncpg
from fastapi import APIRouter, HTTPException, Depends, status
from app.dependencies import require_hotel_admin, get_current_hotel
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.settings import (
    PropertySettingsResponse,
    PropertySettingsUpdate,
    hotel_default,
)
from app.models.utils import parse_json, slugify
from app.services.billing_service import (
    apply_pending_plan_switch_if_due,
    compute_fixed_plan_projected_fee,
    count_active_rooms,
    schedule_pending_plan_switch,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Property settings ──────────────────────────────────────────────

_PROPERTY_FIELD_MAP = {
    "property_name": "name",
    "reservation_email": "contact_email",
    "phone_number": "contact_phone",
    "whatsapp_number": "contact_whatsapp",
    "address": "contact_address",
    "timezone": "timezone",
    "default_currency": "currency",
    "default_language": "default_language",
    "supported_currencies": "supported_currencies",
    "supported_languages": "supported_languages",
    "check_in_time": "check_in_time",
    "check_out_time": "check_out_time",
    "check_in_from": "check_in_from",
    "check_in_until": "check_in_until",
    "check_out_from": "check_out_from",
    "check_out_until": "check_out_until",
    "custom_domain": "custom_domain",
    "pay_at_property_enabled": "pay_at_property_enabled",
    "pay_at_hotel_methods": "pay_at_hotel_methods",
    "online_card_payment": "online_card_payment",
    "bank_transfer": "bank_transfer",
    "free_cancellation_days": "free_cancellation_days",
    "email_notifications": "email_notifications",
    "new_booking_alerts": "new_booking_alerts",
    "payment_alerts": "payment_alerts",
    "weekly_reports": "weekly_reports",
    "special_requests_enabled": "special_requests_enabled",
    "arrival_time_enabled": "arrival_time_enabled",
    "guest_count_enabled": "guest_count_enabled",
    "instagram": "social_instagram",
    "facebook": "social_facebook",
    "tiktok": "social_tiktok",
    "youtube": "social_youtube",
    # billing_active_plan deliberately omitted — it flips via the pending-switch
    # flow only (see billing_service.apply_pending_plan_switch_if_due), never via PATCH.
    "billing_commission_rate": "billing_commission_rate",
    "billing_fixed_fee": "billing_fixed_fee",
    "billing_pending_switch": "billing_pending_switch",
    "payout_account_holder": "payout_account_holder",
    "payout_account_type": "payout_account_type",
    "payout_iban": "payout_iban",
    "payout_account_number": "payout_account_number",
    "payout_bank_name": "payout_bank_name",
    "payout_swift": "payout_swift",
    "refer_a_guest_enabled": "refer_a_guest_enabled",
    "terms_text": "terms_text",
    "cancellation_policy_text": "cancellation_policy_text",
}


def _coalesce(hotel: dict, column: str) -> Any:
    """Read ``column`` from a hotel row, falling back to the centralized
    default in HOTEL_FIELD_DEFAULTS (or '' for unmapped string columns)."""
    val = hotel.get(column)
    if val is None:
        return hotel_default(column)
    return val


async def _hotel_to_property_settings(hotel: dict) -> PropertySettingsResponse:
    hotel_id = str(hotel.get('id')) if hotel.get('id') else None
    if hotel_id:
        room_count = await count_active_rooms(hotel_id)
    else:
        room_count = 0
    fixed_base = float(_coalesce(hotel, 'fixed_base_fee'))
    rooms_included = int(_coalesce(hotel, 'fixed_rooms_included'))
    per_extra = float(_coalesce(hotel, 'fixed_per_extra_room_fee'))
    projected_fee = compute_fixed_plan_projected_fee(
        fixed_base, rooms_included, per_extra, room_count
    )
    return PropertySettingsResponse(
        id=hotel_id,
        slug=_coalesce(hotel, 'slug'),
        property_name=_coalesce(hotel, 'name'),
        reservation_email=_coalesce(hotel, 'contact_email'),
        phone_number=_coalesce(hotel, 'contact_phone'),
        whatsapp_number=_coalesce(hotel, 'contact_whatsapp'),
        address=_coalesce(hotel, 'contact_address'),
        timezone=_coalesce(hotel, 'timezone'),
        default_currency=_coalesce(hotel, 'currency'),
        default_language=_coalesce(hotel, 'default_language'),
        supported_currencies=parse_json(hotel.get('supported_currencies'), default=hotel_default('supported_currencies')),
        supported_languages=parse_json(hotel.get('supported_languages'), default=hotel_default('supported_languages')),
        check_in_time=_coalesce(hotel, 'check_in_time'),
        check_out_time=_coalesce(hotel, 'check_out_time'),
        check_in_from=_coalesce(hotel, 'check_in_from'),
        check_in_until=_coalesce(hotel, 'check_in_until'),
        check_out_from=_coalesce(hotel, 'check_out_from'),
        check_out_until=_coalesce(hotel, 'check_out_until'),
        custom_domain=hotel.get('custom_domain'),
        pay_at_property_enabled=_coalesce(hotel, 'pay_at_property_enabled'),
        pay_at_hotel_methods=parse_json(hotel.get('pay_at_hotel_methods'), default=hotel_default('pay_at_hotel_methods')),
        online_card_payment=_coalesce(hotel, 'online_card_payment'),
        bank_transfer=_coalesce(hotel, 'bank_transfer'),
        free_cancellation_days=_coalesce(hotel, 'free_cancellation_days'),
        email_notifications=_coalesce(hotel, 'email_notifications'),
        new_booking_alerts=_coalesce(hotel, 'new_booking_alerts'),
        payment_alerts=_coalesce(hotel, 'payment_alerts'),
        weekly_reports=_coalesce(hotel, 'weekly_reports'),
        refer_a_guest_enabled=_coalesce(hotel, 'refer_a_guest_enabled'),
        special_requests_enabled=_coalesce(hotel, 'special_requests_enabled'),
        arrival_time_enabled=_coalesce(hotel, 'arrival_time_enabled'),
        guest_count_enabled=_coalesce(hotel, 'guest_count_enabled'),
        instagram=_coalesce(hotel, 'social_instagram'),
        facebook=_coalesce(hotel, 'social_facebook'),
        tiktok=_coalesce(hotel, 'social_tiktok'),
        youtube=_coalesce(hotel, 'social_youtube'),
        billing_active_plan=_coalesce(hotel, 'billing_active_plan'),
        billing_commission_rate=float(_coalesce(hotel, 'billing_commission_rate')),
        billing_fixed_fee=float(_coalesce(hotel, 'billing_fixed_fee')),
        billing_pending_switch=hotel.get('billing_pending_switch'),
        billing_switch_effective_date=(
            hotel['billing_switch_effective_date'].isoformat()
            if hotel.get('billing_switch_effective_date')
            else None
        ),
        booking_engine_fee_pct=float(_coalesce(hotel, 'booking_engine_fee_pct')),
        channel_manager_fee_pct=float(_coalesce(hotel, 'channel_manager_fee_pct')),
        affiliate_platform_fee_pct=float(_coalesce(hotel, 'affiliate_platform_fee_pct')),
        active_room_count=room_count,
        fixed_plan_projected_monthly_fee=projected_fee,
        payout_account_holder=_coalesce(hotel, 'payout_account_holder'),
        payout_account_type=_coalesce(hotel, 'payout_account_type'),
        payout_iban=_coalesce(hotel, 'payout_iban'),
        payout_account_number=_coalesce(hotel, 'payout_account_number'),
        payout_bank_name=_coalesce(hotel, 'payout_bank_name'),
        payout_swift=_coalesce(hotel, 'payout_swift'),
        terms_text=_coalesce(hotel, 'terms_text'),
        cancellation_policy_text=_coalesce(hotel, 'cancellation_policy_text'),
    )


# Zero-state response for users who haven't created a hotel yet. Built
# from an empty dict so every field flows through the same default
# pipeline as a real row would (no risk of drift).
async def _build_default_property_settings() -> PropertySettingsResponse:
    return await _hotel_to_property_settings({})


@router.get("/settings/property", response_model=PropertySettingsResponse)
async def get_property_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        return await _build_default_property_settings()
    await apply_pending_plan_switch_if_due(str(hotel["id"]))
    full_hotel = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    return await _hotel_to_property_settings(full_hotel)


def _api_to_db_value(api_value, db_column: str):
    """Pull from a PropertySettingsUpdate field into the matching DB
    column, falling back to ``HOTEL_FIELD_DEFAULTS`` when the API value is
    None. Defaults live in one place; new fields just need an entry there."""
    if api_value is not None:
        return api_value
    return hotel_default(db_column)


async def _create_hotel_from_settings(
    data: PropertySettingsUpdate,
    user_id: str,
) -> dict:
    """Create a new booking_hotels row from a PropertySettingsUpdate payload.

    Raises HTTPException(409) on slug collision. Used by both the
    explicit POST /admin/hotels endpoint (multi-hotel-safe) and the
    legacy auto-create branch in PATCH /admin/settings/property.
    """
    name = data.property_name or ''
    slug = slugify(name) if name else f"hotel-{user_id[:8]}"
    try:
        return await BookingHotelRepository.create(
            name=name,
            slug=slug,
            contact_email=data.reservation_email or '',
            contact_phone=data.phone_number or '',
            timezone=_api_to_db_value(data.timezone, 'timezone'),
            currency=_api_to_db_value(data.default_currency, 'currency'),
            default_language=_api_to_db_value(data.default_language, 'default_language'),
            supported_languages=_api_to_db_value(data.supported_languages, 'supported_languages'),
            user_id=user_id,
            supported_currencies=_api_to_db_value(data.supported_currencies, 'supported_currencies'),
            contact_whatsapp=data.whatsapp_number or '',
            contact_address=data.address or '',
            check_in_time=_api_to_db_value(data.check_in_time, 'check_in_time'),
            check_out_time=_api_to_db_value(data.check_out_time, 'check_out_time'),
            check_in_from=data.check_in_from or '',
            check_in_until=data.check_in_until or '',
            check_out_from=data.check_out_from or '',
            check_out_until=data.check_out_until or '',
            pay_at_property_enabled=_api_to_db_value(data.pay_at_property_enabled, 'pay_at_property_enabled'),
            online_card_payment=_api_to_db_value(data.online_card_payment, 'online_card_payment'),
            bank_transfer=_api_to_db_value(data.bank_transfer, 'bank_transfer'),
            free_cancellation_days=_api_to_db_value(data.free_cancellation_days, 'free_cancellation_days'),
            email_notifications=_api_to_db_value(data.email_notifications, 'email_notifications'),
            new_booking_alerts=_api_to_db_value(data.new_booking_alerts, 'new_booking_alerts'),
            payment_alerts=_api_to_db_value(data.payment_alerts, 'payment_alerts'),
            weekly_reports=_api_to_db_value(data.weekly_reports, 'weekly_reports'),
            special_requests_enabled=_api_to_db_value(data.special_requests_enabled, 'special_requests_enabled'),
            arrival_time_enabled=_api_to_db_value(data.arrival_time_enabled, 'arrival_time_enabled'),
            guest_count_enabled=_api_to_db_value(data.guest_count_enabled, 'guest_count_enabled'),
            refer_a_guest_enabled=_api_to_db_value(data.refer_a_guest_enabled, 'refer_a_guest_enabled'),
            social_instagram=data.instagram or '',
            social_facebook=data.facebook or '',
            social_tiktok=data.tiktok or '',
            social_youtube=data.youtube or '',
            payout_account_holder=data.payout_account_holder or '',
            payout_account_type=_api_to_db_value(data.payout_account_type, 'payout_account_type'),
            payout_iban=data.payout_iban or '',
            payout_account_number=data.payout_account_number or '',
            payout_bank_name=data.payout_bank_name or '',
            payout_swift=data.payout_swift or '',
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A property with this name already exists. Please choose a different name.",
        )


@router.post("/hotels", response_model=PropertySettingsResponse, status_code=status.HTTP_201_CREATED)
async def create_hotel(
    data: PropertySettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    """Explicitly create a new property for the authenticated user.

    This is the multi-hotel-safe creation path used by the setup
    wizard when adding a new property. Unlike PATCH /settings/property
    (which auto-creates only when no current hotel is selected and
    silently updates the existing one otherwise), this endpoint
    always creates a new booking_hotels row and returns its id so
    the caller can then pass that id to the PMS register-hotel
    endpoint and to X-Hotel-Id headers going forward.
    """
    try:
        result = await _create_hotel_from_settings(data, user_id)
        return await _hotel_to_property_settings(result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create hotel: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create property. Please try again.",
        )


@router.patch("/settings/property", response_model=PropertySettingsResponse)
async def update_property_settings(
    data: PropertySettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if hotel:
        updates = {}
        for api_field, db_col in _PROPERTY_FIELD_MAP.items():
            value = getattr(data, api_field)
            if value is not None:
                updates[db_col] = value

        schedule_pending_plan_switch(updates, date.today())

        if updates:
            try:
                result = await BookingHotelRepository.partial_update(str(hotel["id"]), updates)
            except asyncpg.UniqueViolationError:
                # Slug or other UNIQUE collision — surface as 409 instead of 500.
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A property with this name or slug already exists. Please choose a different value.",
                )
        else:
            result = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    else:
        # Legacy auto-create branch: only reachable when the user
        # has no hotels at all (otherwise get_current_hotel would
        # have returned one). New callers should use the explicit
        # POST /admin/hotels endpoint above.
        result = await _create_hotel_from_settings(data, user_id)

    return await _hotel_to_property_settings(result)


