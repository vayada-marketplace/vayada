import json
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.dependencies import require_hotel_admin, require_current_hotel
from app.database import PmsDatabase
from app.config import settings

router = APIRouter()


def _parse_jsonb(val):
    if isinstance(val, str):
        return json.loads(val)
    return val if val is not None else []


class BenefitsResponse(BaseModel):
    benefits: list[str] = []


class BenefitsUpdate(BaseModel):
    benefits: list[str]


# Benefits are stored on PMS hotels.benefits JSONB column. After the
# multi-hotel-ids unification, hotel["id"] from require_current_hotel
# is the same UUID as the PMS hotel row, so no separate lookup is
# needed — query PMS by id directly.

@router.get("/benefits", response_model=BenefitsResponse)
async def get_benefits(hotel: dict = Depends(require_current_hotel)):
    if not settings.PMS_DATABASE_URL:
        return BenefitsResponse(benefits=[])
    hotel_id = str(hotel["id"])
    row = await PmsDatabase.fetchrow(
        "SELECT benefits FROM hotels WHERE id = $1", hotel_id
    )
    return BenefitsResponse(
        benefits=_parse_jsonb(row["benefits"]) if row else []
    )


@router.put("/benefits", response_model=BenefitsResponse)
async def update_benefits(
    data: BenefitsUpdate,
    hotel: dict = Depends(require_current_hotel),
):
    if not settings.PMS_DATABASE_URL:
        return BenefitsResponse(benefits=data.benefits)
    hotel_id = str(hotel["id"])
    await PmsDatabase.execute(
        "UPDATE hotels SET benefits = $1::jsonb WHERE id = $2",
        json.dumps(data.benefits),
        hotel_id,
    )
    return BenefitsResponse(benefits=data.benefits)
