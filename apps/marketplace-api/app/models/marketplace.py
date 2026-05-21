"""
Marketplace-related Pydantic models
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

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
    hotelPicture: str | None = Field(None, alias="hotel_picture")
    ownerEmail: str | None = Field(None, alias="owner_email")
    ownerUserId: str | None = Field(None, alias="owner_user_id")
    name: str
    location: str
    description: str
    accommodationType: str | None = Field(None, alias="accommodation_type")
    images: list[str]
    status: str
    collaborationOfferings: list[CollaborationOfferingResponse] = Field(
        alias="collaboration_offerings"
    )
    creatorRequirements: CreatorRequirementsResponse | None = Field(
        None, alias="creator_requirements"
    )
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
    topCountries: list[dict] | None = Field(None, alias="top_countries")
    topAgeGroups: list[dict] | None = Field(None, alias="top_age_groups")
    genderSplit: dict | None = Field(None, alias="gender_split")

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
    portfolioLink: str | None = Field(None, alias="portfolio_link")
    profilePicture: str | None = Field(None, alias="profile_picture")
    creatorType: str = Field(alias="creator_type")
    platforms: list[PlatformMarketplaceResponse]
    audienceSize: int = Field(alias="audience_size")
    averageRating: float = Field(alias="average_rating")
    totalReviews: int = Field(alias="total_reviews")
    createdAt: datetime = Field(alias="created_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
