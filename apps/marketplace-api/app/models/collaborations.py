"""
Collaboration-related Pydantic models
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ============================================
# DELIVERABLE MODELS
# ============================================


class PlatformDeliverable(BaseModel):
    """Individual deliverable item"""

    id: str | None = Field(None, description="Unique ID for the deliverable")
    type: str = Field(
        ..., description="Deliverable type (e.g., 'Instagram Post', 'Instagram Stories')"
    )
    quantity: int = Field(..., gt=0, description="Number of deliverables of this type")
    status: Literal["pending", "completed"] = Field(
        default="pending", description="Status of the deliverable"
    )

    model_config = ConfigDict(populate_by_name=True)


class PlatformDeliverablesItem(BaseModel):
    """Platform with its deliverables"""

    platform: Literal["Instagram", "TikTok", "YouTube", "Facebook", "Content Package", "Custom"] = (
        Field(..., description="Social media platform or content type")
    )
    deliverables: list[PlatformDeliverable] = Field(
        ..., min_length=1, description="List of deliverables for this platform"
    )

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATE COLLABORATION REQUEST
# ============================================


class CreateCollaborationRequest(BaseModel):
    """Request model for creating a collaboration (supports both creator and hotel initiators)"""

    initiator_type: Literal["creator", "hotel"] = Field(
        ..., description="Who is initiating the collaboration"
    )

    # Common required fields
    listing_id: str = Field(..., description="Hotel listing ID")
    creator_id: str | None = Field(
        None,
        description="Creator ID. For creator-initiated: optional (will be auto-filled from authenticated user). For hotel-initiated: required, must be the ID of the creator being invited.",
    )
    platform_deliverables: list[PlatformDeliverablesItem] = Field(
        ..., min_length=1, description="Platform deliverables commitment"
    )

    # Affiliate / commission
    creator_fee: Decimal | None = Field(
        None, ge=0, le=100, description="Creator commission percentage for affiliate tracking"
    )

    # Creator-specific fields
    why_great_fit: str | None = Field(
        None,
        max_length=500,
        description="Why the creator is a good fit (required for creator applications)",
    )
    travel_date_from: date | None = Field(
        None, description="Proposed check-in date for creator applications"
    )
    travel_date_to: date | None = Field(
        None, description="Proposed check-out date for creator applications"
    )
    preferred_months: list[str] | None = Field(
        None, description="Preferred months (month abbreviations like ['Jan', 'Feb'])"
    )
    consent: bool | None = Field(
        None, description="Consent flag (required and must be true for creator applications)"
    )

    # Hotel-specific fields
    collaboration_type: Literal["Free Stay", "Paid", "Discount", "Affiliate"] | None = Field(
        None, description="Type of collaboration (required for hotel invitations)"
    )
    free_stay_min_nights: int | None = Field(
        None,
        gt=0,
        description="Minimum nights for Free Stay (required if collaboration_type is 'Free Stay')",
    )
    free_stay_max_nights: int | None = Field(
        None,
        gt=0,
        description="Maximum nights for Free Stay (required if collaboration_type is 'Free Stay')",
    )
    paid_amount: Decimal | None = Field(
        None,
        gt=0,
        description="Payment amount for Paid collaboration (required if collaboration_type is 'Paid')",
    )
    currency: str | None = Field(
        None,
        pattern=r"^[A-Z]{3}$",
        description="ISO 4217 currency code for paid_amount (defaults to USD server-side)",
    )
    discount_percentage: int | None = Field(
        None,
        ge=1,
        le=100,
        description="Discount percentage for Discount collaboration (required if collaboration_type is 'Discount')",
    )
    preferred_date_from: date | None = Field(
        None, description="Preferred start date for hotel invitations"
    )
    preferred_date_to: date | None = Field(
        None, description="Preferred end date for hotel invitations"
    )

    @model_validator(mode="after")
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
                    raise ValueError(
                        "free_stay_min_nights and free_stay_max_nights are required for Free Stay collaboration"
                    )
                if self.free_stay_max_nights < self.free_stay_min_nights:
                    raise ValueError("free_stay_max_nights must be >= free_stay_min_nights")
            elif self.collaboration_type == "Paid":
                if not self.paid_amount or self.paid_amount <= 0:
                    raise ValueError(
                        "paid_amount is required and must be > 0 for Paid collaboration"
                    )
            elif self.collaboration_type == "Discount":
                if not self.discount_percentage or not (1 <= self.discount_percentage <= 100):
                    raise ValueError(
                        "discount_percentage must be between 1-100 for Discount collaboration"
                    )
            elif self.collaboration_type == "Affiliate":
                if not self.creator_fee or not (1 <= self.creator_fee <= 100):
                    raise ValueError(
                        "creator_fee must be between 1-100 for Affiliate collaboration"
                    )

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

    status: Literal["accepted", "declined"] = Field(..., description="Response status")
    response_message: str | None = Field(None, description="Optional message when responding")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# UPDATE COLLABORATION TERMS
# ============================================


class UpdateCollaborationTermsRequest(BaseModel):
    """Request model for suggesting changes (Negotiation)"""

    collaboration_type: Literal["Free Stay", "Paid", "Discount", "Affiliate"] | None = None
    free_stay_min_nights: int | None = None
    free_stay_max_nights: int | None = None
    paid_amount: Decimal | None = None
    currency: str | None = Field(
        None, pattern=r"^[A-Z]{3}$", description="ISO 4217 currency code for paid_amount"
    )
    discount_percentage: int | None = None
    stay_nights: int | None = None
    travel_date_from: date | None = None
    travel_date_to: date | None = None
    platform_deliverables: list[PlatformDeliverablesItem] | None = None
    creator_fee: Decimal | None = None

    @model_validator(mode="after")
    def check_at_least_one_update(self):
        if not any(
            [
                self.collaboration_type,
                self.free_stay_min_nights,
                self.free_stay_max_nights,
                self.paid_amount,
                self.currency,
                self.discount_percentage,
                self.stay_nights,
                self.travel_date_from,
                self.travel_date_to,
                self.platform_deliverables,
                self.creator_fee,
            ]
        ):
            raise ValueError(
                "At least one term (type, amount, dates or deliverables) must be updated"
            )
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CANCEL COLLABORATION
# ============================================


class CancelCollaborationRequest(BaseModel):
    """Request model for cancelling a collaboration"""

    reason: str | None = Field(None, description="Reason for cancellation")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# RATE COLLABORATION
# ============================================


class RateCollaborationRequest(BaseModel):
    """Request model for rating a collaboration"""

    rating: int = Field(..., ge=1, le=5, description="Rating from 1 to 5")
    comment: str | None = Field(None, max_length=1000, description="Optional comment")

    model_config = ConfigDict(populate_by_name=True)


class RateCollaborationResponse(BaseModel):
    """Response model for rating submission"""

    message: str
    rating_id: str
    created_at: datetime

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
    creator_user_id: str | None = None
    creator_name: str
    creator_profile_picture: str | None = None
    hotel_id: str
    hotel_name: str
    listing_id: str
    listing_name: str
    listing_location: str

    # Collaboration terms
    collaboration_type: str | None = None
    free_stay_min_nights: int | None = None
    free_stay_max_nights: int | None = None
    paid_amount: Decimal | None = None
    currency: str | None = None
    discount_percentage: int | None = None
    stay_nights: int | None = None

    # Dates
    travel_date_from: date | None = None
    travel_date_to: date | None = None
    preferred_date_from: date | None = None
    preferred_date_to: date | None = None
    preferred_months: list[str] | None = None

    # Communication
    why_great_fit: str | None = None

    # Deliverables
    platform_deliverables: list[PlatformDeliverablesItem]

    # Consent
    consent: bool | None = None

    # Timestamps
    created_at: datetime
    updated_at: datetime
    responded_at: datetime | None = None
    cancelled_at: datetime | None = None
    completed_at: datetime | None = None

    # Negotiation
    hotel_agreed_at: datetime | None = None
    creator_agreed_at: datetime | None = None
    term_last_updated_at: datetime | None = None

    # Affiliate tracking
    creator_fee: Decimal | None = None
    affiliate_referral_code: str | None = None
    affiliate_link: str | None = None

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    @classmethod
    def from_db_row(
        cls,
        row,
        *,
        creator_name: str = "Unknown",
        platform_deliverables: list["PlatformDeliverablesItem"] | None = None,
    ) -> "CollaborationResponse":
        """Build a response from a joined collaboration row.

        Callers that fetch via `CollaborationRepository.get_full` (or
        equivalent) get the joined hotel/listing/creator fields directly
        on the row. Callers that hand-build a row for newly-created
        collaborations should merge those joined fields onto the dict
        before calling.
        """
        fsmin = row.get("free_stay_min_nights")
        fsmax = row.get("free_stay_max_nights")
        return cls(
            id=str(row["id"]),
            initiator_type=row["initiator_type"],
            status=row["status"],
            creator_id=str(row["creator_id"]),
            creator_user_id=str(row["creator_user_id"]) if row.get("creator_user_id") else None,
            creator_name=creator_name,
            creator_profile_picture=row.get("creator_profile_picture"),
            hotel_id=str(row["hotel_id"]),
            hotel_name=row["hotel_name"],
            listing_id=str(row["listing_id"]),
            listing_name=row["listing_name"],
            listing_location=row["listing_location"],
            collaboration_type=row.get("collaboration_type"),
            free_stay_min_nights=fsmin,
            free_stay_max_nights=fsmax,
            paid_amount=row.get("paid_amount"),
            currency=row.get("currency"),
            discount_percentage=row.get("discount_percentage"),
            stay_nights=fsmin if fsmin is not None and fsmin == fsmax else None,
            travel_date_from=row.get("travel_date_from"),
            travel_date_to=row.get("travel_date_to"),
            preferred_date_from=row.get("preferred_date_from"),
            preferred_date_to=row.get("preferred_date_to"),
            preferred_months=row.get("preferred_months"),
            why_great_fit=row.get("why_great_fit"),
            platform_deliverables=platform_deliverables or [],
            consent=row.get("consent"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            responded_at=row.get("responded_at"),
            cancelled_at=row.get("cancelled_at"),
            completed_at=row.get("completed_at"),
            hotel_agreed_at=row.get("hotel_agreed_at"),
            creator_agreed_at=row.get("creator_agreed_at"),
            term_last_updated_at=row.get("term_last_updated_at"),
            creator_fee=row.get("creator_fee"),
            affiliate_referral_code=row.get("affiliate_referral_code"),
            affiliate_link=row.get("affiliate_link"),
        )
