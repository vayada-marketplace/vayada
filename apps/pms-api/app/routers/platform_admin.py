from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import require_super_admin
from app.models.platform_admin import (
    GrowthDashboardResponse,
    PlatformProperty,
    UpdatePlatformPropertyStatusRequest,
)
from app.repositories.platform_admin_repo import PlatformAdminRepository

router = APIRouter(prefix="/platform-admin", tags=["platform-admin"])


@router.get("/growth", response_model=GrowthDashboardResponse)
async def get_growth_dashboard(
    user_id: str = Depends(require_super_admin),
    granularity: str = Query("weekly", pattern="^(daily|weekly|monthly)$"),
    exclude_test_data: bool = Query(True),
    property_ids: list[str] | None = Query(None),
    booking_property_id: str | None = Query(None),
):
    return await PlatformAdminRepository.get_growth_dashboard(
        granularity=granularity,
        exclude_test_data=exclude_test_data,
        property_ids=property_ids,
        booking_property_id=booking_property_id,
    )


@router.patch("/properties/{property_id}/status", response_model=PlatformProperty)
async def update_property_status(
    property_id: UUID,
    request: UpdatePlatformPropertyStatusRequest,
    user_id: str = Depends(require_super_admin),
):
    property_row = await PlatformAdminRepository.update_property_status(
        str(property_id), request.status
    )
    if not property_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Property not found",
        )
    return property_row
