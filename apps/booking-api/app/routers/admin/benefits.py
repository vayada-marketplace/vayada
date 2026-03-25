import json
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.dependencies import require_hotel_admin
from app.database import PmsDatabase
from app.config import settings

router = APIRouter()


async def _get_pms_hotel_id(user_id: str):
    """Find the PMS hotel_id (UUID) for a given user."""
    if not settings.PMS_DATABASE_URL:
        return None
    row = await PmsDatabase.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1 LIMIT 1", user_id
    )
    return row["id"] if row else None


def _parse_jsonb(val):
    if isinstance(val, str):
        return json.loads(val)
    return val if val is not None else []


class BenefitsResponse(BaseModel):
    benefits: list[str] = []


class BenefitsUpdate(BaseModel):
    benefits: list[str]


@router.get("/benefits", response_model=BenefitsResponse)
async def get_benefits(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await _get_pms_hotel_id(user_id)
    if not hotel_id:
        return BenefitsResponse(benefits=[])
    row = await PmsDatabase.fetchrow(
        "SELECT benefits FROM hotels WHERE id = $1", hotel_id
    )
    return BenefitsResponse(
        benefits=_parse_jsonb(row["benefits"]) if row else []
    )


@router.put("/benefits", response_model=BenefitsResponse)
async def update_benefits(
    data: BenefitsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await _get_pms_hotel_id(user_id)
    if not hotel_id:
        return BenefitsResponse(benefits=data.benefits)
    await PmsDatabase.execute(
        "UPDATE hotels SET benefits = $1::jsonb WHERE id = $2",
        json.dumps(data.benefits),
        hotel_id,
    )
    return BenefitsResponse(benefits=data.benefits)
