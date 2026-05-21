"""
Admin-specific Pydantic models
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.models.collaborations import CollaborationResponse
from app.models.common import (
    PlatformResponse,
)
from app.models.hotels import CreateListingRequest, ListingResponse

# ============================================
# USER LIST/RESPONSE MODELS
# ============================================


class UserResponse(BaseModel):
    """User response model"""

    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: str | None = None
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response"""

    users: list[UserResponse]
    total: int


# ============================================
# COLLABORATION LIST RESPONSE
# ============================================


class CollaborationListResponse(BaseModel):
    """Admin collaboration list response"""

    collaborations: list[CollaborationResponse]
    total: int


# ============================================
# PLATFORM REQUEST (Admin version with ConfigDict)
# ============================================


class AdminPlatformRequest(BaseModel):
    """Platform request model for creating platforms (admin)"""

    name: Literal["Instagram", "TikTok", "YouTube", "Facebook"]
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: list[dict] | None = Field(None, alias="top_countries")
    topAgeGroups: list[dict] | None = Field(None, alias="top_age_groups")
    genderSplit: dict | None = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATE USER REQUESTS
# ============================================


class CreateCreatorProfileRequest(BaseModel):
    """Creator profile data for admin user creation"""

    location: str | None = None
    shortDescription: str | None = Field(None, alias="short_description")
    portfolioLink: str | None = Field(None, alias="portfolio_link")
    phone: str | None = None
    profilePicture: str | None = Field(None, alias="profile_picture")
    platforms: list[AdminPlatformRequest] | None = None

    model_config = ConfigDict(populate_by_name=True)


class CreateHotelProfileRequest(BaseModel):
    """Hotel profile data for admin user creation"""

    name: str | None = None
    location: str | None = None
    about: str | None = None
    website: str | None = None
    phone: str | None = None
    listings: list[CreateListingRequest] | None = None

    model_config = ConfigDict(populate_by_name=True)


class CreateUserRequest(BaseModel):
    """Request model for creating a user"""

    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str
    type: Literal["creator", "hotel"]
    status: Literal["pending", "verified", "rejected", "suspended"] | None = "pending"
    emailVerified: bool = Field(False, alias="email_verified")
    avatar: str | None = None
    creatorProfile: CreateCreatorProfileRequest | None = Field(None, alias="creator_profile")
    hotelProfile: CreateHotelProfileRequest | None = Field(None, alias="hotel_profile")

    @model_validator(mode="after")
    def validate_profile_type(self):
        if self.type == "creator" and self.hotelProfile:
            raise ValueError("Cannot provide hotel_profile for creator user")
        if self.type == "hotel" and self.creatorProfile:
            raise ValueError("Cannot provide creator_profile for hotel user")
        return self

    model_config = ConfigDict(populate_by_name=True)


class UpdateUserRequest(BaseModel):
    """Request model for updating user fields (status, emailVerified, name, email)"""

    name: str | None = None
    email: EmailStr | None = None
    status: Literal["pending", "verified", "rejected", "suspended"] | None = None
    emailVerified: bool | None = Field(None, alias="email_verified")
    avatar: str | None = None

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# USER DETAIL RESPONSES (nested profile info)
# ============================================


class AdminPlatformResponse(BaseModel):
    """Platform response model for creator platforms (admin detail view)"""

    id: str
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: list[dict] | None = Field(None, alias="top_countries")
    topAgeGroups: list[dict] | None = Field(None, alias="top_age_groups")
    genderSplit: dict | None = Field(None, alias="gender_split")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True)


class CreatorProfileDetail(BaseModel):
    """Creator profile detail"""

    id: str
    userId: str = Field(alias="user_id")
    location: str | None = None
    shortDescription: str | None = Field(None, alias="short_description")
    portfolioLink: str | None = Field(None, alias="portfolio_link")
    phone: str | None = None
    profilePicture: str | None = Field(None, alias="profile_picture")
    profileComplete: bool = Field(alias="profile_complete")
    profileCompletedAt: datetime | None = Field(None, alias="profile_completed_at")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    platforms: list[PlatformResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class AdminCollaborationOfferingResponse(BaseModel):
    """Collaboration offering response model (admin - snake_case)"""

    id: str
    listing_id: str
    collaboration_type: str
    availability_months: list[str]
    platforms: list[str]
    free_stay_min_nights: int | None = None
    free_stay_max_nights: int | None = None
    paid_max_amount: Decimal | None = None
    currency: str | None = None
    discount_percentage: Decimal | None = None
    created_at: datetime
    updated_at: datetime


class AdminCreatorRequirementsResponse(BaseModel):
    """Creator requirements response model (admin - snake_case)"""

    id: str
    listing_id: str
    platforms: list[str]
    top_countries: list[str] | None = Field(
        None, alias="target_countries", description="Top Countries of the audience"
    )
    target_age_min: int | None = None
    target_age_max: int | None = None
    target_age_groups: list[str] | None = None
    created_at: datetime
    updated_at: datetime


class AdminListingResponse(BaseModel):
    """Listing response model (admin - snake_case)"""

    id: str
    hotel_profile_id: str
    name: str
    location: str
    description: str | None = None
    accommodation_type: str
    images: list[str] = Field(default_factory=list)
    status: str
    created_at: datetime
    updated_at: datetime
    collaboration_offerings: list[AdminCollaborationOfferingResponse] = Field(default_factory=list)
    creator_requirements: AdminCreatorRequirementsResponse | None = None


class HotelProfileDetail(BaseModel):
    """Hotel profile detail"""

    id: str
    userId: str = Field(alias="user_id")
    name: str
    location: str
    picture: str | None = None
    website: str | None = None
    about: str | None = None
    email: str
    phone: str | None = None
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    listings: list[ListingResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class UserDetailResponse(BaseModel):
    """User detail response"""

    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: str | None = None
    created_at: datetime
    updated_at: datetime
    profile: CreatorProfileDetail | HotelProfileDetail | None = None
