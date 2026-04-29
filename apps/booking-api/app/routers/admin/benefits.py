import json
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.dependencies import require_current_hotel
from app.database import Database

router = APIRouter()


def _parse_jsonb(val):
    if isinstance(val, str):
        return json.loads(val)
    return val if val is not None else []


class BenefitsResponse(BaseModel):
    benefits: list[str] = []


class BenefitsUpdate(BaseModel):
    benefits: list[str]


# Benefits are stored on booking_hotels.benefits, keyed by the booking
# hotel id. Storing them here (rather than on pms.hotels.benefits) keeps
# the canonical id used by both admin frontends — the X-Hotel-Id header
# always carries booking_hotels.id — so reads/writes line up regardless
# of whether the PMS row was created via the multi-hotel-ids unification
# (id-matched) or predates it (id mismatch but linked by user_id+slug).

@router.get("/benefits", response_model=BenefitsResponse)
async def get_benefits(hotel: dict = Depends(require_current_hotel)):
    row = await Database.fetchrow(
        "SELECT benefits FROM booking_hotels WHERE id = $1", str(hotel["id"])
    )
    return BenefitsResponse(
        benefits=_parse_jsonb(row["benefits"]) if row else []
    )


@router.put("/benefits", response_model=BenefitsResponse)
async def update_benefits(
    data: BenefitsUpdate,
    hotel: dict = Depends(require_current_hotel),
):
    await Database.execute(
        "UPDATE booking_hotels SET benefits = $1::jsonb WHERE id = $2",
        json.dumps(data.benefits),
        str(hotel["id"]),
    )
    return BenefitsResponse(benefits=data.benefits)
