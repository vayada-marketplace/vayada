import logging
from typing import List
from fastapi import APIRouter, HTTPException, Query
from app.models.hotel import HotelResponse, RoomTypeResponse, AddonResponse
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.services.hotel_service import (
    get_hotel_by_slug,
    get_rooms_by_hotel_slug,
    get_addons_by_hotel_slug,
)
from app.services.exchange_rate_service import get_rates

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["hotels"])
exchange_router = APIRouter(prefix="/api", tags=["exchange-rates"])
resolve_router = APIRouter(prefix="/api", tags=["domain-resolution"])


@router.get("/{slug}", response_model=HotelResponse)
async def get_hotel(slug: str, lang: str = "en"):
    hotel = await get_hotel_by_slug(slug, locale=lang)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")
    return hotel


@router.get("/{slug}/rooms", response_model=List[RoomTypeResponse])
async def get_rooms(slug: str):
    return await get_rooms_by_hotel_slug(slug)


@router.get("/{slug}/addons", response_model=List[AddonResponse])
async def get_addons(slug: str):
    return await get_addons_by_hotel_slug(slug)


@router.get("/{slug}/payment-settings")
async def get_payment_settings(slug: str):
    from app.repositories.booking_hotel_repo import BookingHotelRepository
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")
    from app.models.utils import parse_json
    return {
        "payAtPropertyEnabled": hotel.get("pay_at_property_enabled", False),
        "payAtHotelMethods": parse_json(hotel.get("pay_at_hotel_methods"), default=["cash", "card"]),
        "freeCancellationDays": hotel.get("free_cancellation_days", 7),
        "specialRequestsEnabled": hotel.get("special_requests_enabled", True),
        "arrivalTimeEnabled": hotel.get("arrival_time_enabled", False),
        "guestCountEnabled": hotel.get("guest_count_enabled", False),
    }


@router.get("/{slug}/validate-promo")
async def validate_promo_code(slug: str, code: str = Query(...)):
    from app.repositories.promo_code_repo import PromoCodeRepository
    from datetime import date

    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")

    promo = await PromoCodeRepository.get_by_code(code.upper(), str(hotel["id"]))
    if not promo:
        return {"valid": False, "code": code.upper(), "message": "Invalid promo code"}

    if not promo["is_active"]:
        return {"valid": False, "code": code.upper(), "message": "This promo code is no longer active"}

    today = date.today()
    if promo["valid_from"] and today < promo["valid_from"]:
        return {"valid": False, "code": code.upper(), "message": "This promo code is not yet valid"}
    if promo["valid_until"] and today > promo["valid_until"]:
        return {"valid": False, "code": code.upper(), "message": "This promo code has expired"}

    if promo["max_uses"] is not None and promo["use_count"] >= promo["max_uses"]:
        return {"valid": False, "code": code.upper(), "message": "This promo code has reached its usage limit"}

    return {
        "valid": True,
        "code": promo["code"],
        "discountType": promo["discount_type"],
        "discountValue": float(promo["discount_value"]),
        "message": "Promo code applied successfully",
    }


@exchange_router.get("/exchange-rates")
async def exchange_rates(base: str = Query(default="EUR")):
    rates = await get_rates(base)
    return {"base": base.upper(), "rates": rates}


@resolve_router.get("/resolve-domain")
async def resolve_domain(domain: str = Query(...)):
    """Resolve a custom domain to the hotel slug."""
    hotel = await BookingHotelRepository.get_by_custom_domain(domain)
    if not hotel:
        raise HTTPException(status_code=404, detail="No hotel found for this domain")
    return {"slug": hotel["slug"]}
