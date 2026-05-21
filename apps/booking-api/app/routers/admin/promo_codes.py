from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import require_current_hotel
from app.models.promo_code import (
    CreatePromoCodeRequest,
    PromoCodeResponse,
    UpdatePromoCodeRequest,
)
from app.repositories.promo_code_repo import PromoCodeRepository

router = APIRouter()


def _promo_to_response(row: dict) -> PromoCodeResponse:
    return PromoCodeResponse(
        id=str(row["id"]),
        code=row["code"],
        discount_type=row["discount_type"],
        discount_value=float(row["discount_value"]),
        valid_from=row.get("valid_from"),
        valid_until=row.get("valid_until"),
        is_active=row["is_active"],
        max_uses=row.get("max_uses"),
        use_count=row["use_count"],
        created_at=row.get("created_at"),
    )


@router.get("/promo-codes", response_model=list[PromoCodeResponse])
async def list_promo_codes(hotel: dict = Depends(require_current_hotel)):
    rows = await PromoCodeRepository.list_by_hotel_id(str(hotel["id"]))
    return [_promo_to_response(row) for row in rows]


@router.post("/promo-codes", response_model=PromoCodeResponse, status_code=status.HTTP_201_CREATED)
async def create_promo_code(
    data: CreatePromoCodeRequest,
    hotel: dict = Depends(require_current_hotel),
):
    row = await PromoCodeRepository.create(
        hotel_id=str(hotel["id"]),
        code=data.code,
        discount_type=data.discount_type,
        discount_value=data.discount_value,
        valid_from=data.valid_from,
        valid_until=data.valid_until,
        is_active=data.is_active,
        max_uses=data.max_uses,
    )
    return _promo_to_response(row)


@router.patch("/promo-codes/{promo_id}", response_model=PromoCodeResponse)
async def update_promo_code(
    promo_id: str,
    data: UpdatePromoCodeRequest,
    hotel: dict = Depends(require_current_hotel),
):
    hotel_id = str(hotel["id"])
    existing = await PromoCodeRepository.get_by_id(promo_id, hotel_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Promo code not found")

    updates = {}
    for field in (
        "code",
        "discount_type",
        "discount_value",
        "valid_from",
        "valid_until",
        "is_active",
        "max_uses",
    ):
        value = getattr(data, field)
        if value is not None:
            if field == "code":
                value = value.upper()
            updates[field] = value

    if updates:
        row = await PromoCodeRepository.update(promo_id, hotel_id, updates)
    else:
        row = existing

    return _promo_to_response(row)


@router.delete("/promo-codes/{promo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_promo_code(
    promo_id: str,
    hotel: dict = Depends(require_current_hotel),
):
    deleted = await PromoCodeRepository.delete(promo_id, str(hotel["id"]))
    if not deleted:
        raise HTTPException(status_code=404, detail="Promo code not found")
