"""
Collaboration-related Pydantic models
"""
from pydantic import BaseModel, Field, model_validator, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, date
from decimal import Decimal


# ============================================
# DELIVERABLE MODELS
# ============================================

class PlatformDeliverable(BaseModel):
    """Individual deliverable item"""
    id: Optional[str] = Field(None, description="Unique ID for the deliverable")
    type: str = Field(..., description="Deliverable type (e.g., 'Instagram Post', 'Instagram Stories')")
    quantity: int = Field(..., gt=0, description="Number of deliverables of this type")
    status: Literal["pending", "completed"] = Field(default="pending", description="Status of the deliverable")

    model_config = ConfigDict(populate_by_name=True)


class PlatformDeliverablesItem(BaseModel):
    """Platform with its deliverables"""
    platform: Literal["Instagram", "TikTok", "YouTube", "Facebook", "Content Package", "Custom"] = Field(
        ...,
        description="Social media platform or content type"
    )
    deliverables: List[PlatformDeliverable] = Field(
        ...,
        min_length=1,
        description="List of deliverables for this platform"
    )

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATE COLLABORATION REQUEST
# ============================================

class CreateCollaborationRequest(BaseModel):
    """Request model for creating a collaboration (supports both creator and hotel initiators)"""
    initiator_type: Literal["creator", "hotel"] = Field(
        ...,
        description="Who is initiating the collaboration"
    )

    # Common required fields
    listing_id: str = Field(..., description="Hotel listing ID")
    creator_id: Optional[str] = Field(
        None,
        description="Creator ID. For creator-initiated: optional (will be auto-filled from authenticated user). For hotel-initiated: required, must be the ID of the creator being invited."
    )
    platform_deliverables: List[PlatformDeliverablesItem] = Field(
        ...,
        min_length=1,
        description="Platform deliverables commitment"
    )

    # Creator-specific fields
    why_great_fit: Optional[str] = Field(
        None,
        max_length=500,
        description="Why the creator is a good fit (required for creator applications)"
    )
    travel_date_from: Optional[date] = Field(
        None,
        description="Proposed check-in date for creator applications"
    )
    travel_date_to: Optional[date] = Field(
        None,
        description="Proposed check-out date for creator applications"
    )
    preferred_months: Optional[List[str]] = Field(
        None,
        description="Preferred months (month abbreviations like ['Jan', 'Feb'])"
    )
    consent: Optional[bool] = Field(
        None,
        description="Consent flag (required and must be true for creator applications)"
    )

    # Hotel-specific fields
    collaboration_type: Optional[Literal["Free Stay", "Paid", "Discount"]] = Field(
        None,
        description="Type of collaboration (required for hotel invitations)"
    )
    free_stay_min_nights: Optional[int] = Field(
        None,
        gt=0,
        description="Minimum nights for Free Stay (required if collaboration_type is 'Free Stay')"
    )
    free_stay_max_nights: Optional[int] = Field(
        None,
        gt=0,
        description="Maximum nights for Free Stay (required if collaboration_type is 'Free Stay')"
    )
    paid_amount: Optional[Decimal] = Field(
        None,
        gt=0,
        description="Payment amount for Paid collaboration (required if collaboration_type is 'Paid')"
    )
    discount_percentage: Optional[int] = Field(
        None,
        ge=1,
        le=100,
        description="Discount percentage for Discount collaboration (required if collaboration_type is 'Discount')"
    )
    preferred_date_from: Optional[date] = Field(
        None,
        description="Preferred start date for hotel invitations"
    )
    preferred_date_to: Optional[date] = Field(
        None,
        description="Preferred end date for hotel invitations"
    )

    @model_validator(mode='after')
    def validate_by_initiator_type(self):
        """Validate fields based on initiator_type"""
        if self.initiator_type == "creator":
            # Creator-specific validations
            if not self.why_great_fit:
                raise ValueError("why_great_fit is required for creator applications")
            if self.consent is not True:
                raise ValueError("consent must be true for creator applications")
        elif self.initiator_type == "hotel":
            # Hotel-specific validations
            if not self.creator_id:
                raise ValueError("creator_id is required for hotel invitations")
            if not self.collaboration_type:
                raise ValueError("collaboration_type is required for hotel invitations")

            # Validate type-specific fields
            if self.collaboration_type == "Free Stay":
                if not self.free_stay_min_nights or not self.free_stay_max_nights:
                    raise ValueError("free_stay_min_nights and free_stay_max_nights are required for Free Stay collaboration")
                if self.free_stay_max_nights < self.free_stay_min_nights:
                    raise ValueError("free_stay_max_nights must be >= free_stay_min_nights")
            elif self.collaboration_type == "Paid":
                if not self.paid_amount or self.paid_amount <= 0:
                    raise ValueError("paid_amount is required and must be > 0 for Paid collaboration")
            elif self.collaboration_type == "Discount":
                if not self.discount_percentage or not (1 <= self.discount_percentage <= 100):
                    raise ValueError("discount_percentage must be between 1-100 for Discount collaboration")

        # Validate date ranges if provided
        if self.travel_date_from and self.travel_date_to:
            if self.travel_date_to < self.travel_date_from:
                raise ValueError("travel_date_to must be >= travel_date_from")

        if self.preferred_date_from and self.preferred_date_to:
            if self.preferred_date_to < self.preferred_date_from:
                raise ValueError("preferred_date_to must be >= preferred_date_from")

        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# RESPOND TO COLLABORATION
