import json
from copy import deepcopy

from fastapi import APIRouter, Depends

from app.dependencies import require_hotel_admin
from app.models.checkin import (
    DEFAULT_CHECKIN_CHECKLIST_STEPS,
    ChecklistStep,
    ChecklistTemplateResponse,
    ChecklistTemplateUpdate,
)
from app.repositories.checkin_checklist_repo import CheckinChecklistRepository
from app.utils import get_hotel_id

router = APIRouter(prefix="/admin", tags=["admin-checkin-checklist"])


def _parse_steps(value) -> list[dict]:
    if value is None:
        return []
    if isinstance(value, str):
        return json.loads(value)
    return value


def _template_response(row: dict | None) -> ChecklistTemplateResponse:
    if row is None:
        steps = [
            ChecklistStep.model_validate({**step, "position": idx})
            for idx, step in enumerate(deepcopy(DEFAULT_CHECKIN_CHECKLIST_STEPS))
        ]
        return ChecklistTemplateResponse(steps=steps)
    if not row:
        return ChecklistTemplateResponse(steps=[])
    steps = [
        ChecklistStep.model_validate({**step, "position": idx})
        for idx, step in enumerate(_parse_steps(row.get("steps")))
    ]
    return ChecklistTemplateResponse(
        steps=steps,
        updated_at=row["updated_at"].isoformat() if row.get("updated_at") else None,
        updated_by=str(row["updated_by"]) if row.get("updated_by") else None,
    )


@router.get("/check-in-checklist", response_model=ChecklistTemplateResponse)
async def get_checkin_checklist(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    row = await CheckinChecklistRepository.get_template(hotel_id)
    return _template_response(row)


@router.put("/check-in-checklist", response_model=ChecklistTemplateResponse)
async def update_checkin_checklist(
    data: ChecklistTemplateUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    steps = [step.model_dump(mode="json") for step in data.steps]
    row = await CheckinChecklistRepository.upsert_template(hotel_id, steps, user_id)
    return _template_response(row)
