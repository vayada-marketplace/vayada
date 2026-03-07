from fastapi import APIRouter, HTTPException, Depends, status
from app.dependencies import require_current_hotel
from app.repositories.booking_addon_repo import BookingAddonRepository
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.models.addon import (
    AddonResponse,
    CreateAddonRequest,
    UpdateAddonRequest,
    AddonSettingsResponse,
    AddonSettingsUpdate,
)

router = APIRouter()


def _addon_to_response(row: dict) -> AddonResponse:
    return AddonResponse(
        id=str(row["id"]),
        name=row["name"],
        description=row["description"],
        price=float(row["price"]),
        currency=row["currency"],
        category=row["category"],
        image=row["image"],
        duration=row.get("duration"),
        per_person=row.get("per_person"),
    )


@router.get("/addons", response_model=list[AddonResponse])
async def list_addons(hotel: dict = Depends(require_current_hotel)):
    rows = await BookingAddonRepository.list_by_hotel_id(str(hotel["id"]))
    return [_addon_to_response(row) for row in rows]


@router.post("/addons", response_model=AddonResponse, status_code=status.HTTP_201_CREATED)
async def create_addon(
    data: CreateAddonRequest,
    hotel: dict = Depends(require_current_hotel),
):
    row = await BookingAddonRepository.create(
        hotel_id=str(hotel["id"]),
        name=data.name,
        description=data.description,
        price=data.price,
        currency=data.currency,
        category=data.category,
        image=data.image,
        duration=data.duration,
        per_person=data.per_person,
    )
    return _addon_to_response(row)


@router.patch("/addons/{addon_id}", response_model=AddonResponse)
async def update_addon(
    addon_id: str,
    data: UpdateAddonRequest,
    hotel: dict = Depends(require_current_hotel),
):
    hotel_id = str(hotel["id"])
    existing = await BookingAddonRepository.get_by_id(addon_id, hotel_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Addon not found")

    updates = {}
    for field in ("name", "description", "price", "currency", "category", "image", "duration", "per_person"):
        value = getattr(data, field)
        if value is not None:
            updates[field] = value

    if updates:
        row = await BookingAddonRepository.update(addon_id, hotel_id, updates)
    else:
        row = existing

    return _addon_to_response(row)


@router.delete("/addons/{addon_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_addon(
    addon_id: str,
    hotel: dict = Depends(require_current_hotel),
):
    deleted = await BookingAddonRepository.delete(addon_id, str(hotel["id"]))
    if not deleted:
        raise HTTPException(status_code=404, detail="Addon not found")


# ── Addon Display Settings ─────────────────────────────────────────


@router.get("/settings/addons", response_model=AddonSettingsResponse)
async def get_addon_settings(hotel: dict = Depends(require_current_hotel)):
    return AddonSettingsResponse(
        show_addons_step=hotel.get("show_addons_step", True),
        group_addons_by_category=hotel.get("group_addons_by_category", True),
    )


@router.patch("/settings/addons", response_model=AddonSettingsResponse)
async def update_addon_settings(
    data: AddonSettingsUpdate,
    hotel: dict = Depends(require_current_hotel),
):
    updates = {}
    if data.show_addons_step is not None:
        updates["show_addons_step"] = data.show_addons_step
    if data.group_addons_by_category is not None:
        updates["group_addons_by_category"] = data.group_addons_by_category

    if updates:
        result = await BookingHotelRepository.partial_update(str(hotel["id"]), updates)
    else:
        result = hotel

    return AddonSettingsResponse(
        show_addons_step=result.get("show_addons_step", True),
        group_addons_by_category=result.get("group_addons_by_category", True),
    )
