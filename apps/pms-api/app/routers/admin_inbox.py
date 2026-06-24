from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.inbox_automation import (
    AutomationListResponse,
    GuestAutomation,
    GuestAutomationCreate,
    GuestAutomationUpdate,
    MessageTemplate,
    MessageTemplateCreate,
    MessageTemplateUpdate,
    TemplateListResponse,
    TemplateRenderResponse,
    VariablePreviewResponse,
)
from app.repositories.inbox_automation_repo import (
    GuestAutomationRepository,
    MessageTemplateRepository,
)
from app.repositories.messaging_repo import MessageThreadRepository
from app.services.inbox_automation_service import (
    preview_variables,
    render_template,
    variables_for_booking,
)
from app.utils import get_hotel_id

router = APIRouter(prefix="/admin/inbox", tags=["admin-inbox"])


def _template(row: dict) -> MessageTemplate:
    return MessageTemplate(
        id=str(row["id"]),
        name=row["name"],
        category=row["category"],
        icon=row["icon"],
        content=row["content"],
        is_default=bool(row.get("is_default")),
        sort_order=int(row.get("sort_order") or 0),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _automation(row: dict) -> GuestAutomation:
    return GuestAutomation(
        id=str(row["id"]),
        template_id=str(row["template_id"]) if row.get("template_id") else None,
        template_name=row.get("template_name"),
        name=row["name"],
        icon=row["icon"],
        description=row.get("description") or "",
        trigger_event=row["trigger_event"],
        days_offset=int(row.get("days_offset") or 0),
        send_time=row["send_time"],
        audience=row["audience"],
        delivery_channel=row["delivery_channel"],
        is_active=bool(row.get("is_active")),
        sort_order=int(row.get("sort_order") or 0),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _booking_context_for_thread(thread_id: str, hotel_id: str) -> dict | None:
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread or not thread.get("booking_id"):
        return None
    row = await Database.fetchrow(
        """
        SELECT
            b.*,
            h.name AS hotel_name,
            h.address AS hotel_address,
            h.contact_email AS hotel_contact_email,
            h.wifi_password,
            h.host_contact_name,
            h.google_review_link
        FROM bookings b
        JOIN hotels h ON h.id = b.hotel_id
        WHERE b.id = $1 AND b.hotel_id = $2
        """,
        thread["booking_id"],
        hotel_id,
    )
    return dict(row) if row else None


@router.get("/templates", response_model=TemplateListResponse)
async def list_templates(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rows = await MessageTemplateRepository.list_by_hotel(hotel_id)
    return TemplateListResponse(templates=[_template(row) for row in rows])


@router.post("/templates", response_model=MessageTemplate, status_code=201)
async def create_template(
    data: MessageTemplateCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await MessageTemplateRepository.create(hotel_id, data.model_dump())
    return _template(row)


@router.patch("/templates/{template_id}", response_model=MessageTemplate)
async def update_template(
    template_id: str,
    data: MessageTemplateUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await MessageTemplateRepository.update(
        template_id,
        hotel_id,
        data.model_dump(exclude_unset=True),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")
    return _template(row)


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(
    template_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    if not await MessageTemplateRepository.delete(template_id, hotel_id):
        raise HTTPException(status_code=404, detail="Template not found")


@router.get("/templates/{template_id}/render", response_model=TemplateRenderResponse)
async def render_template_for_thread(
    template_id: str,
    thread_id: str | None = Query(None),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    template = await MessageTemplateRepository.get_by_id(template_id, hotel_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    context = await _booking_context_for_thread(thread_id, hotel_id) if thread_id else None
    variables = variables_for_booking(context) if context else await preview_variables(hotel_id)
    return TemplateRenderResponse(
        content=render_template(template["content"], variables),
        variables=variables,
    )


@router.get("/variables/preview", response_model=VariablePreviewResponse)
async def variable_preview(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    return VariablePreviewResponse(variables=await preview_variables(hotel_id))


@router.get("/automations", response_model=AutomationListResponse)
async def list_automations(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rows = await GuestAutomationRepository.list_by_hotel(hotel_id)
    return AutomationListResponse(automations=[_automation(row) for row in rows])


@router.post("/automations", response_model=GuestAutomation, status_code=201)
async def create_automation(
    data: GuestAutomationCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await GuestAutomationRepository.create(hotel_id, data.model_dump())
    loaded = await GuestAutomationRepository.get_by_id(str(row["id"]), hotel_id)
    return _automation(loaded or row)


@router.patch("/automations/{automation_id}", response_model=GuestAutomation)
async def update_automation(
    automation_id: str,
    data: GuestAutomationUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await GuestAutomationRepository.update(
        automation_id,
        hotel_id,
        data.model_dump(exclude_unset=True),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Automation not found")
    loaded = await GuestAutomationRepository.get_by_id(automation_id, hotel_id)
    return _automation(loaded or row)


@router.delete("/automations/{automation_id}", status_code=204)
async def delete_automation(
    automation_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    if not await GuestAutomationRepository.delete(automation_id, hotel_id):
        raise HTTPException(status_code=404, detail="Automation not found")
