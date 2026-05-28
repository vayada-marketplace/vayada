import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException

from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.checkout import (
    BookingCheckoutComplete,
    CheckoutChargeCreate,
    CheckoutChargeResponse,
    CheckoutInspectionStep,
    CheckoutInspectionTemplateResponse,
    CheckoutInspectionTemplateUpdate,
    CheckoutRecordResponse,
)
from app.repositories.booking_event_repo import BookingEventRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.checkout_repo import CheckoutRepository
from app.routers.admin_bookings import _admin_response
from app.services.channex_sync_service import push_availability_for_room_type
from app.utils import get_hotel_id

router = APIRouter(prefix="/admin", tags=["admin-checkout"])

DEFAULT_INSPECTION_STEPS = [
    {
        "id": "default-minibar",
        "label": "Minibar",
        "okLabel": "OK",
        "negativeLabel": "Charge",
        "notePrompt": "What was consumed?",
        "required": True,
        "position": 0,
    },
    {
        "id": "default-room-condition",
        "label": "Room condition",
        "okLabel": "OK",
        "negativeLabel": "Damage",
        "notePrompt": "Describe the damage",
        "required": True,
        "position": 1,
    },
    {
        "id": "default-keys-access",
        "label": "Keys / access",
        "okLabel": "Returned",
        "negativeLabel": "Missing",
        "notePrompt": "Which key is missing?",
        "required": True,
        "position": 2,
    },
]


def _parse_json(value):
    if value is None:
        return []
    if isinstance(value, str):
        return json.loads(value)
    return value


def _template_response(row: dict | None) -> CheckoutInspectionTemplateResponse:
    raw_steps = _parse_json(row.get("steps")) if row else DEFAULT_INSPECTION_STEPS
    steps = [
        CheckoutInspectionStep.model_validate({**step, "position": idx})
        for idx, step in enumerate(raw_steps)
    ]
    return CheckoutInspectionTemplateResponse(
        steps=steps,
        updated_at=row["updated_at"].isoformat() if row and row.get("updated_at") else None,
        updated_by=str(row["updated_by"]) if row and row.get("updated_by") else None,
    )


def _charge_response(row: dict) -> CheckoutChargeResponse:
    return CheckoutChargeResponse(
        id=str(row["id"]),
        booking_id=str(row["booking_id"]),
        label=row["label"],
        amount=float(row["amount"]),
        original_amount=float(row["original_amount"]),
        status=row["status"],
        created_at=row["created_at"].isoformat(),
        settled_at=row["settled_at"].isoformat() if row.get("settled_at") else None,
        waived_at=row["waived_at"].isoformat() if row.get("waived_at") else None,
    )


def _record_response(row: dict | None) -> CheckoutRecordResponse | None:
    if not row:
        return None
    return CheckoutRecordResponse(
        id=str(row["id"]),
        booking_id=str(row["booking_id"]),
        completed_at=row["completed_at"].isoformat(),
        completed_by=str(row["completed_by"]) if row.get("completed_by") else None,
        inspection_results=_parse_json(row.get("inspection_results")),
        charges_settled=_parse_json(row.get("charges_settled")),
        pending_flags=_parse_json(row.get("pending_flags")),
        checkout_notes=row.get("checkout_notes"),
    )


async def _require_booking(booking_id: str, hotel_id: str) -> dict:
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    return booking