# ============================================

class RespondToCollaborationRequest(BaseModel):
    """Request model for responding to a collaboration (accept/decline)"""
    status: Literal["accepted", "declined"] = Field(
        ...,
        description="Response status"
    )
    response_message: Optional[str] = Field(
        None,
        description="Optional message when responding"
    )

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# UPDATE COLLABORATION TERMS
# ============================================

class UpdateCollaborationTermsRequest(BaseModel):
    """Request model for suggesting changes (Negotiation)"""
    collaboration_type: Optional[Literal["Free Stay", "Paid", "Discount"]] = None
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_amount: Optional[Decimal] = None
    discount_percentage: Optional[int] = None
    stay_nights: Optional[int] = None
    travel_date_from: Optional[date] = None
    travel_date_to: Optional[date] = None
    platform_deliverables: Optional[List[PlatformDeliverablesItem]] = None

    @model_validator(mode='after')
    def check_at_least_one_update(self):
        if not any([
            self.collaboration_type,
            self.free_stay_min_nights,
            self.free_stay_max_nights,
            self.paid_amount,
            self.discount_percentage,
            self.stay_nights,
            self.travel_date_from,
            self.travel_date_to,
            self.platform_deliverables
        ]):
            raise ValueError("At least one term (type, amount, dates or deliverables) must be updated")
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CANCEL COLLABORATION
# ============================================

class CancelCollaborationRequest(BaseModel):
    """Request model for cancelling a collaboration"""
    reason: Optional[str] = Field(None, description="Reason for cancellation")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# COLLABORATION RESPONSE
# ============================================

class CollaborationResponse(BaseModel):
    """Response model for collaboration data"""
    id: str
    initiator_type: str
    status: str
    creator_id: str
    creator_name: str
    creator_profile_picture: Optional[str] = None
    hotel_id: str
    hotel_name: str
    listing_id: str
    listing_name: str
    listing_location: str

    # Collaboration terms
    collaboration_type: Optional[str] = None
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_amount: Optional[Decimal] = None
    discount_percentage: Optional[int] = None
    stay_nights: Optional[int] = None

    # Dates
    travel_date_from: Optional[date] = None
    travel_date_to: Optional[date] = None
    preferred_date_from: Optional[date] = None
    preferred_date_to: Optional[date] = None
    preferred_months: Optional[List[str]] = None

    # Communication
    why_great_fit: Optional[str] = None

    # Deliverables
    platform_deliverables: List[PlatformDeliverablesItem]

    # Consent
    consent: Optional[bool] = None

    # Timestamps
    created_at: datetime
    updated_at: datetime
    responded_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    # Negotiation
    hotel_agreed_at: Optional[datetime] = None
    creator_agreed_at: Optional[datetime] = None
    term_last_updated_at: Optional[datetime] = None

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
