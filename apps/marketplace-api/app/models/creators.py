"""
Creator-related Pydantic models
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from app.models.common import (
    CreatorRequirementsResponse,
    GenderSplit,
    PlatformResponse,
    TopAgeGroup,
    TopCountry,
)

# ============================================
# PROFILE STATUS
# ============================================


class CreatorProfileStatusResponse(BaseModel):
    """Creator profile status response model"""

    profile_complete: bool
    missing_fields: list[str]
    missing_platforms: bool
    completion_steps: list[str]


# ============================================
# PLATFORM REQUEST
# ============================================


class PlatformRequest(BaseModel):
    """Platform request model"""

    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"]
    handle: str = Field(..., min_length=1)
    followers: int = Field(..., gt=0)
    engagementRate: float = Field(..., gt=0, alias="engagement_rate")
    topCountries: list[TopCountry] | None = Field(None, alias="top_countries")
    topAgeGroups: list[TopAgeGroup] | None = Field(None, alias="top_age_groups")
    genderSplit: GenderSplit | None = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# PROFILE UPDATE
# ============================================


class UpdateCreatorProfileRequest(BaseModel):
    """Request model for updating creator profile (partial updates supported)"""

    name: str | None = Field(None, min_length=1)
    location: str | None = Field(None, min_length=1)
    shortDescription: str | None = Field(
        None, min_length=10, max_length=500, alias="short_description"
    )
    portfolioLink: HttpUrl | None = Field(None, alias="portfolio_link")
    phone: str | None = None
    profilePicture: str | None = Field(
        None, alias="profile_picture", description="S3 URL of the profile picture"
    )
    platforms: list[PlatformRequest] | None = Field(None, min_length=1)
    audienceSize: int | None = Field(None, alias="audience_size", gt=0)
    creatorType: Literal["Lifestyle", "Travel"] | None = Field(None, alias="creator_type")

    @model_validator(mode="after")
    def validate_audience_size(self):
        """Calculate audience size if platforms are provided and audienceSize is not"""
        if self.platforms is not None and self.audienceSize is None:
            self.audienceSize = sum(p.followers for p in self.platforms)
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# REVIEWS & RATINGS
# ============================================


class ReviewResponse(BaseModel):
    """Review response model"""

    id: str
    hotelId: str | None = Field(None, alias="hotel_id")
    hotelName: str | None = Field(None, alias="hotel_name")
    rating: int
    comment: str | None = None
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class RatingResponse(BaseModel):
    """Rating summary response model"""

    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: list[ReviewResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# PROFILE RESPONSES
# ============================================


class CreatorProfileFullResponse(BaseModel):
    """Full creator profile response model for GET /creators/me"""

    id: str
    name: str
    email: str
    phone: str | None = None
    location: str
    portfolioLink: str | None = Field(None, alias="portfolio_link")
    shortDescription: str | None = Field(None, alias="short_description")
    profilePicture: str | None = Field(None, alias="profile_picture")
    creatorType: str = Field(alias="creator_type")
    platforms: list[PlatformResponse]
    rating: RatingResponse
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorProfileResponse(BaseModel):
    """Creator profile response model"""

    id: str
    name: str
    location: str
    shortDescription: str = Field(alias="short_description")
    portfolioLink: str | None = Field(None, alias="portfolio_link")
    phone: str | None = None
    profilePicture: str | None = Field(None, alias="profile_picture")
    creatorType: str = Field(alias="creator_type")
    platforms: list[PlatformResponse]
    audienceSize: int = Field(alias="audience_size")
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# COLLABORATION VIEWS (Creator Perspective)
# ============================================


class CreatorCollaborationListResponse(BaseModel):
    """Slim response for collaboration list view (creator perspective)"""

    id: str
    initiatorType: str = Field(alias="initiator_type")
    isInitiator: bool = Field(alias="is_initiator")
    status: str
    createdAt: datetime = Field(alias="created_at")
    whyGreatFit: str | None = Field(None, alias="why_great_fit")

    # Hotel/Listing Summary
    hotelId: str = Field(alias="hotel_id")
    hotelName: str = Field(alias="hotel_name")
    hotelProfilePicture: str | None = Field(None, alias="hotel_profile_picture")
    listingId: str = Field(alias="listing_id")
    listingName: str = Field(alias="listing_name")
    listingLocation: str = Field(alias="listing_location")
    listingImages: list[str] = Field(default_factory=list, alias="listing_images")

    collaborationType: str | None = Field(None, alias="collaboration_type")
    travelDateFrom: date | None = Field(None, alias="travel_date_from")
    travelDateTo: date | None = Field(None, alias="travel_date_to")

    # Term specifics
    freeStayMinNights: int | None = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: int | None = Field(None, alias="free_stay_max_nights")
    paidAmount: Decimal | None = Field(None, alias="paid_amount")
    currency: str | None = Field(None, description="ISO 4217 currency code for paidAmount")
    discountPercentage: int | None = Field(None, alias="discount_percentage")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorCollaborationDetailResponse(CreatorCollaborationListResponse):
    """Detailed response for modal view (creator perspective)"""

    # Extended Hotel Details
    hotelLocation: str = Field(alias="hotel_location")
    hotelWebsite: str | None = Field(None, alias="hotel_website")
    hotelAbout: str | None = Field(None, alias="hotel_about")
    hotelPhone: str | None = Field(None, alias="hotel_phone")

    # Listing Requirements (Looking for)
    creatorRequirements: CreatorRequirementsResponse | None = Field(
        None, alias="creator_requirements"
    )

    # Listing's allowed collaboration types
    allowedCollaborationTypes: list[str] = Field(
        default_factory=list, alias="allowed_collaboration_types"
    )

    # Collaboration terms
    preferredDateFrom: date | None = Field(None, alias="preferred_date_from")
    preferredDateTo: date | None = Field(None, alias="preferred_date_to")
    preferredMonths: list[str] | None = Field(None, alias="preferred_months")
    platformDeliverables: list[dict] = Field(default_factory=list, alias="platform_deliverables")
    consent: bool | None = None

    updatedAt: datetime = Field(alias="updated_at")
    respondedAt: datetime | None = Field(None, alias="responded_at")
    cancelledAt: datetime | None = Field(None, alias="cancelled_at")
    completedAt: datetime | None = Field(None, alias="completed_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
