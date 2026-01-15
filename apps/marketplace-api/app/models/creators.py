"""
Creator-related Pydantic models
"""
from pydantic import BaseModel, Field, HttpUrl, model_validator, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, date
from decimal import Decimal

from app.models.common import (
    TopCountry,
    TopAgeGroup,
    GenderSplit,
    PlatformResponse,
    CreatorRequirementsResponse,
)


# ============================================
# PROFILE STATUS
# ============================================

class CreatorProfileStatusResponse(BaseModel):
    """Creator profile status response model"""
    profile_complete: bool
    missing_fields: List[str]
    missing_platforms: bool
    completion_steps: List[str]


# ============================================
# PLATFORM REQUEST
# ============================================

class PlatformRequest(BaseModel):
    """Platform request model"""
    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"]
    handle: str = Field(..., min_length=1)
    followers: int = Field(..., gt=0)
    engagementRate: float = Field(..., gt=0, alias="engagement_rate")
    topCountries: Optional[List[TopCountry]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[TopAgeGroup]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[GenderSplit] = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# PROFILE UPDATE
# ============================================

class UpdateCreatorProfileRequest(BaseModel):
    """Request model for updating creator profile (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=1)
    location: Optional[str] = Field(None, min_length=1)
    shortDescription: Optional[str] = Field(None, min_length=10, max_length=500, alias="short_description")
    portfolioLink: Optional[HttpUrl] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture", description="S3 URL of the profile picture")
    platforms: Optional[List[PlatformRequest]] = Field(None, min_length=1)
    audienceSize: Optional[int] = Field(None, alias="audience_size", gt=0)

    @model_validator(mode='after')
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
    hotelId: Optional[str] = Field(None, alias="hotel_id")
    hotelName: Optional[str] = Field(None, alias="hotel_name")
    rating: int
    comment: Optional[str] = None
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class RatingResponse(BaseModel):
    """Rating summary response model"""
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: List[ReviewResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# PROFILE RESPONSES
# ============================================

class CreatorProfileFullResponse(BaseModel):
    """Full creator profile response model for GET /creators/me"""
    id: str
    name: str
    email: str
    phone: Optional[str] = None
    location: str
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    shortDescription: Optional[str] = Field(None, alias="short_description")
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: List[PlatformResponse]
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
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: List[PlatformResponse]
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
    whyGreatFit: Optional[str] = Field(None, alias="why_great_fit")

    # Hotel/Listing Summary
    hotelId: str = Field(alias="hotel_id")
    hotelName: str = Field(alias="hotel_name")
    hotelProfilePicture: Optional[str] = Field(None, alias="hotel_profile_picture")
    listingId: str = Field(alias="listing_id")
    listingName: str = Field(alias="listing_name")
    listingLocation: str = Field(alias="listing_location")
    listingImages: List[str] = Field(default_factory=list, alias="listing_images")

    collaborationType: Optional[str] = Field(None, alias="collaboration_type")
    travelDateFrom: Optional[date] = Field(None, alias="travel_date_from")
    travelDateTo: Optional[date] = Field(None, alias="travel_date_to")

    # Term specifics
    freeStayMinNights: Optional[int] = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, alias="free_stay_max_nights")
    paidAmount: Optional[Decimal] = Field(None, alias="paid_amount")
    discountPercentage: Optional[int] = Field(None, alias="discount_percentage")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class CreatorCollaborationDetailResponse(CreatorCollaborationListResponse):
    """Detailed response for modal view (creator perspective)"""
    # Extended Hotel Details
    hotelLocation: str = Field(alias="hotel_location")
    hotelWebsite: Optional[str] = Field(None, alias="hotel_website")
    hotelAbout: Optional[str] = Field(None, alias="hotel_about")
    hotelPhone: Optional[str] = Field(None, alias="hotel_phone")

    # Listing Requirements (Looking for)
    creatorRequirements: Optional[CreatorRequirementsResponse] = Field(None, alias="creator_requirements")

    # Collaboration terms
    preferredDateFrom: Optional[date] = Field(None, alias="preferred_date_from")
    preferredDateTo: Optional[date] = Field(None, alias="preferred_date_to")
    preferredMonths: Optional[List[str]] = Field(None, alias="preferred_months")
    platformDeliverables: List[dict] = Field(default_factory=list, alias="platform_deliverables")
    consent: Optional[bool] = None

    updatedAt: datetime = Field(alias="updated_at")
    respondedAt: Optional[datetime] = Field(None, alias="responded_at")
    cancelledAt: Optional[datetime] = Field(None, alias="cancelled_at")
    completedAt: Optional[datetime] = Field(None, alias="completed_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