@router.get("/check-out-inspection", response_model=CheckoutInspectionTemplateResponse)
async def get_checkout_inspection(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    row = await CheckoutRepository.get_template(hotel_id)
    return _template_response(row)


@router.put("/check-out-inspection", response_model=CheckoutInspectionTemplateResponse)
async def update_checkout_inspection(
    data: CheckoutInspectionTemplateUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    steps = [step.model_dump(mode="json", by_alias=True) for step in data.steps]
    row = await CheckoutRepository.upsert_template(hotel_id, steps, user_id)
    return _template_response(row)


@router.get("/bookings/{booking_id}/checkout-charges")
async def list_checkout_charges(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await _require_booking(booking_id, hotel_id)
    rows = await CheckoutRepository.list_charges(booking_id)
    return {"charges": [_charge_response(row).model_dump(by_alias=True) for row in rows]}


@router.post(
    "/bookings/{booking_id}/checkout-charges",
    response_model=CheckoutChargeResponse,
    status_code=201,
)
async def create_checkout_charge(
    booking_id: str,
    data: CheckoutChargeCreate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    hotel_id = await get_hotel_id(user_id)
    booking = await _require_booking(booking_id, hotel_id)
    if booking["status"] not in ("checked_in", "in_house"):
        raise HTTPException(status_code=400, detail="Only checked-in bookings can receive charges")

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await CheckoutRepository.create_charge(
                booking_id, hotel_id, data.label, data.amount, user_id, conn=conn
            )
            await BookingEventRepository.record(
                booking_id=booking_id,
                hotel_id=hotel_id,
                event_type="checkout_charge_added",
                payload={"label": data.label, "amount": data.amount},
                actor_user_id=user_id,
                conn=conn,
            )
    return _charge_response(row)


@router.post("/bookings/{booking_id}/checkout-charges/{charge_id}/paid")
async def mark_checkout_charge_paid(
    booking_id: str,
    charge_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await _require_booking(booking_id, hotel_id)
    row = await CheckoutRepository.settle_charge(charge_id, booking_id)
    if not row:
        raise HTTPException(status_code=404, detail="Pending charge not found")
    return _charge_response(row).model_dump(by_alias=True)


@router.post("/bookings/{booking_id}/checkout-charges/{charge_id}/waive")
async def waive_checkout_charge(
    booking_id: str,
    charge_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await _require_booking(booking_id, hotel_id)
    row = await CheckoutRepository.waive_charge(charge_id, booking_id)
    if not row:
        raise HTTPException(status_code=404, detail="Pending charge not found")
    return _charge_response(row).model_dump(by_alias=True)


@router.get("/bookings/{booking_id}/checkout-record", response_model=CheckoutRecordResponse | None)
async def get_checkout_record(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    await _require_booking(booking_id, hotel_id)
    return _record_response(await CheckoutRepository.get_latest_record(booking_id))


@router.post("/bookings/{booking_id}/check-out")
async def complete_booking_check_out(
    booking_id: str,
    data: BookingCheckoutComplete,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await _require_booking(booking_id, hotel_id)
    if booking["status"] not in ("checked_in", "in_house"):
        raise HTTPException(status_code=400, detail="Only checked-in bookings can be checked out")

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            pending_total = await CheckoutRepository.pending_total(booking_id, conn=conn)
            if pending_total > 0:
                raise HTTPException(
                    status_code=400, detail="Settle all charges to complete check-out"
                )

            charges = await CheckoutRepository.list_charges(booking_id, conn=conn)
            charges_settled = [
                _charge_response(charge).model_dump(mode="json", by_alias=True)
                for charge in charges
                if charge["status"] in ("paid", "waived")
            ]
            pending_flags = data.pending_flags or [
                result.model_dump(mode="json", by_alias=True)
                for result in data.inspection_results
                if result.status == "issue"
            ]

            updated = await BookingRepository.complete_check_out(booking_id, conn=conn)
            if not updated:
                raise HTTPException(status_code=404, detail="Booking not found")

            await CheckoutRepository.create_record(
                booking_id=booking_id,
                completed_by=user_id,
                inspection_results=[
                    result.model_dump(mode="json", by_alias=True)
                    for result in data.inspection_results
                ],
                charges_settled=charges_settled,
                pending_flags=pending_flags,
                checkout_notes=data.checkout_notes,
                conn=conn,
            )
            await BookingEventRepository.record(
                booking_id=booking_id,
                hotel_id=hotel_id,
                event_type="guest_checked_out",
                payload={"pending_flags": pending_flags},
                actor_user_id=user_id,
                conn=conn,
            )

    refreshed = await BookingRepository.get_by_id(booking_id)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )
    return await _admin_response(refreshed)
