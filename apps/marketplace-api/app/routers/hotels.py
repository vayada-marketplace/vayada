"""
Hotel profile routes
"""
from fastapi import APIRouter, HTTPException, status as http_status, Depends, UploadFile, File, Form, Request, Query
from pydantic import BaseModel, Field, HttpUrl, EmailStr, field_validator, model_validator, ValidationError, ConfigDict
from typing import List, Optional, Literal
from datetime import datetime, date
from decimal import Decimal
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id
from app.email_service import send_email, create_profile_completion_email_html
from app.s3_service import upload_file_to_s3, generate_file_key
from app.image_processing import validate_image, process_image, generate_thumbnail, get_image_info
from app.config import settings
from app.auth import create_email_verification_token
import logging
import json

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hotels", tags=["hotels"])


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


@router.get("/me/profile-status", response_model=HotelProfileStatusResponse)
async def get_hotel_profile_status(user_id: str = Depends(get_current_user_id)):
    """
    Get the profile completion status for the currently authenticated hotel user.
    
    Returns:
    - profile_complete: Whether the profile is fully complete
    - missing_fields: Array of missing field names
    - has_defaults: Object indicating if location is using default value
    - missing_listings: Whether at least one property listing is missing
    - completion_steps: Human-readable steps to complete the profile
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        # Get hotel profile with email from users table
        hotel = await Database.fetchrow(
            """
            SELECT hp.id, hp.name, hp.location, hp.website, hp.about, hp.picture, hp.phone,
                   u.email
            FROM hotel_profiles hp
            JOIN users u ON hp.user_id = u.id
            WHERE hp.user_id = $1
            """,
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Check for listings
        listings = await Database.fetch(
            """
            SELECT id FROM hotel_listings
            WHERE hotel_profile_id = $1
            """,
            hotel['id']
        )
        
        missing_listings = len(listings) == 0
        
        # Determine missing fields and defaults
        missing_fields = []
        completion_steps = []
        has_default_location = False
        
        # Check name
        if not hotel['name'] or not hotel['name'].strip():
            missing_fields.append("name")
            completion_steps.append("Update your hotel name")
        
        # Check location (required field, but check if it's the default)
        if not hotel['location'] or not hotel['location'].strip():
            missing_fields.append("location")
            completion_steps.append("Set your location")
        elif hotel['location'].strip() == 'Not specified':
            has_default_location = True
            # Don't add to missing_fields - defaults are tracked separately
            completion_steps.append("Set a custom location (currently using default)")
        
        # Email is always in users table, so no need to check it here
        
        # Check optional but recommended fields
        if not hotel['about'] or not hotel['about'].strip():
            missing_fields.append("about")
            completion_steps.append("Add a description about your hotel")
        
        if not hotel['website'] or not hotel['website'].strip():
            missing_fields.append("website")
            completion_steps.append("Add your website URL")
        
        # Check for listings
        if missing_listings:
            completion_steps.append("Add at least one property listing")
        
        # Determine if profile is complete
        # Profile is complete when:
        # - All required fields are filled (name, location)
        # - Location is not using default value
        # - Optional fields like about and website are present (based on business logic)
        # - At least one listing exists
        # Note: Email is always in users table, so not checked here
        profile_complete = (
            len(missing_fields) == 0 and
            not has_default_location and
            not missing_listings
        )
        
        return HotelProfileStatusResponse(
            profile_complete=profile_complete,
            missing_fields=missing_fields,
            has_defaults=HotelProfileStatusHasDefaults(
                location=has_default_location
            ),
            missing_listings=missing_listings,
            completion_steps=completion_steps
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile status: {str(e)}"
        )


# Request/Response models for hotel profile update
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


# Request/Response models for listing creation
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


@router.get("/me", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
async def get_hotel_profile(user_id: str = Depends(get_current_user_id)):
    """
    Get the complete profile data for the currently authenticated hotel user.
    """
    try:
        user = await Database.fetchrow(
            "SELECT id, type, email, status FROM users WHERE id = $1",
            user_id
        )
        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        if user["type"] != "hotel":
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )

        hotel = await Database.fetchrow(
            """
            SELECT id, user_id, name, location, about, website, phone, picture,
                   status, created_at, updated_at
            FROM hotel_profiles
            WHERE user_id = $1
            """,
            user_id
        )
        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )

        listings_data = await Database.fetch(
            """
            SELECT id, hotel_profile_id, name, location, description, accommodation_type,
                   images, status, created_at, updated_at
            FROM hotel_listings
            WHERE hotel_profile_id = $1
            ORDER BY created_at DESC
            """,
            hotel["id"]
        )

        listings_response: List[dict] = []
        for listing in listings_data:
            offerings_data = await Database.fetch(
                """
                SELECT id, listing_id, collaboration_type, availability_months, platforms,
                       free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                       created_at, updated_at
                FROM listing_collaboration_offerings
                WHERE listing_id = $1
                ORDER BY created_at DESC
                """,
                listing["id"]
            )
            offerings_response = [
                CollaborationOfferingResponse.model_validate(
                    {
                        "id": str(o["id"]),
                        "listing_id": str(o["listing_id"]),
                        "collaboration_type": o["collaboration_type"],
                        "availability_months": o["availability_months"],
                        "platforms": o["platforms"],
                        "free_stay_min_nights": o["free_stay_min_nights"],
                        "free_stay_max_nights": o["free_stay_max_nights"],
                        "paid_max_amount": o["paid_max_amount"],
                        "discount_percentage": o["discount_percentage"],
                        "created_at": o["created_at"],
                        "updated_at": o["updated_at"],
                    }
                ).model_dump(by_alias=True)
                for o in offerings_data
            ]

            requirements = await Database.fetchrow(
                """
                SELECT id, listing_id, platforms, min_followers, target_countries,
                       target_age_min, target_age_max, target_age_groups, created_at, updated_at
                FROM listing_creator_requirements
                WHERE listing_id = $1
                """,
                listing["id"]
            )
            requirements_response = None
            if requirements:
                requirements_response = CreatorRequirementsResponse.model_validate(
                    {
                        "id": str(requirements["id"]),
                        "listing_id": str(listing["id"]),
                        "platforms": requirements["platforms"],
                        "min_followers": requirements["min_followers"],
                        "target_countries": requirements["target_countries"],
                        "target_age_min": requirements["target_age_min"],
                        "target_age_max": requirements["target_age_max"],
                        "target_age_groups": requirements["target_age_groups"],
                        "created_at": requirements["created_at"],
                        "updated_at": requirements["updated_at"],
                    }
                ).model_dump(by_alias=True)

            listings_response.append(
                ListingResponse.model_validate(
                    {
                        "id": str(listing["id"]),
                        "hotel_profile_id": str(listing["hotel_profile_id"]),
                        "name": listing["name"],
                        "location": listing["location"],
                        "description": listing["description"],
                        "accommodation_type": listing["accommodation_type"],
                        "images": listing["images"] or [],
                        "status": listing["status"],
                        "created_at": listing["created_at"],
                        "updated_at": listing["updated_at"],
                        "collaboration_offerings": offerings_response,
                        "creator_requirements": requirements_response,
                    }
                ).model_dump(by_alias=True)
            )

        return HotelProfileResponse(
            id=str(hotel["id"]),
            user_id=str(hotel["user_id"]),
            name=hotel["name"],
            location=hotel["location"],
            email=user["email"],
            about=hotel["about"],
            website=hotel["website"],
            phone=hotel["phone"],
            picture=hotel["picture"],
            status=hotel["status"],
            created_at=hotel["created_at"],
            updated_at=hotel["updated_at"],
            listings=listings_response,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile: {str(e)}"
        )


@router.put("/me", response_model=HotelProfileResponse, status_code=http_status.HTTP_200_OK)
async def update_hotel_profile(
    http_request: Request,
    name: Optional[str] = Form(default=None),
    location: Optional[str] = Form(default=None),
    email: Optional[EmailStr] = Form(default=None),
    about: Optional[str] = Form(default=None),
    website: Optional[str] = Form(default=None),
    phone: Optional[str] = Form(default=None),
    picture: Optional[UploadFile] = File(default=None),
    user_id: str = Depends(get_current_user_id)
):
    """
    Update the currently authenticated hotel's profile.
    Supports partial updates - only provided fields will be updated.
    
    Accepts either:
    - JSON body (UpdateHotelProfileRequest) for text fields
    - multipart/form-data for file uploads (picture) and text fields
    
    If JSON body is provided, it takes precedence over Form fields.
    """
    try:
        # Check if request is JSON and parse it
        # FastAPI will parse Form data if content-type is multipart/form-data
        # For JSON requests, we need to manually parse the body
        content_type = http_request.headers.get("content-type", "")
        
        # If it's JSON (not multipart), parse JSON body
        picture_url_from_json = None
        if "application/json" in content_type and "multipart/form-data" not in content_type:
            try:
                json_data = await http_request.json()
                request = UpdateHotelProfileRequest(**json_data)
                # Use JSON body values
                name = request.name
                location = request.location
                email = request.email
                about = request.about
                website = str(request.website) if request.website is not None else None
                phone = request.phone
                # Extract picture URL from JSON if provided
                picture_url_from_json = str(request.picture) if request.picture is not None else None
            except ValidationError as e:
                # Re-raise validation errors as HTTP 422
                # Convert errors to JSON-serializable format
                import json
                errors = []
                for error in e.errors():
                    # Ensure all values in error dict are JSON serializable
                    serializable_error = {}
                    for key, value in error.items():
                        if key == 'loc':
                            # Convert location tuple/list to list of strings
                            serializable_error[key] = [str(v) for v in value] if value else []
                        elif key == 'ctx' and value:
                            # Convert context dict to string if it contains non-serializable values
                            try:
                                json.dumps(value)
                                serializable_error[key] = value
                            except (TypeError, ValueError):
                                serializable_error[key] = str(value)
                        else:
                            # Convert other values to strings if not JSON serializable
                            try:
                                json.dumps(value)
                                serializable_error[key] = value
                            except (TypeError, ValueError):
                                serializable_error[key] = str(value)
                    errors.append(serializable_error)
                raise HTTPException(
                    status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=errors
                )
            except Exception as e:
                logger.warning(f"Failed to parse JSON body: {e}")
                # If JSON parsing fails, continue with Form data (if any)
        
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type, email FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        # Get current hotel profile with completion status
        hotel = await Database.fetchrow(
            """
            SELECT id, user_id, name, location, about, website, phone, picture,
                   status, created_at, updated_at, profile_complete
            FROM hotel_profiles
            WHERE user_id = $1
            """,
            user_id
        )
        
        if not hotel:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        was_complete_before = hotel.get('profile_complete', False)
        
        # Handle picture upload if provided
        picture_url = None
        if picture is not None:
            try:
                # Read file content
                file_content = await picture.read()
                
                if file_content:
                    # Validate image
                    is_valid, error_message = validate_image(
                        file_content,
                        picture.filename or "image",
                        picture.content_type
                    )
                    
                    if not is_valid:
                        raise HTTPException(
                            status_code=http_status.HTTP_400_BAD_REQUEST,
                            detail=error_message or "Invalid image file"
                        )
                    
                    # Process image (resize if needed)
                    processed_content = file_content
                    if settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0:
                        processed_content = process_image(
                            file_content,
                            resize_width=settings.IMAGE_RESIZE_WIDTH if settings.IMAGE_RESIZE_WIDTH > 0 else None,
                            resize_height=settings.IMAGE_RESIZE_HEIGHT if settings.IMAGE_RESIZE_HEIGHT > 0 else None,
                            quality=85
                        )
                    
                    # Generate file key
                    file_key = generate_file_key("hotels", picture.filename or "image.jpg", user_id)
                    
                    # Upload to S3
                    content_type = picture.content_type or "image/jpeg"
                    picture_url = await upload_file_to_s3(
                        processed_content,
                        file_key,
                        content_type=content_type,
                        make_public=settings.S3_USE_PUBLIC_URLS
                    )
                    
                    # Generate thumbnail if enabled
                    if settings.GENERATE_THUMBNAILS:
                        try:
                            thumbnail_content = generate_thumbnail(
                                file_content,
                                size=settings.THUMBNAIL_SIZE,
                                quality=85
                            )
                            thumbnail_key = file_key.replace(".", "_thumb.")
                            await upload_file_to_s3(
                                thumbnail_content,
                                thumbnail_key,
                                content_type="image/jpeg",
                                make_public=settings.S3_USE_PUBLIC_URLS
                            )
                        except Exception as e:
                            logger.warning(f"Failed to generate thumbnail: {e}")
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error uploading picture: {e}")
                raise HTTPException(
                    status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Failed to upload picture: {str(e)}"
                )
        
        # Build dynamic UPDATE query for hotel_profiles table
        update_fields = []
        update_values = []
        param_counter = 1
        
        if name is not None:
            update_fields.append(f"name = ${param_counter}")
            update_values.append(name)
            param_counter += 1
        
        if location is not None:
            update_fields.append(f"location = ${param_counter}")
            update_values.append(location)
            param_counter += 1
        
        if about is not None:
            update_fields.append(f"about = ${param_counter}")
            update_values.append(about)
            param_counter += 1
        
        if website is not None:
            update_fields.append(f"website = ${param_counter}")
            update_values.append(website)
            param_counter += 1
        
        if phone is not None:
            update_fields.append(f"phone = ${param_counter}")
            update_values.append(phone)
            param_counter += 1
        
        # Use picture URL from JSON if provided, otherwise use uploaded file URL
        final_picture_url = picture_url_from_json if picture_url_from_json is not None else picture_url
        if final_picture_url is not None:
            update_fields.append(f"picture = ${param_counter}")
            update_values.append(final_picture_url)
            param_counter += 1
        
        # Only update if there are fields to update
        if update_fields:
            update_fields.append("updated_at = now()")
            update_values.append(hotel['id'])  # WHERE clause parameter
            
            update_query = f"""
                UPDATE hotel_profiles 
                SET {', '.join(update_fields)}
                WHERE id = ${param_counter}
            """
            await Database.execute(update_query, *update_values)
        
        # Update email in users table if provided
        if email is not None:
            await Database.execute(
                """
                UPDATE users 
                SET email = $1, updated_at = now()
                WHERE id = $2
                """,
                email,
                user_id
            )
        
        # Fetch updated profile with email from users table and check if profile became complete
        updated_hotel = await Database.fetchrow(
            """
            SELECT hp.id, hp.user_id, hp.name, hp.location, hp.about, hp.website, hp.phone, hp.picture, 
                   hp.status, hp.created_at, hp.updated_at, hp.profile_complete,
                   u.email, u.name as user_name
            FROM hotel_profiles hp
            JOIN users u ON hp.user_id = u.id
            WHERE hp.id = $1
            """,
            hotel['id']
        )
        
        # Check if profile just became complete (transition from incomplete to complete)
        is_complete_now = updated_hotel.get('profile_complete', False)
        profile_just_completed = not was_complete_before and is_complete_now
        
        # Send confirmation email if profile just became complete
        if profile_just_completed:
            try:
                user_email = updated_hotel['email']
                user_name = updated_hotel.get('user_name') or updated_hotel.get('name') or user_email.split('@')[0]
                
                # Check if email is already verified
                user_record = await Database.fetchrow(
                    "SELECT email_verified FROM users WHERE id = $1",
                    user_id
                )
                email_verified = user_record.get('email_verified', False) if user_record else False
                
                # Generate verification token and link if email is not verified
                verification_link = None
                if not email_verified:
                    try:
                        token = await create_email_verification_token(user_id, expires_in_hours=48)
                        verification_link = f"{settings.FRONTEND_URL}/verify-email?token={token}"
                    except Exception as e:
                        logger.error(f"Error creating email verification token: {str(e)}")
                        # Continue without verification link if token creation fails
                
                html_body = create_profile_completion_email_html(user_name, "hotel", verification_link)
                
                email_sent = await send_email(
                    to_email=user_email,
                    subject="🎉 Your Hotel Profile is Complete!" + (" - Verify Your Email" if not email_verified else ""),
                    html_body=html_body
                )
                
                if email_sent:
                    logger.info(f"Profile completion email sent to {user_email}" + (" with verification link" if verification_link else ""))
                else:
                    logger.warning(f"Failed to send profile completion email to {user_email}")
            except Exception as e:
                # Don't fail the request if email fails
                logger.error(f"Error sending profile completion email: {str(e)}")
        
        # Get all listings for this hotel (same as GET endpoint)
        listings_data = await Database.fetch(
            """
            SELECT id, hotel_profile_id, name, location, description, accommodation_type,
                   images, status, created_at, updated_at
            FROM hotel_listings
            WHERE hotel_profile_id = $1
            ORDER BY created_at DESC
            """,
            hotel['id']
        )
        
        listings_response = []
        for listing in listings_data:
            # Get collaboration offerings for this listing
            offerings_data = await Database.fetch(
                """
                SELECT id, listing_id, collaboration_type, availability_months, platforms,
                       free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
                       created_at, updated_at
                FROM listing_collaboration_offerings
                WHERE listing_id = $1
                ORDER BY created_at DESC
                """,
                listing['id']
            )
            
            offerings_response = [
                CollaborationOfferingResponse.model_validate({
                    "id": str(o['id']),
                    "listing_id": str(o['listing_id']),
                    "collaboration_type": o['collaboration_type'],
                    "availability_months": o['availability_months'],
                    "platforms": o['platforms'],
                    "free_stay_min_nights": o['free_stay_min_nights'],
                    "free_stay_max_nights": o['free_stay_max_nights'],
                    "paid_max_amount": o['paid_max_amount'],
                    "discount_percentage": o['discount_percentage'],
                    "created_at": o['created_at'],
                    "updated_at": o['updated_at'],
                }).model_dump(by_alias=True)
                for o in offerings_data
            ]
            
            # Get creator requirements for this listing
            requirements = await Database.fetchrow(
                """
                SELECT id, listing_id, platforms, min_followers, target_countries,
                       target_age_min, target_age_max, target_age_groups, created_at, updated_at
                FROM listing_creator_requirements
                WHERE listing_id = $1
                """,
                listing['id']
            )
            
            requirements_response = None
            if requirements:
                requirements_response = CreatorRequirementsResponse.model_validate({
                    "id": str(requirements['id']),
                    "listing_id": str(listing['id']),
                    "platforms": requirements['platforms'],
                    "min_followers": requirements['min_followers'],
                    "target_countries": requirements['target_countries'],
                    "target_age_min": requirements['target_age_min'],
                    "target_age_max": requirements['target_age_max'],
                    "target_age_groups": requirements['target_age_groups'],
                    "created_at": requirements['created_at'],
                    "updated_at": requirements['updated_at'],
                }).model_dump(by_alias=True)
            
            listings_response.append(
                ListingResponse.model_validate({
                    "id": str(listing['id']),
                    "hotel_profile_id": str(listing['hotel_profile_id']),
                    "name": listing['name'],
                    "location": listing['location'],
                    "description": listing['description'],
                    "accommodation_type": listing['accommodation_type'],
                    "images": listing['images'] or [],
                    "status": listing['status'],
                    "created_at": listing['created_at'],
                    "updated_at": listing['updated_at'],
                    "collaboration_offerings": offerings_response,
                    "creator_requirements": requirements_response,
                }).model_dump(by_alias=True)
            )
        
        return HotelProfileResponse(
            id=str(updated_hotel['id']),
            user_id=str(updated_hotel['user_id']),
            name=updated_hotel['name'],
            location=updated_hotel['location'],
            email=updated_hotel['email'],
            about=updated_hotel['about'],
            website=updated_hotel['website'],
            phone=updated_hotel['phone'],
            picture=updated_hotel['picture'],
            status=updated_hotel['status'],
            created_at=updated_hotel['created_at'],
            updated_at=updated_hotel['updated_at'],
            listings=listings_response
        )
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update profile: {str(e)}"
        )


@router.post("/me/listings", response_model=ListingResponse, status_code=http_status.HTTP_201_CREATED)
async def create_hotel_listing(
    request: CreateListingRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Create a new property listing for the currently authenticated hotel.
    """
    try:
        # Verify user is a hotel and get hotel profile
        hotel_profile_id = await get_current_hotel_profile_id(user_id)
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Create listing
                listing = await conn.fetchrow(
                    """
                    INSERT INTO hotel_listings 
                    (hotel_profile_id, name, location, description, accommodation_type, images)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, name, location, description, accommodation_type, images, 
                              status, created_at, updated_at
                    """,
                    hotel_profile_id,
                    request.name,
                    request.location,
                    request.description,
                    request.accommodationType,
                    request.images
                )
                
                listing_id = listing['id']
                
                # Create collaboration offerings
                offerings_response = []
                for offering in request.collaborationOfferings:
                    offering_record = await conn.fetchrow(
                        """
                        INSERT INTO listing_collaboration_offerings
                        (listing_id, collaboration_type, availability_months, platforms,
                         free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        RETURNING id, collaboration_type, availability_months, platforms,
                                  free_stay_min_nights, free_stay_max_nights, paid_max_amount, 
                                  discount_percentage, created_at, updated_at
                        """,
                        listing_id,
                        offering.collaborationType,
                        offering.availabilityMonths,
                        offering.platforms,
                        offering.freeStayMinNights,
                        offering.freeStayMaxNights,
                        offering.paidMaxAmount,
                        offering.discountPercentage
                    )
                    
                    offerings_response.append(CollaborationOfferingResponse.model_validate({
                        "id": str(offering_record['id']),
                        "listing_id": str(listing_id),
                        "collaboration_type": offering_record['collaboration_type'],
                        "availability_months": offering_record['availability_months'],
                        "platforms": offering_record['platforms'],
                        "free_stay_min_nights": offering_record['free_stay_min_nights'],
                        "free_stay_max_nights": offering_record['free_stay_max_nights'],
                        "paid_max_amount": offering_record['paid_max_amount'],
                        "discount_percentage": offering_record['discount_percentage'],
                        "created_at": offering_record['created_at'],
                        "updated_at": offering_record['updated_at']
                    }))
                
                # Create creator requirements
                requirements = await conn.fetchrow(
                    """
                    INSERT INTO listing_creator_requirements
                    (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id, platforms, min_followers, target_countries, 
                              target_age_min, target_age_max, target_age_groups, created_at, updated_at
                    """,
                    listing_id,
                    request.creatorRequirements.platforms,
                    request.creatorRequirements.minFollowers,
                    request.creatorRequirements.topCountries,
                    request.creatorRequirements.targetAgeMin,
                    request.creatorRequirements.targetAgeMax,
                    request.creatorRequirements.targetAgeGroups or []
                )
                
                requirements_response = CreatorRequirementsResponse.model_validate({
                    "id": str(requirements['id']),
                    "listing_id": str(listing_id),
                    "platforms": requirements['platforms'],
                    "min_followers": requirements['min_followers'],
                    "target_countries": requirements['target_countries'],
                    "target_age_min": requirements['target_age_min'],
                    "target_age_max": requirements['target_age_max'],
                    "target_age_groups": requirements['target_age_groups'],
                    "created_at": requirements['created_at'],
                    "updated_at": requirements['updated_at']
                })
        
        return ListingResponse.model_validate({
            "id": str(listing_id),
            "hotel_profile_id": hotel_profile_id,
            "name": listing['name'],
            "location": listing['location'],
            "description": listing['description'],
            "accommodation_type": listing['accommodation_type'],
            "images": listing['images'],
            "status": listing['status'],
            "created_at": listing['created_at'],
            "updated_at": listing['updated_at'],
            "collaboration_offerings": offerings_response,
            "creator_requirements": requirements_response
        })
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create listing: {str(e)}"
        )


