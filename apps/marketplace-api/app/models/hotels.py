"""
Hotel-related Pydantic models
"""
from pydantic import BaseModel, Field, HttpUrl, EmailStr, field_validator, model_validator, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, date
from decimal import Decimal

from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
    PlatformResponse,
)


# ============================================
# PROFILE STATUS
# ============================================

class HotelProfileStatusHasDefaults(BaseModel):
    """Nested model for default value flags"""
    location: bool


class HotelProfileStatusResponse(BaseModel):
    """Hotel profile status response model"""
    profile_complete: bool
    missing_fields: List[str]
    has_defaults: HotelProfileStatusHasDefaults
    missing_listings: bool
    completion_steps: List[str]


# ============================================
# PROFILE UPDATE
# ============================================

class UpdateHotelProfileRequest(BaseModel):
    """Request model for updating hotel profile (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=2)
    location: Optional[str] = Field(None, min_length=1)
    email: Optional[EmailStr] = None
    about: Optional[str] = Field(None, min_length=10, max_length=5000)
    website: Optional[HttpUrl] = None
    phone: Optional[str] = None
    picture: Optional[HttpUrl] = None

    @field_validator('location')
    @classmethod
    def validate_location_not_default(cls, v):
        """Ensure location is not the default value"""
        if v is not None and v.strip() == 'Not specified':
            raise ValueError('Location must be updated from default value')
        return v


# ============================================
# PROFILE RESPONSE
# ============================================

class HotelProfileResponse(BaseModel):
    """Hotel profile response model"""
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    name: str
    location: str
    email: str
    about: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    picture: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime
    listings: List[dict] = Field(default_factory=list)


# ============================================
# COLLABORATION OFFERING REQUEST
# ============================================

class CollaborationOfferingRequest(BaseModel):
    """Collaboration offering request model"""
    collaborationType: Literal["Free Stay", "Paid", "Discount"] = Field(alias="collaboration_type")
    availabilityMonths: List[str] = Field(..., min_length=1, alias="availability_months")
    platforms: List[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(..., min_length=1)
    freeStayMinNights: Optional[int] = Field(None, gt=0, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, gt=0, alias="free_stay_max_nights")
    paidMaxAmount: Optional[Decimal] = Field(None, gt=0, alias="paid_max_amount")
    discountPercentage: Optional[int] = Field(None, ge=1, le=100, alias="discount_percentage")

    @model_validator(mode='after')
    def validate_type_specific_fields(self):
        """Validate type-specific fields are present"""
        if self.collaborationType == "Free Stay":
            if self.freeStayMinNights is None or self.freeStayMaxNights is None:
                raise ValueError("free_stay_min_nights and free_stay_max_nights are required for Free Stay")
            if self.freeStayMaxNights < self.freeStayMinNights:
                raise ValueError("free_stay_max_nights must be >= free_stay_min_nights")
        elif self.collaborationType == "Paid":
            if self.paidMaxAmount is None:
                raise ValueError("paid_max_amount is required for Paid collaboration")
        elif self.collaborationType == "Discount":
            if self.discountPercentage is None:
                raise ValueError("discount_percentage is required for Discount collaboration")
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATOR REQUIREMENTS REQUEST
# ============================================

class CreatorRequirementsRequest(BaseModel):
    """Creator requirements request model"""
    platforms: List[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(..., min_length=1)
    minFollowers: Optional[int] = Field(None, gt=0, alias="min_followers")
    topCountries: Optional[List[str]] = Field(None, alias="target_countries", description="Top Countries of the audience")
    targetAgeMin: Optional[int] = Field(None, ge=0, le=100, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, ge=0, le=100, alias="target_age_max")
    targetAgeGroups: Optional[List[str]] = Field(None, alias="target_age_groups")

    @model_validator(mode='after')
    def validate_age_range(self):
        """Validate age range and derive min/max from groups if provided"""
        if self.targetAgeGroups:
            min_age = None
            max_age = None

            # Map standard buckets to numerical ranges
            # Buckets: '18-24', '25-34', '35-44', '45-54', '55+'
            for group in self.targetAgeGroups:
                low = None
                high = None

                if group == "55+":
                    low, high = 55, 100
                elif "-" in group:
                    try:
                        pts = group.split("-")
                        low = int(pts[0])
                        high = int(pts[1])
                    except (ValueError, IndexError):
                        continue

                if low is not None and high is not None:
                    if min_age is None or low < min_age:
                        min_age = low
                    if max_age is None or high > max_age:
                        max_age = high

            # Auto-calculate min/max if not manually provided
            # This ensures numerical fields are populated for search efficiency
            if self.targetAgeMin is None and min_age is not None:
                self.targetAgeMin = min_age
            if self.targetAgeMax is None and max_age is not None:
                self.targetAgeMax = max_age

        if self.targetAgeMin is not None and self.targetAgeMax is not None:
            if self.targetAgeMax < self.targetAgeMin:
                raise ValueError("target_age_max must be >= target_age_min")
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# LISTING REQUESTS
# ============================================

class CreateListingRequest(BaseModel):
    """Request model for creating hotel listing"""
    name: str = Field(..., min_length=1)
    location: str = Field(..., min_length=1)
    description: str = Field(..., min_length=10)
    accommodationType: Optional[Literal["Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"]] = Field(None, alias="accommodation_type")
    images: List[str] = Field(default_factory=list)
    collaborationOfferings: List[CollaborationOfferingRequest] = Field(..., min_length=1, alias="collaboration_offerings")
    creatorRequirements: CreatorRequirementsRequest = Field(alias="creator_requirements")

    model_config = ConfigDict(populate_by_name=True)


class UpdateListingRequest(BaseModel):
    """Request model for updating hotel listing (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=1)
    location: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = Field(None, min_length=10)
    accommodationType: Optional[Literal["Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"]] = Field(None, alias="accommodation_type")
    images: Optional[List[str]] = None
    collaborationOfferings: Optional[List[CollaborationOfferingRequest]] = Field(None, alias="collaboration_offerings")
    creatorRequirements: Optional[CreatorRequirementsRequest] = Field(None, alias="creator_requirements")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# LISTING RESPONSE
