"""
Common/shared Pydantic models used across multiple domains
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

# ============================================
# PLATFORM MODELS (shared by creators, hotels, admin)
# ============================================


class TopCountry(BaseModel):
    """Top country analytics data"""

    country: str | None = None
    percentage: float | None = Field(
        None, ge=0, le=100, description="Audience share for the country (0-100)"
    )


class TopAgeGroup(BaseModel):
    """Top age group analytics data"""

    ageRange: str | None = None
    percentage: float | None = Field(
        None, ge=0, le=100, description="Audience share for the age group (0-100)"
    )


class GenderSplit(BaseModel):
    """Gender split analytics data"""

    male: float = Field(..., ge=0, le=100)
    female: float = Field(..., ge=0, le=100)


# ============================================
# COLLABORATION OFFERING MODELS (shared by hotels, marketplace, admin)
# ============================================


class CollaborationOfferingResponse(BaseModel):
    """Collaboration offering response model"""

    id: str
    listingId: str = Field(alias="listing_id")
    collaborationType: str = Field(alias="collaboration_type")
    availabilityMonths: list[str] = Field(alias="availability_months")
    platforms: list[str]
    freeStayMinNights: int | None = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: int | None = Field(None, alias="free_stay_max_nights")
    paidMaxAmount: Decimal | None = Field(None, alias="paid_max_amount")
    currency: str | None = Field(None, description="ISO 4217 currency code for paid offerings")
    discountPercentage: int | None = Field(None, alias="discount_percentage")
    commissionPercentage: int | None = Field(None, alias="commission_percentage")
    minFollowers: int | None = Field(None, alias="min_followers")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# CREATOR REQUIREMENTS MODELS (shared by hotels, marketplace, creators, admin)
# ============================================


class CreatorRequirementsResponse(BaseModel):
    """Creator requirements response model"""

    id: str
    listingId: str = Field(alias="listing_id")
    platforms: list[str]
    topCountries: list[str] | None = Field(
        None, alias="target_countries", description="Top Countries of the audience"
    )
    targetAgeMin: int | None = Field(None, alias="target_age_min")
    targetAgeMax: int | None = Field(None, alias="target_age_max")
    targetAgeGroups: list[str] | None = Field(None, alias="target_age_groups")
    creatorTypes: list[str] | None = Field(None, alias="creator_types")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ============================================
# PLATFORM RESPONSE (shared by creators, hotels, marketplace)
# ============================================


class PlatformResponse(BaseModel):
    """Platform response model"""

    id: str
    name: str
    handle: str
    followers: int
    engagementRate: float = Field(alias="engagement_rate")
    topCountries: list[dict] | None = Field(None, alias="top_countries")
    topAgeGroups: list[dict] | None = Field(None, alias="top_age_groups")
    genderSplit: dict | None = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
