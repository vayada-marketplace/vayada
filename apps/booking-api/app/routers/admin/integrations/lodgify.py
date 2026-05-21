"""Admin endpoints for the Lodgify integration (VAY-398, Phase 1a)."""

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import require_current_hotel
from app.models.lodgify import LodgifyConnectionStatus, LodgifyConnectRequest
from app.services.lodgify.connection import (
    LodgifyConnectError,
    connect_lodgify,
    disconnect_lodgify,
    get_lodgify_status,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/lodgify", tags=["integrations-lodgify"])


@router.post("/connect", response_model=LodgifyConnectionStatus)
async def connect(
    payload: LodgifyConnectRequest,
    hotel: dict = Depends(require_current_hotel),
):
    try:
        return await connect_lodgify(
            str(hotel["id"]),
            api_key=payload.api_key,
            lodgify_property_id=payload.lodgify_property_id,
        )
    except LodgifyConnectError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.delete("/disconnect", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect(hotel: dict = Depends(require_current_hotel)):
    await disconnect_lodgify(str(hotel["id"]))
    return None


@router.get("/status", response_model=LodgifyConnectionStatus)
async def get_status(hotel: dict = Depends(require_current_hotel)):
    return await get_lodgify_status(str(hotel["id"]))
