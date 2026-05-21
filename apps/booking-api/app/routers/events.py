import logging
from typing import Optional

from fastapi import APIRouter, Response
from pydantic import BaseModel
from app.repositories.event_repo import EventRepository, VALID_EVENT_TYPES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["events"])


class EventRequest(BaseModel):
    hotel_slug: str
    event_type: str
    session_id: Optional[str] = None
    metadata: Optional[dict] = None


@router.post("/events", status_code=204)
async def record_event(body: EventRequest):
    if body.event_type not in VALID_EVENT_TYPES:
        return Response(status_code=422)

    try:
        await EventRepository.record(
            hotel_slug=body.hotel_slug,
            event_type=body.event_type,
            session_id=body.session_id,
            metadata=body.metadata,
        )
    except Exception:
        logger.exception("Failed to record event")

    return Response(status_code=204)
