import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.dependencies import require_internal_key
from app.models.hotel import (
    AddonResponse,
    BankDetails,
    HotelResponse,
    PaymentSettingsResponse,
)
from app.models.promo_code import ValidatePromoCodeResponse
from app.models.utils import parse_json
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.promo_code_repo import PromoCodeRepository
from app.services.exchange_rate_service import get_rates
from app.services.hotel_service import (
    get_addons_by_hotel_slug,
    get_hotel_by_slug,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["hotels"])
exchange_router = APIRouter(prefix="/api", tags=["exchange-rates"])
resolve_router = APIRouter(prefix="/api", tags=["domain-resolution"])


class IncrementPromoResponse(BaseModel):
    ok: bool


class ExchangeRatesResponse(BaseModel):
    base: str
    rates: dict


class ResolveDomainResponse(BaseModel):
    slug: str


def _bank_details_complete(hotel: dict) -> bool:
    account_type = hotel.get("payout_account_type") or "iban"
    account_identifier = (
        hotel.get("payout_account_number")
        if account_type == "account_number"
        else hotel.get("payout_iban")
    )
    required = [
        hotel.get("payout_bank_name"),
        hotel.get("payout_account_holder"),
        account_identifier,
        hotel.get("payout_swift"),
    ]
    return all(bool(str(value or "").strip()) for value in required)


@router.get("/{slug}", response_model=HotelResponse)
async def get_hotel(slug: str, lang: str = "en"):
    hotel = await get_hotel_by_slug(slug, locale=lang)
    if hotel:
        return hotel
    # VAY-394: caller may be using a slug the property used before being
    # renamed. Redirect to the canonical so old confirmation-email links
    # and shared URLs keep working.
    renamed = await BookingHotelRepository.get_by_previous_slug(slug)
    if renamed:
        return RedirectResponse(
            url=f"/api/hotels/{renamed['slug']}?lang={lang}",
            status_code=301,
        )
    raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")


@router.get("/{slug}/addons", response_model=list[AddonResponse])
async def get_addons(slug: str):
    return await get_addons_by_hotel_slug(slug)


@router.get("/{slug}/payment-settings", response_model=PaymentSettingsResponse)
async def get_payment_settings(slug: str):
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")
    bank_transfer = bool(hotel.get("bank_transfer", False)) and _bank_details_complete(hotel)
    paypal_enabled = bool(hotel.get("paypal_enabled", False))
    return PaymentSettingsResponse(
        pay_at_property_enabled=hotel.get("pay_at_property_enabled", False),
        pay_at_hotel_methods=parse_json(
            hotel.get("pay_at_hotel_methods"), default=["cash", "card"]
        ),
        online_card_payment=hotel.get("online_card_payment", False),
        bank_transfer=bank_transfer,
        paypal_enabled=paypal_enabled,
        paypal_email=(hotel.get("paypal_email") or "") if paypal_enabled else "",
        paypal_payment_window_hours=(
            (hotel.get("paypal_payment_window_hours") or 24) if paypal_enabled else 24
        ),
        free_cancellation_days=hotel.get("free_cancellation_days", 7),
        special_requests_enabled=hotel.get("special_requests_enabled", True),
        arrival_time_enabled=hotel.get("arrival_time_enabled", False),
        guest_count_enabled=hotel.get("guest_count_enabled", False),
        terms_text=hotel.get("terms_text") or "",
        cancellation_policy_text=hotel.get("cancellation_policy_text") or "",
        bank_details=BankDetails(
            account_holder=hotel.get("payout_account_holder") or "",
            account_type=hotel.get("payout_account_type") or "iban",
            iban=hotel.get("payout_iban") or "",
            account_number=hotel.get("payout_account_number") or "",
            bank_name=hotel.get("payout_bank_name") or "",
            swift=hotel.get("payout_swift") or "",
        )
        if bank_transfer
        else None,
    )


@router.get("/{slug}/validate-promo", response_model=ValidatePromoCodeResponse)
async def validate_promo_code(slug: str, code: str = Query(...)):
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")

    promo = await PromoCodeRepository.get_by_code(code.upper(), str(hotel["id"]))
    if not promo:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="Invalid promo code"
        )

    if not promo["is_active"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code is no longer active"
        )

    today = date.today()
    if promo["valid_from"] and today < promo["valid_from"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code is not yet valid"
        )
    if promo["valid_until"] and today > promo["valid_until"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code has expired"
        )

    if promo["max_uses"] is not None and promo["use_count"] >= promo["max_uses"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code has reached its usage limit"
        )

    return ValidatePromoCodeResponse(
        valid=True,
        code=promo["code"],
        discount_type=promo["discount_type"],
        discount_value=float(promo["discount_value"]),
        message="Promo code applied successfully",
    )


@router.post(
    "/{slug}/increment-promo",
    response_model=IncrementPromoResponse,
    dependencies=[Depends(require_internal_key)],
)
async def increment_promo_usage(slug: str, code: str = Query(...)):
    """Server-to-server: pms-backend calls this when a booking that used a
    promo code is successfully created. Gated by INTERNAL_API_KEY when the
    operator opts into enforcement."""
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")
    promo = await PromoCodeRepository.get_by_code(code, str(hotel["id"]))
    if promo:
        await PromoCodeRepository.increment_use_count(str(promo["id"]))
    return IncrementPromoResponse(ok=True)


@exchange_router.get("/exchange-rates", response_model=ExchangeRatesResponse)
async def exchange_rates(base: str = Query(default="EUR")):
    rates = await get_rates(base)
    return ExchangeRatesResponse(base=base.upper(), rates=rates)


@resolve_router.get("/resolve-domain", response_model=ResolveDomainResponse)
async def resolve_domain(domain: str = Query(...)):
    """Resolve a custom domain to the hotel slug.

    Hostnames are case-insensitive per RFC 1035 §2.3.3, and custom_domain
    is stored lowercased on write — normalize the incoming host before
    the lookup so a stray uppercase ``Host`` header still resolves.
    """
    hotel = await BookingHotelRepository.get_by_custom_domain(domain.strip().lower())
    if not hotel:
        raise HTTPException(status_code=404, detail="No hotel found for this domain")
    return ResolveDomainResponse(slug=hotel["slug"])
