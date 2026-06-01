from fastapi import APIRouter, Depends, Path

from app.dependencies import require_hotel_admin
from app.models.module_activation import (
    ModuleActivation,
    ModuleActivationsResponse,
    ModuleActivationUpdate,
)
from app.repositories.module_activation_repo import ModuleActivationRepository
from app.utils import get_hotel_id

router = APIRouter(prefix="/admin", tags=["admin-module-activations"])


def _to_model(row: dict) -> ModuleActivation:
    return ModuleActivation(
        module_id=row["module_id"],
        is_active=bool(row["is_active"]),
        activated_at=row.get("activated_at"),
        deactivated_at=row.get("deactivated_at"),
        updated_at=row["updated_at"],
    )


@router.get("/module-activations", response_model=ModuleActivationsResponse)
async def list_module_activations(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rows = await ModuleActivationRepository.list_by_hotel_id(hotel_id)
    return ModuleActivationsResponse(
        hotel_id=hotel_id,
        active_modules=[row["module_id"] for row in rows if row["is_active"]],
        activations=[_to_model(row) for row in rows],
    )


@router.patch("/module-activations/{module_id}", response_model=ModuleActivation)
async def update_module_activation(
    data: ModuleActivationUpdate,
    module_id: str = Path(
        ...,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$",
    ),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    # Path wins so callers can safely use a stable endpoint even if stale
    # request bodies are retried by the client.
    requested = ModuleActivationUpdate(module_id=module_id, is_active=data.is_active)
    row = await ModuleActivationRepository.upsert(
        hotel_id,
        requested.module_id,
        requested.is_active,
    )
    return _to_model(row)
