"""
Hotel-related Pydantic models
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    HttpUrl,
    field_validator,
    model_validator,
)

from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
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
    missing_fields: list[str]
    has_defaults: HotelProfileStatusHasDefaults
    missing_listings: bool
    completion_steps: list[str]


# ============================================
# PROFILE UPDATE
# ============================================


class UpdateHotelProfileRequest(BaseModel):
    """Request model for updating hotel profile (partial updates supported)"""

    name: str | None = Field(None, min_length=2)
    location: str | None = Field(None, min_length=1)
    email: EmailStr | None = None
    about: str | None = Field(None, min_length=10, max_length=5000)
    website: HttpUrl | None = None
    phone: str | None = None
    picture: HttpUrl | None = None

    @field_validator("location")
    @classmethod
    def validate_location_not_default(cls, v):
        """Ensure location is not the default value"""
        if v is not None and v.strip() == "Not specified":
            raise ValueError("Location must be updated from default value")
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
    about: str | None = None
    website: str | None = None
    phone: str | None = None
    picture: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime
    listings: list[dict] = Field(default_factory=list)


# ============================================
# COLLABORATION OFFERING REQUEST
# ============================================


class CollaborationOfferingRequest(BaseModel):
    """Collaboration offering request model"""

    collaborationType: Literal["Free Stay", "Paid", "Discount", "Affiliate"] = Field(
        alias="collaboration_type"
    )
    availabilityMonths: list[str] = Field(..., min_length=1, alias="availability_months")
    platforms: list[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(
        ..., min_length=1
    )
    freeStayMinNights: int | None = Field(None, gt=0, alias="free_stay_min_nights")
    freeStayMaxNights: int | None = Field(None, gt=0, alias="free_stay_max_nights")
    paidMaxAmount: Decimal | None = Field(None, gt=0, alias="paid_max_amount")
    currency: str | None = Field(
        None,
        pattern=r"^[A-Z]{3}$",
        description="ISO 4217 currency code for paid offerings (defaults to USD server-side)",
    )
    discountPercentage: int | None = Field(None, ge=1, le=100, alias="discount_percentage")
    commissionPercentage: int | None = Field(None, ge=1, le=100, alias="commission_percentage")
    minFollowers: int | None = Field(None, gt=0, alias="min_followers")

    @model_validator(mode="after")
    def validate_type_specific_fields(self):
        """Validate type-specific fields are present"""
        if self.collaborationType == "Free Stay":
            if self.freeStayMinNights is None or self.freeStayMaxNights is None:
                raise ValueError(
                    "Minimum and maximum number of nights are required for Free Stay collaborations."
                )
            if self.freeStayMaxNights < self.freeStayMinNights:
                raise ValueError(
                    "Maximum number of nights must be greater than or equal to the minimum."
                )
        elif self.collaborationType == "Paid":
            if self.paidMaxAmount is None:
                raise ValueError("A maximum payment amount is required for Paid collaborations.")
        elif self.collaborationType == "Discount":
            if self.discountPercentage is None:
                raise ValueError("A discount percentage is required for Discount collaborations.")
        elif self.collaborationType == "Affiliate":
            if self.commissionPercentage is None:
                raise ValueError(
                    "A commission percentage is required for Affiliate collaborations."
                )
        return self

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATOR REQUIREMENTS REQUEST
# ============================================


class CreatorRequirementsRequest(BaseModel):
    """Creator requirements request model"""

    platforms: list[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(
        ..., min_length=1
    )
    topCountries: list[str] | None = Field(
        None, alias="target_countries", description="Top Countries of the audience"
    )
    targetAgeMin: int | None = Field(None, ge=0, le=100, alias="target_age_min")
    targetAgeMax: int | None = Field(None, ge=0, le=100, alias="target_age_max")
    targetAgeGroups: list[str] | None = Field(None, alias="target_age_groups")
    creatorTypes: list[Literal["Lifestyle", "Travel"]] | None = Field(None, alias="creator_types")

    @model_validator(mode="after")
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
                raise ValueError("Maximum target age must be greater than or equal to the minimum.")
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
    accommodationType: (
        Literal[
            "Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"
        ]
        | None
    ) = Field(None, alias="accommodation_type")
    images: list[str] = Field(default_factory=list)
    collaborationOfferings: list[CollaborationOfferingRequest] = Field(
        ..., min_length=1, alias="collaboration_offerings"
    )
    creatorRequirements: CreatorRequirementsRequest = Field(alias="creator_requirements")

    model_config = ConfigDict(populate_by_name=True)


class UpdateListingRequest(BaseModel):
    """Request model for updating hotel listing (partial updates supported)"""

    name: str | None = Field(None, min_length=1)
    location: str | None = Field(None, min_length=1)
    description: str | None = Field(None, min_length=10)
    accommodationType: (
        Literal[
            "Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"
        ]
        | None
    ) = Field(None, alias="accommodation_type")
    images: list[str] | None = None
    collaborationOfferings: list[CollaborationOfferingRequest] | None = Field(
        None, alias="collaboration_offerings"
    )
    creatorRequirements: CreatorRequirementsRequest | None = Field(
        None, alias="creator_requirements"
    )

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
    accommodationType: str | None = Field(None, alias="accommodation_type")
    images: list[str]
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    collaborationOfferings: list[CollaborationOfferingResponse] = Field(
        alias="collaboration_offerings"
    )
    creatorRequirements: CreatorRequirementsResponse | None = Field(
        None, alias="creator_requirements"
    )

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
    topCountries: list[dict] | None = Field(None, alias="top_countries")
    topAgeGroups: list[dict] | None = Field(None, alias="top_age_groups")
    genderSplit: dict | None = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


class CreatorReview(BaseModel):
    """Review item for creator reputation"""

    id: str
    rating: int
    comment: str | None
    organizationName: str = Field(alias="organization_name")
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True)


class CreatorReputation(BaseModel):
    """Creator reputation metrics"""

    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    reviews: list[CreatorReview] = Field(default_factory=list)

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
    whyGreatFit: str | None = Field(None, alias="why_great_fit")

    # Creator Summary
    creatorId: str = Field(alias="creator_id")
    name: str = Field(alias="creator_name")
    profilePicture: str | None = Field(None, alias="creator_profile_picture")
    handle: str | None = Field(
        None, alias="primary_handle", description="Primary handle (highest followers)"
    )
    location: str | None = Field(None, alias="creator_location")
    totalFollowers: int = Field(0, alias="total_followers")
    avgEngagementRate: float = Field(0.0, alias="avg_engagement_rate")
    activePlatform: str | None = Field(None, alias="active_platform")
    isVerified: bool = Field(False, alias="is_verified")
    platformDeliverables: list[dict] = Field(default_factory=list, alias="platform_deliverables")
    travelDateFrom: date | None = Field(None, alias="travel_date_from")
    travelDateTo: date | None = Field(None, alias="travel_date_to")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class HotelCollaborationDetailResponse(HotelCollaborationListResponse):
    """Detailed response for modal view (extends list response)"""

    # Extended Creator Analytics
    platforms: list[CreatorPlatformDetail] = Field(default_factory=list)
    reputation: CreatorReputation | None = None

    # Request Specifics
    portfolioLink: str | None = Field(None, alias="portfolio_link")

    # Other metadata (optional but useful)
    hotelId: str = Field(alias="hotel_id")
    hotelName: str = Field(alias="hotel_name")
    listingId: str = Field(alias="listing_id")
    listingName: str = Field(alias="listing_name")
    listingLocation: str = Field(alias="listing_location")

    # Collaboration terms
    collaborationType: str | None = Field(None, alias="collaboration_type")
    discountPercentage: int | None = Field(None, alias="discount_percentage")
    paidAmount: Decimal | None = Field(None, alias="paid_amount")
    currency: str | None = Field(None, description="ISO 4217 currency code for paidAmount")
    freeStayMinNights: int | None = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: int | None = Field(None, alias="free_stay_max_nights")
    preferredDateFrom: date | None = Field(None, alias="preferred_date_from")
    preferredDateTo: date | None = Field(None, alias="preferred_date_to")
    preferredMonths: list[str] | None = Field(None, alias="preferred_months")
    consent: bool | None = None

    updatedAt: datetime = Field(alias="updated_at")
    respondedAt: datetime | None = Field(None, alias="responded_at")
    cancelledAt: datetime | None = Field(None, alias="cancelled_at")
    completedAt: datetime | None = Field(None, alias="completed_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
