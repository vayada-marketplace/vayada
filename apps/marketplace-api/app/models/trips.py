"""
Trip and External Collaboration Pydantic models
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from datetime import date, datetime


# ============================================
# TRIP MODELS
# ============================================

class CreateTripRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    location: Optional[str] = Field(None, max_length=300)
    start_date: date
    end_date: date
    notes: Optional[str] = Field(None, max_length=2000)


class UpdateTripRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    location: Optional[str] = Field(None, max_length=300)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = Field(None, max_length=2000)


class TripResponse(BaseModel):
    id: str
    creator_id: str
    name: str
    location: Optional[str] = None
    start_date: date
    end_date: date
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    external_collaborations: List['ExternalCollaborationResponse'] = []


# ============================================
# EXTERNAL COLLABORATION MODELS
# ============================================

class CreateExternalCollaborationRequest(BaseModel):
    trip_id: Optional[str] = None
    title: str = Field(..., min_length=1, max_length=200)
    hotel_name: Optional[str] = Field(None, max_length=200)
    location: Optional[str] = Field(None, max_length=300)
    collaboration_type: Optional[Literal['Custom / External', 'Paid', 'Free Stay']] = Field(default='Custom / External')
    start_date: date
    end_date: date
    deliverables: Optional[str] = Field(None, max_length=1000)
    notes: Optional[str] = Field(None, max_length=2000)


class UpdateExternalCollaborationRequest(BaseModel):
    trip_id: Optional[str] = None
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    hotel_name: Optional[str] = Field(None, max_length=200)
    location: Optional[str] = Field(None, max_length=300)
    collaboration_type: Optional[Literal['Custom / External', 'Paid', 'Free Stay']] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    deliverables: Optional[str] = Field(None, max_length=1000)
    notes: Optional[str] = Field(None, max_length=2000)


class ExternalCollaborationResponse(BaseModel):
    id: str
    creator_id: str
    trip_id: Optional[str] = None
    title: str
    hotel_name: Optional[str] = None
    location: Optional[str] = None
    collaboration_type: Optional[str] = None
    start_date: date
    end_date: date
    deliverables: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
