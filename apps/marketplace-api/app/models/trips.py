"""
Trip and External Collaboration Pydantic models
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# ============================================
# TRIP MODELS
# ============================================


class CreateTripRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    location: str | None = Field(None, max_length=300)
    start_date: date
    end_date: date
    notes: str | None = Field(None, max_length=2000)


class UpdateTripRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    location: str | None = Field(None, max_length=300)
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = Field(None, max_length=2000)


class TripResponse(BaseModel):
    id: str
    creator_id: str
    name: str
    location: str | None = None
    start_date: date
    end_date: date
    notes: str | None = None
    created_at: datetime
    updated_at: datetime
    external_collaborations: list["ExternalCollaborationResponse"] = []


# ============================================
# EXTERNAL COLLABORATION MODELS
# ============================================


class CreateExternalCollaborationRequest(BaseModel):
    trip_id: str | None = None
    title: str = Field(..., min_length=1, max_length=200)
    hotel_name: str | None = Field(None, max_length=200)
    location: str | None = Field(None, max_length=300)
    collaboration_type: Literal["Custom / External", "Paid", "Free Stay"] | None = Field(
        default="Custom / External"
    )
    start_date: date
    end_date: date
    deliverables: str | None = Field(None, max_length=1000)
    notes: str | None = Field(None, max_length=2000)


class UpdateExternalCollaborationRequest(BaseModel):
    trip_id: str | None = None
    title: str | None = Field(None, min_length=1, max_length=200)
    hotel_name: str | None = Field(None, max_length=200)
    location: str | None = Field(None, max_length=300)
    collaboration_type: Literal["Custom / External", "Paid", "Free Stay"] | None = None
    start_date: date | None = None
    end_date: date | None = None
    deliverables: str | None = Field(None, max_length=1000)
    notes: str | None = Field(None, max_length=2000)


class ExternalCollaborationResponse(BaseModel):
    id: str
    creator_id: str
    trip_id: str | None = None
    title: str
    hotel_name: str | None = None
    location: str | None = None
    collaboration_type: str | None = None
    start_date: date
    end_date: date
    deliverables: str | None = None
    notes: str | None = None
    created_at: datetime
    updated_at: datetime
