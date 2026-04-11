import logging

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr

from app.database import Database
from app.repositories.affiliate_repo import AffiliateRepository
from app.utils import get_hotel_id_by_slug
from app.models.affiliate import AffiliateRegister, AffiliateResponse
from app.services import stripe_service

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
        bank_account_holder=a.get("bank_account_holder", "") or "",
        bank_swift_bic=a.get("bank_swift_bic", "") or "",
        bank_name=a.get("bank_name", "") or "",
        bank_country=a.get("bank_country", "") or "",
        commission_pct=float(a["commission_pct"]),
        status=a["status"],
        created_at=a["created_at"].isoformat(),
    )


@router.post("/{slug}/affiliates", response_model=AffiliateResponse, status_code=201)
async def register_affiliate(slug: str, data: AffiliateRegister):
    # Resolve hotel
    hotel_id = await get_hotel_id_by_slug(slug)

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


@router.post("/{slug}/affiliates/{referral_code}/click", status_code=204)
async def record_affiliate_click(slug: str, referral_code: str, request: Request):
    hotel_id = await get_hotel_id_by_slug(slug)

    affiliate = await AffiliateRepository.get_by_code(hotel_id, referral_code)
    if not affiliate or affiliate["status"] != "approved":
        raise HTTPException(status_code=404, detail="Affiliate not found")

    ip_address = request.headers.get("x-forwarded-for", request.client.host if request.client else None)
    user_agent = request.headers.get("user-agent")

    await AffiliateRepository.record_click(
        str(affiliate["id"]), hotel_id, ip_address, user_agent
    )
    return Response(status_code=204)


# ── Public Stripe Connect for affiliates ──────────────────────────


class AffiliateStripeConnectRequest(BaseModel):
    email: EmailStr
    country: str = "AT"


@router.post("/{slug}/affiliates/{affiliate_id}/stripe/connect")
async def affiliate_self_stripe_connect(
    slug: str, affiliate_id: str, data: AffiliateStripeConnectRequest
):
    """Affiliate creates their own Stripe Connect account. Verified by matching email."""
    hotel_id = await get_hotel_id_by_slug(slug)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if affiliate["email"].lower() != data.email.lower():
        raise HTTPException(status_code=403, detail="Email does not match affiliate record")

    if affiliate.get("stripe_connect_account_id"):
        raise HTTPException(status_code=409, detail="Stripe account already exists")

    account = await stripe_service.create_connect_account(data.email, data.country)
    await AffiliateRepository.update_stripe_connect(affiliate_id, account["id"])

    # Generate onboarding link immediately
    url = await stripe_service.create_connect_account_link(
        account["id"],
        return_url=f"https://book.vayada.com/{slug}?stripe=success",
        refresh_url=f"https://book.vayada.com/{slug}?stripe=refresh",
    )
    return {"accountId": account["id"], "onboardingUrl": url}


@router.get("/{slug}/affiliates/{affiliate_id}/stripe/onboarding-link")
async def affiliate_self_stripe_onboarding_link(
    slug: str, affiliate_id: str, email: str
):
    """Get a fresh Stripe onboarding link. Verified by matching email."""
    hotel_id = await get_hotel_id_by_slug(slug)
    affiliate = await AffiliateRepository.get_by_id(affiliate_id)
    if not affiliate or str(affiliate["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if affiliate["email"].lower() != email.lower():
        raise HTTPException(status_code=403, detail="Email does not match affiliate record")

    if not affiliate.get("stripe_connect_account_id"):
        raise HTTPException(status_code=400, detail="No Stripe Connect account found")

    url = await stripe_service.create_connect_account_link(
        affiliate["stripe_connect_account_id"],
        return_url=f"https://book.vayada.com/{slug}?stripe=success",
        refresh_url=f"https://book.vayada.com/{slug}?stripe=refresh",
    )
    return {"url": url}