async def _get_listing_with_details(listing_id: str, hotel_profile_id: str) -> dict:
    """Helper function to fetch a listing with its offerings and requirements"""
    # Verify listing belongs to hotel
    listing = await Database.fetchrow(
        """
        SELECT id, hotel_profile_id, name, location, description, accommodation_type,
               images, status, created_at, updated_at
        FROM hotel_listings
        WHERE id = $1 AND hotel_profile_id = $2
        """,
        listing_id,
        hotel_profile_id
    )
    
    if not listing:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Listing not found"
        )
    
    # Get collaboration offerings
    offerings_data = await Database.fetch(
        """
        SELECT id, listing_id, collaboration_type, availability_months, platforms,
               free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage,
               created_at, updated_at
        FROM listing_collaboration_offerings
        WHERE listing_id = $1
        ORDER BY created_at DESC
        """,
        listing_id
    )
    
    offerings_response = [
        CollaborationOfferingResponse.model_validate({
            "id": str(o['id']),
            "listing_id": str(o['listing_id']),
            "collaboration_type": o['collaboration_type'],
            "availability_months": o['availability_months'],
            "platforms": o['platforms'],
            "free_stay_min_nights": o['free_stay_min_nights'],
            "free_stay_max_nights": o['free_stay_max_nights'],
            "paid_max_amount": o['paid_max_amount'],
            "discount_percentage": o['discount_percentage'],
            "created_at": o['created_at'],
            "updated_at": o['updated_at']
        })
        for o in offerings_data
    ]
    
    # Get creator requirements
    requirements = await Database.fetchrow(
        """
        SELECT id, listing_id, platforms, min_followers, target_countries,
               target_age_min, target_age_max, target_age_groups, created_at, updated_at
        FROM listing_creator_requirements
        WHERE listing_id = $1
        """,
        listing_id
    )
    
    requirements_response = None
    if requirements:
        requirements_response = CreatorRequirementsResponse.model_validate({
            "id": str(requirements['id']),
            "listing_id": str(listing['id']),
            "platforms": requirements['platforms'],
            "min_followers": requirements['min_followers'],
            "target_countries": requirements['target_countries'],
            "target_age_min": requirements['target_age_min'],
            "target_age_max": requirements['target_age_max'],
            "target_age_groups": requirements['target_age_groups'],
            "created_at": requirements['created_at'],
            "updated_at": requirements['updated_at']
        })
    
    return {
        "listing": listing,
        "offerings": offerings_response,
        "requirements": requirements_response
    }


