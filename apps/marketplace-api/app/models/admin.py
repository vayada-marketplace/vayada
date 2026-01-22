"""
Admin-specific Pydantic models
"""
from pydantic import BaseModel, Field, EmailStr, model_validator, ConfigDict
from typing import List, Optional, Union, Literal
from datetime import datetime
from decimal import Decimal

from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
    PlatformResponse,
)
from app.models.collaborations import CollaborationResponse
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
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response"""
    users: List[UserResponse]
    total: int


# ============================================
# COLLABORATION LIST RESPONSE
# ============================================

class CollaborationListResponse(BaseModel):
    """Admin collaboration list response"""
    collaborations: List[CollaborationResponse]
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
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True)


# ============================================
# CREATE USER REQUESTS
# ============================================

class CreateCreatorProfileRequest(BaseModel):
    """Creator profile data for admin user creation"""
    location: Optional[str] = None
    shortDescription: Optional[str] = Field(None, alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: Optional[List[AdminPlatformRequest]] = None

    model_config = ConfigDict(populate_by_name=True)


class CreateHotelProfileRequest(BaseModel):
    """Hotel profile data for admin user creation"""
    name: Optional[str] = None
    location: Optional[str] = None
    about: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    listings: Optional[List[CreateListingRequest]] = None

    model_config = ConfigDict(populate_by_name=True)


class CreateUserRequest(BaseModel):
    """Request model for creating a user"""
    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str
    type: Literal["creator", "hotel"]
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = "pending"
    emailVerified: bool = Field(False, alias="email_verified")
    avatar: Optional[str] = None
    creatorProfile: Optional[CreateCreatorProfileRequest] = Field(None, alias="creator_profile")
    hotelProfile: Optional[CreateHotelProfileRequest] = Field(None, alias="hotel_profile")

    @model_validator(mode='after')
    def validate_profile_type(self):
        if self.type == "creator" and self.hotelProfile:
            raise ValueError("Cannot provide hotel_profile for creator user")
        if self.type == "hotel" and self.creatorProfile:
            raise ValueError("Cannot provide creator_profile for hotel user")
        return self

    model_config = ConfigDict(populate_by_name=True)


class UpdateUserRequest(BaseModel):
    """Request model for updating user fields (status, emailVerified, name, email)"""
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = None
    emailVerified: Optional[bool] = Field(None, alias="email_verified")
    avatar: Optional[str] = None

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
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True)


class CreatorProfileDetail(BaseModel):
    """Creator profile detail"""
    id: str
    userId: str = Field(alias="user_id")
    location: Optional[str] = None
    shortDescription: Optional[str] = Field(None, alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    phone: Optional[str] = None
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    profileComplete: bool = Field(alias="profile_complete")
    profileCompletedAt: Optional[datetime] = Field(None, alias="profile_completed_at")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    platforms: List[PlatformResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class AdminCollaborationOfferingResponse(BaseModel):
    """Collaboration offering response model (admin - snake_case)"""
    id: str
    listing_id: str
    collaboration_type: str
    availability_months: List[str]
    platforms: List[str]
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_max_amount: Optional[Decimal] = None
    discount_percentage: Optional[Decimal] = None
    created_at: datetime
    updated_at: datetime


class AdminCreatorRequirementsResponse(BaseModel):
    """Creator requirements response model (admin - snake_case)"""
    id: str
    listing_id: str
    platforms: List[str]
    min_followers: Optional[int] = None
    top_countries: Optional[List[str]] = Field(None, alias="target_countries", description="Top Countries of the audience")
    target_age_min: Optional[int] = None
    target_age_max: Optional[int] = None
    target_age_groups: Optional[List[str]] = None
    created_at: datetime
    updated_at: datetime


class AdminListingResponse(BaseModel):
    """Listing response model (admin - snake_case)"""
    id: str
    hotel_profile_id: str
    name: str
    location: str
    description: Optional[str] = None
    accommodation_type: str
    images: List[str] = Field(default_factory=list)
    status: str
    created_at: datetime
    updated_at: datetime
    collaboration_offerings: List[AdminCollaborationOfferingResponse] = Field(default_factory=list)
    creator_requirements: Optional[AdminCreatorRequirementsResponse] = None


class HotelProfileDetail(BaseModel):
    """Hotel profile detail"""
    id: str
    userId: str = Field(alias="user_id")
    name: str
    location: str
    picture: Optional[str] = None
    website: Optional[str] = None
    about: Optional[str] = None
    email: str
    phone: Optional[str] = None
    status: str
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    listings: List[ListingResponse] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class UserDetailResponse(BaseModel):
    """User detail response"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    profile: Optional[Union[CreatorProfileDetail, HotelProfileDetail]] = None
