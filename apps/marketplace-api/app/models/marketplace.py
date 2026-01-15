"""
Marketplace-related Pydantic models
"""
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
from datetime import datetime

from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
)


# ============================================
# LISTING RESPONSE
# ============================================

class ListingMarketplaceResponse(BaseModel):
    """Listing response model for marketplace"""
    id: str
    hotelProfileId: str = Field(alias="hotel_profile_id")
    hotelName: str = Field(alias="hotel_name")
    hotelPicture: Optional[str] = Field(None, alias="hotel_picture")
    name: str
    location: str
    description: str
    accommodationType: Optional[str] = Field(None, alias="accommodation_type")
    images: List[str]
    status: str
    collaborationOfferings: List[CollaborationOfferingResponse] = Field(alias="collaboration_offerings")
    creatorRequirements: Optional[CreatorRequirementsResponse] = Field(None, alias="creator_requirements")
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# PLATFORM RESPONSE
# ============================================

class PlatformMarketplaceResponse(BaseModel):
    """Platform response model for marketplace"""
    id: str
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# CREATOR RESPONSE
# ============================================

class CreatorMarketplaceResponse(BaseModel):
    """Creator response model for marketplace"""
    id: str
    name: str
    location: str
    shortDescription: str = Field(alias="short_description")
    portfolioLink: Optional[str] = Field(None, alias="portfolio_link")
    profilePicture: Optional[str] = Field(None, alias="profile_picture")
    platforms: List[PlatformMarketplaceResponse]
    audienceSize: int = Field(alias="audience_size")
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