# ============================================

class ListingResponse(BaseModel):
    """Listing response model"""
    id: str
    hotelProfileId: str = Field(alias="hotel_profile_id")
    name: str
    location: str
    description: str
    accommodationType: Optional[str] = Field(None, alias="accommodation_type")
    images: List[str]
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    collaborationOfferings: List[CollaborationOfferingResponse] = Field(alias="collaboration_offerings")
    creatorRequirements: Optional[CreatorRequirementsResponse] = Field(None, alias="creator_requirements")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# CREATOR METRICS (for hotel collaboration views)
# ============================================

class CreatorPlatformDetail(BaseModel):
    """Detailed creator platform metrics"""
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


class CreatorReview(BaseModel):
    """Review item for creator reputation"""
    id: str
    rating: int
    comment: Optional[str]
    organizationName: str = Field(alias="organization_name")
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True)


class CreatorReputation(BaseModel):
    """Creator reputation metrics"""
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: List[CreatorReview] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# COLLABORATION VIEWS (Hotel Perspective)
# ============================================

class HotelCollaborationListResponse(BaseModel):
    """Slim response for collaboration list view"""
    id: str
    initiatorType: str = Field(alias="initiator_type")
    isInitiator: bool = Field(alias="is_initiator")
    status: str
    createdAt: datetime = Field(alias="created_at")
    whyGreatFit: Optional[str] = Field(None, alias="why_great_fit")

    # Creator Summary
    creatorId: str = Field(alias="creator_id")
    name: str = Field(alias="creator_name")
    profilePicture: Optional[str] = Field(None, alias="creator_profile_picture")
    handle: Optional[str] = Field(None, alias="primary_handle", description="Primary handle (highest followers)")
    location: Optional[str] = Field(None, alias="creator_location")
    totalFollowers: int = Field(0, alias="total_followers")
    avgEngagementRate: float = Field(0.0, alias="avg_engagement_rate")
    activePlatform: Optional[str] = Field(None, alias="active_platform")
    isVerified: bool = Field(False, alias="is_verified")
    platformDeliverables: List[dict] = Field(default_factory=list, alias="platform_deliverables")
    travelDateFrom: Optional[date] = Field(None, alias="travel_date_from")
    travelDateTo: Optional[date] = Field(None, alias="travel_date_to")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class HotelCollaborationDetailResponse(HotelCollaborationListResponse):
    """Detailed response for modal view (extends list response)"""
    # Extended Creator Analytics
    platforms: List[CreatorPlatformDetail] = Field(default_factory=list)
    reputation: Optional[CreatorReputation] = None

    # Request Specifics
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")

    # Other metadata (optional but useful)
    hotelId: str = Field(alias="hotel_id")
    hotelName: str = Field(alias="hotel_name")
    listingId: str = Field(alias="listing_id")
    listingName: str = Field(alias="listing_name")
    listingLocation: str = Field(alias="listing_location")

    # Collaboration terms
    collaborationType: Optional[str] = Field(None, alias="collaboration_type")
    discountPercentage: Optional[int] = Field(None, alias="discount_percentage")
    paidAmount: Optional[Decimal] = Field(None, alias="paid_amount")
    freeStayMinNights: Optional[int] = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, alias="free_stay_max_nights")
    preferredDateFrom: Optional[date] = Field(None, alias="preferred_date_from")
    preferredDateTo: Optional[date] = Field(None, alias="preferred_date_to")
    preferredMonths: Optional[List[str]] = Field(None, alias="preferred_months")
    consent: Optional[bool] = None

    updatedAt: datetime = Field(alias="updated_at")
    respondedAt: Optional[datetime] = Field(None, alias="responded_at")
    cancelledAt: Optional[datetime] = Field(None, alias="cancelled_at")
    completedAt: Optional[datetime] = Field(None, alias="completed_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
