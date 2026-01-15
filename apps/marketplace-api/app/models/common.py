"""
Common/shared Pydantic models used across multiple domains
"""
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
from datetime import datetime
from decimal import Decimal


# ============================================
# PLATFORM MODELS (shared by creators, hotels, admin)
# ============================================

class TopCountry(BaseModel):
    """Top country analytics data"""
    country: Optional[str] = None
    percentage: Optional[float] = Field(
        None, ge=0, le=100, description="Audience share for the country (0-100)"
    )


class TopAgeGroup(BaseModel):
    """Top age group analytics data"""
    ageRange: Optional[str] = None
    percentage: Optional[float] = Field(
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
    availabilityMonths: List[str] = Field(alias="availability_months")
    platforms: List[str]
    freeStayMinNights: Optional[int] = Field(None, alias="free_stay_min_nights")
    freeStayMaxNights: Optional[int] = Field(None, alias="free_stay_max_nights")
    paidMaxAmount: Optional[Decimal] = Field(None, alias="paid_max_amount")
    discountPercentage: Optional[int] = Field(None, alias="discount_percentage")
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
    platforms: List[str]
    minFollowers: Optional[int] = Field(None, alias="min_followers")
    topCountries: Optional[List[str]] = Field(None, alias="target_countries", description="Top Countries of the audience")
    targetAgeMin: Optional[int] = Field(None, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, alias="target_age_max")
    targetAgeGroups: Optional[List[str]] = Field(None, alias="target_age_groups")
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
    topCountries: Optional[List[dict]] = Field(None, alias="top_countries")
    topAgeGroups: Optional[List[dict]] = Field(None, alias="top_age_groups")
    genderSplit: Optional[dict] = Field(None, alias="gender_split")

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)
