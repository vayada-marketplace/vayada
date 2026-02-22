import logging

from fastapi import APIRouter, HTTPException

from app.database import Database
from app.repositories.affiliate_repo import AffiliateRepository
from app.models.affiliate import AffiliateRegister, AffiliateResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["affiliates"])


def _affiliate_to_response(a: dict) -> AffiliateResponse:
    return AffiliateResponse(
        id=str(a["id"]),
        referral_code=a["referral_code"],
        full_name=a["full_name"],
        email=a["email"],
        social_media=a["social_media"],
        user_type=a["user_type"],
        payment_method=a["payment_method"],
        paypal_email=a["paypal_email"],
        bank_iban=a["bank_iban"],
        commission_pct=float(a["commission_pct"]),
        status=a["status"],
        created_at=a["created_at"].isoformat(),
    )


@router.post("/{slug}/affiliates", response_model=AffiliateResponse, status_code=201)
async def register_affiliate(slug: str, data: AffiliateRegister):
    # Resolve hotel
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE slug = $1", slug
    )
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")

    hotel_id = str(hotel["id"])

    # Check if email already registered for this hotel
    existing = await Database.fetchrow(
        "SELECT id FROM affiliates WHERE hotel_id = $1 AND email = $2",
        hotel_id,
        data.email,
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail="An affiliate with this email already exists for this hotel",
        )

    try:
        affiliate = await AffiliateRepository.create(hotel_id, data.model_dump())
        return _affiliate_to_response(affiliate)
    except Exception as e:
        logger.error("Failed to create affiliate: %s", e)
        raise HTTPException(status_code=500, detail="Failed to create affiliate")