@router.put("/me/listings/{listing_id}", response_model=ListingResponse, status_code=http_status.HTTP_200_OK)
async def update_hotel_listing(
    listing_id: str,
    request: UpdateListingRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update a hotel listing. Supports partial updates - only provided fields will be updated.
    """
    try:
        # Verify user is a hotel and get hotel profile
        hotel_profile_id = await get_current_hotel_profile_id(user_id)
        
        # Get current listing data
        listing_data = await _get_listing_with_details(listing_id, hotel_profile_id)
        current_listing = listing_data["listing"]
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Build dynamic UPDATE query for listing
                update_fields = []
                update_values = []
                param_counter = 1
                
                if request.name is not None:
                    update_fields.append(f"name = ${param_counter}")
                    update_values.append(request.name)
                    param_counter += 1
                
                if request.location is not None:
                    update_fields.append(f"location = ${param_counter}")
                    update_values.append(request.location)
                    param_counter += 1
                
                if request.description is not None:
                    update_fields.append(f"description = ${param_counter}")
                    update_values.append(request.description)
                    param_counter += 1
                
                if request.accommodationType is not None:
                    update_fields.append(f"accommodation_type = ${param_counter}")
                    update_values.append(request.accommodationType)
                    param_counter += 1
                
                if request.images is not None:
                    update_fields.append(f"images = ${param_counter}")
                    update_values.append(request.images)
                    param_counter += 1
                
                # Update listing if there are fields to update
                if update_fields:
                    update_fields.append("updated_at = now()")
                    update_values.append(listing_id)  # WHERE clause parameter
                    
                    update_query = f"""
                        UPDATE hotel_listings 
                        SET {', '.join(update_fields)}
                        WHERE id = ${param_counter}
                    """
                    await conn.execute(update_query, *update_values)
                
                # Update collaboration offerings if provided (replace strategy)
                if request.collaborationOfferings is not None:
                    # Delete existing offerings
                    await conn.execute(
                        "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1",
                        listing_id
                    )
                    
                    # Insert new offerings
                    for offering in request.collaborationOfferings:
                        await conn.execute(
                            """
                            INSERT INTO listing_collaboration_offerings
                            (listing_id, collaboration_type, availability_months, platforms,
                             free_stay_min_nights, free_stay_max_nights, paid_max_amount, discount_percentage)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            """,
                            listing_id,
                            offering.collaborationType,
                            offering.availabilityMonths,
                            offering.platforms,
                            offering.freeStayMinNights,
                            offering.freeStayMaxNights,
                            offering.paidMaxAmount,
                            offering.discountPercentage
                        )
                
                # Update creator requirements if provided
                if request.creatorRequirements is not None:
                    # Delete existing requirements
                    await conn.execute(
                        "DELETE FROM listing_creator_requirements WHERE listing_id = $1",
                        listing_id
                    )
                    
                    # Insert new requirements
                    await conn.execute(
                        """
                        INSERT INTO listing_creator_requirements
                        (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max, target_age_groups)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        """,
                        listing_id,
                        request.creatorRequirements.platforms,
                        request.creatorRequirements.minFollowers,
                        request.creatorRequirements.topCountries,
                        request.creatorRequirements.targetAgeMin,
                        request.creatorRequirements.targetAgeMax,
                        request.creatorRequirements.targetAgeGroups or []
                    )
        
        # Fetch updated listing with details
        updated_data = await _get_listing_with_details(listing_id, hotel_profile_id)
        updated_listing = updated_data["listing"]
        updated_offerings = updated_data["offerings"]
        updated_requirements = updated_data["requirements"]
        
        return ListingResponse.model_validate({
            "id": str(updated_listing['id']),
            "hotel_profile_id": str(updated_listing['hotel_profile_id']),
            "name": updated_listing['name'],
            "location": updated_listing['location'],
            "description": updated_listing['description'],
            "accommodation_type": updated_listing['accommodation_type'],
            "images": updated_listing['images'] or [],
            "status": updated_listing['status'],
            "created_at": updated_listing['created_at'],
            "updated_at": updated_listing['updated_at'],
            "collaboration_offerings": updated_offerings,
            "creator_requirements": updated_requirements
        })
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/me/listings/{listing_id}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_hotel_listing(
    listing_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Delete a hotel listing and all associated data (offerings, requirements).
    """
    try:
        # Verify user is a hotel and get hotel profile
        hotel_profile_id = await get_current_hotel_profile_id(user_id)
        
        # Verify listing exists and belongs to hotel
        listing = await Database.fetchrow(
            """
            SELECT id FROM hotel_listings
            WHERE id = $1 AND hotel_profile_id = $2
            """,
            listing_id,
            hotel_profile_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Use transaction to ensure atomicity
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Delete collaboration offerings (cascade should handle this, but being explicit)
                await conn.execute(
                    "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1",
                    listing_id
                )
                
                # Delete creator requirements (cascade should handle this, but being explicit)
                await conn.execute(
                    "DELETE FROM listing_creator_requirements WHERE listing_id = $1",
                    listing_id
                )
                
                # Delete the listing itself
                await conn.execute(
                    "DELETE FROM hotel_listings WHERE id = $1",
                    listing_id
                )
        
        return None
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete listing: {str(e)}"
        )


@router.get("/me/collaborations", response_model=List[HotelCollaborationListResponse], status_code=http_status.HTTP_200_OK)
async def get_hotel_collaborations(
    listing_id: Optional[str] = Query(None, description="Filter by listing ID"),
    collab_status: Optional[str] = Query(None, alias="status", description="Filter by status"),
    initiated_by: Optional[str] = Query(None, description="Filter by initiator type (creator/hotel)"),
    user_id: str = Depends(get_current_user_id)
):
    """
    Get all collaborations associated with the authenticated hotel.
    
    This is a summary endpoint returning a lightweight list of collaborations.
    For full details including creator demographics and deliverables, 
    use the GET /collaborations/{id} detail endpoint.
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user or user['type'] != 'hotel':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_id = str(hotel_profile['id'])
        
        # Build query
        # Updated to fetch only summary fields and primary handle
        query = """
            SELECT 
                c.id, c.initiator_type, c.status, c.created_at, c.why_great_fit,
                c.travel_date_from, c.travel_date_to,
                c.creator_id,
                cr_user.name as creator_name,
                cr.profile_picture as creator_profile_picture,
                cr.location as creator_location,
                cr_user.status as user_status,
                (SELECT SUM(followers) FROM creator_platforms WHERE creator_id = c.creator_id) as total_followers,
                (SELECT AVG(engagement_rate) FROM creator_platforms WHERE creator_id = c.creator_id) as avg_engagement_rate,
                (
                    SELECT handle 
                    FROM creator_platforms 
                    WHERE creator_id = c.creator_id 
                    ORDER BY followers DESC 
                    LIMIT 1
                ) as primary_handle,
                (
                    SELECT name
                    FROM creator_platforms
                    WHERE creator_id = c.creator_id
                    ORDER BY followers DESC
                    LIMIT 1
                ) as active_platform
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            WHERE c.hotel_id = $1
        """
        
        params = [hotel_id]
        # Apply filters
        if listing_id:
            query += " AND c.listing_id = $" + str(len(params) + 1)
            params.append(listing_id)
        if collab_status:
            query += " AND c.status = $" + str(len(params) + 1)
            params.append(collab_status)
        if initiated_by:
            query += " AND c.initiator_type = $" + str(len(params) + 1)
            params.append(initiated_by)
        
        query += " ORDER BY c.created_at DESC"
        
        collaborations_data = await Database.fetch(query, *params)
        
        if not collaborations_data:
            return []
        
        # Fetch all deliverables for these collaborations in one go
        collab_ids = [str(c['id']) for c in collaborations_data]
        all_deliverables_rows = await Database.fetch(
            "SELECT id, collaboration_id, platform, type, quantity, status FROM collaboration_deliverables WHERE collaboration_id = ANY($1::uuid[])",
            collab_ids
        )
        
        # Group deliverables by collaboration_id
        collab_deliverables_map = {}
        for row in all_deliverables_rows:
            c_id = str(row['collaboration_id'])
            if c_id not in collab_deliverables_map:
                collab_deliverables_map[c_id] = {}
            
            p = row['platform']
            if p not in collab_deliverables_map[c_id]:
                collab_deliverables_map[c_id][p] = []
                
            collab_deliverables_map[c_id][p].append({
                "id": str(row['id']),
                "type": row['type'],
                "quantity": row['quantity'],
                "status": row['status']
            })

        # Build response
        response = []
        for collab in collaborations_data:
            c_id = str(collab['id'])
            collab_dils = collab_deliverables_map.get(c_id, {})
            deliverables = [{"platform": p, "deliverables": dils} for p, dils in collab_dils.items()]

            response.append({
                "id": c_id,
                "initiator_type": collab['initiator_type'],
                "is_initiator": collab['initiator_type'] == 'hotel',
                "status": collab['status'],
                "created_at": collab['created_at'],
                "why_great_fit": collab['why_great_fit'],
                
                # Creator Summary
                "creator_id": str(collab['creator_id']),
                "creator_name": collab['creator_name'],
                "creator_profile_picture": collab['creator_profile_picture'],
                "creator_location": collab['creator_location'],
                "primary_handle": collab['primary_handle'],
                "total_followers": int(collab['total_followers']) if collab['total_followers'] is not None else 0,
                "avg_engagement_rate": float(collab['avg_engagement_rate']) if collab['avg_engagement_rate'] is not None else 0.0,
                "active_platform": collab['active_platform'],
                "is_verified": collab['user_status'] == 'verified',
                "platform_deliverables": deliverables,
                "travel_date_from": collab['travel_date_from'],
                "travel_date_to": collab['travel_date_to']
            })
            
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to fetch hotel collaborations")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaborations: {str(e)}"
        )


@router.get("/me/collaborations/{collaboration_id}", response_model=HotelCollaborationDetailResponse)
async def get_hotel_collaboration_detail(
    collaboration_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Get detailed information about a specific collaboration, including
    the creator's full platform metrics (demographics, etc.).
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user or user['type'] != 'hotel':
            raise HTTPException(
                status_code=http_status.HTTP_403_FORBIDDEN,
                detail="This endpoint is only available for hotels"
            )
        
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_id = str(hotel_profile['id'])
        
        # Fetch collaboration details
        # Using a similar query to the list endpoint but for a single ID
        collab = await Database.fetchrow(
            """
            SELECT 
                c.id, c.initiator_type, c.status, c.creator_id, c.hotel_id, c.listing_id,
                c.why_great_fit, c.collaboration_type,
                c.free_stay_min_nights, c.free_stay_max_nights,
                c.paid_amount, c.discount_percentage,
                c.travel_date_from, c.travel_date_to,
                c.preferred_date_from, c.preferred_date_to,
                c.preferred_months, c.consent,
                c.created_at, c.updated_at, c.responded_at, c.cancelled_at, c.completed_at,
                cr_user.name as creator_name,
                cr.profile_picture as creator_profile_picture,
                cr.portfolio_link as creator_portfolio_link,
                cr.location as creator_location,
                hp.name as hotel_name,
                hl.name as listing_name,
                hl.location as listing_location
            FROM collaborations c
            JOIN creators cr ON cr.id = c.creator_id
            JOIN users cr_user ON cr_user.id = cr.user_id
            JOIN hotel_profiles hp ON hp.id = c.hotel_id
            JOIN hotel_listings hl ON hl.id = c.listing_id
            WHERE c.id = $1 AND c.hotel_id = $2
            """,
            collaboration_id,
            hotel_id
        )
        
        if not collab:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail="Collaboration not found"
            )
            
        creator_id = collab['creator_id']
        
        # Fetch detailed platform metrics for the creator
        platforms_data = await Database.fetch(
            """
            SELECT name, handle, followers, engagement_rate, 
                   top_countries, top_age_groups, gender_split
            FROM creator_platforms
            WHERE creator_id = $1
            ORDER BY followers DESC
            """,
            creator_id
        )
        
        # Calculate aggregates
        total_followers = sum(p['followers'] for p in platforms_data)
        avg_engagement_rate = (
            sum(p['engagement_rate'] for p in platforms_data) / len(platforms_data)
            if platforms_data else 0.0
        )
        
        # Format platform details
        platforms_response = []
        primary_handle = None
        max_followers = -1
        
        for p in platforms_data:
            if p['followers'] > max_followers:
                max_followers = p['followers']
                primary_handle = p['handle']
                
            platforms_response.append(CreatorPlatformDetail(
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'],
                engagement_rate=float(p['engagement_rate']),
                top_countries=json.loads(p['top_countries']) if p['top_countries'] else None,
                top_age_groups=json.loads(p['top_age_groups']) if p['top_age_groups'] else None,
                gender_split=json.loads(p['gender_split']) if p['gender_split'] else None
            ))
            
        # Fetch reputation data
        reputation_data = await Database.fetch(
            """
            SELECT id, rating, comment, 'Hotel' as organization_name, created_at
            FROM creator_ratings
            WHERE creator_id = $1
            ORDER BY created_at DESC
            """,
            creator_id
        )
        
        reviews = []
        total_rating = 0
        for r in reputation_data:
            total_rating += r['rating']
            reviews.append(CreatorReview(
                id=str(r['id']),
                rating=r['rating'],
                comment=r['comment'],
                organization_name=r['organization_name'],
                created_at=r['created_at']
            ))
            
        reputation = None
        if reputation_data:
            reputation = CreatorReputation(
                average_rating=total_rating / len(reputation_data),
                total_reviews=len(reputation_data),
                reviews=reviews
            )
            
        # Fetch deliverables from the new table
        deliverables_rows = await Database.fetch(
            "SELECT id, platform, type, quantity, status FROM collaboration_deliverables WHERE collaboration_id = $1 ORDER BY platform, type",
            collaboration_id
        )
        
        deliverables = []
        platform_map = {}
        for row in deliverables_rows:
            p = row['platform']
            if p not in platform_map:
                platform_map[p] = []
            platform_map[p].append({
                "id": str(row['id']),
                "type": row['type'],
                "quantity": row['quantity'],
                "status": row['status']
            })
            
        deliverables = [{"platform": p, "deliverables": dils} for p, dils in platform_map.items()]

        return HotelCollaborationDetailResponse(
            # List Response Fields
            id=str(collab['id']),
            initiator_type=collab['initiator_type'],
            is_initiator=collab['initiator_type'] == 'hotel',
            status=collab['status'],
            created_at=collab['created_at'],
            why_great_fit=collab['why_great_fit'],
            
            # Creator Summary
            creator_id=str(collab['creator_id']),
            creator_name=collab['creator_name'],
            creator_profile_picture=collab['creator_profile_picture'],
            creator_location=collab['creator_location'],
            total_followers=total_followers,
            avg_engagement_rate=float(avg_engagement_rate),
            is_verified=True, # You might want to fetch actual status
            primary_handle=primary_handle,
            
            # Detail Fields
            platforms=platforms_response,
            reputation=reputation,
            platform_deliverables=deliverables,
            travel_date_from=collab['travel_date_from'],
            travel_date_to=collab['travel_date_to'],
            portfolio_link=collab['creator_portfolio_link'],
            
            hotel_id=str(collab['hotel_id']),
            hotel_name=collab['hotel_name'],
            listing_id=str(collab['listing_id']),
            listing_name=collab['listing_name'],
            listing_location=collab['listing_location'],
            
            collaboration_type=collab['collaboration_type'],
            free_stay_min_nights=collab['free_stay_min_nights'],
            free_stay_max_nights=collab['free_stay_max_nights'],
            paid_amount=collab['paid_amount'],
            discount_percentage=collab['discount_percentage'],
            preferred_date_from=collab['preferred_date_from'],
            preferred_date_to=collab['preferred_date_to'],
            preferred_months=collab['preferred_months'],
            consent=collab['consent'],
            
            updated_at=collab['updated_at'],
            responded_at=collab['responded_at'],
            cancelled_at=collab['cancelled_at'],
            completed_at=collab['completed_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching collaboration detail: {str(e)}")
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch collaboration details: {str(e)}"
        )

