"""
Hotel profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field, HttpUrl, EmailStr, field_validator, model_validator
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id
from app.email_service import send_email, create_profile_completion_email_html
import logging

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
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
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
                status_code=status.HTTP_404_NOT_FOUND,
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
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
    
    class Config:
        from_attributes = True


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
    
    class Config:
        populate_by_name = True


class CreatorRequirementsRequest(BaseModel):
    """Creator requirements request model"""
    platforms: List[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(..., min_length=1)
    minFollowers: Optional[int] = Field(None, gt=0, alias="min_followers")
    targetCountries: List[str] = Field(..., min_length=1, alias="target_countries")
    targetAgeMin: Optional[int] = Field(None, ge=0, le=100, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, ge=0, le=100, alias="target_age_max")
    
    @model_validator(mode='after')
    def validate_age_range(self):
        """Validate age range if both are provided"""
        if self.targetAgeMin is not None and self.targetAgeMax is not None:
            if self.targetAgeMax < self.targetAgeMin:
                raise ValueError("target_age_max must be >= target_age_min")
        return self
    
    class Config:
        populate_by_name = True


class CreateListingRequest(BaseModel):
    """Request model for creating hotel listing"""
    name: str = Field(..., min_length=1)
    location: str = Field(..., min_length=1)
    description: str = Field(..., min_length=10)
    accommodationType: Optional[Literal["Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"]] = Field(None, alias="accommodation_type")
    images: List[str] = Field(default_factory=list)
    collaborationOfferings: List[CollaborationOfferingRequest] = Field(..., min_length=1, alias="collaboration_offerings")
    creatorRequirements: CreatorRequirementsRequest = Field(alias="creator_requirements")
    
    class Config:
        populate_by_name = True


class UpdateListingRequest(BaseModel):
    """Request model for updating hotel listing (partial updates supported)"""
    name: Optional[str] = Field(None, min_length=1)
    location: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = Field(None, min_length=10)
    accommodationType: Optional[Literal["Hotel", "Boutiques Hotel", "City Hotel", "Luxury Hotel", "Apartment", "Villa", "Lodge"]] = Field(None, alias="accommodation_type")
    images: Optional[List[str]] = None
    collaborationOfferings: Optional[List[CollaborationOfferingRequest]] = Field(None, alias="collaboration_offerings")
    creatorRequirements: Optional[CreatorRequirementsRequest] = Field(None, alias="creator_requirements")
    
    class Config:
        populate_by_name = True


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
    
    class Config:
        populate_by_name = True
        from_attributes = True


class CreatorRequirementsResponse(BaseModel):
    """Creator requirements response model"""
    id: str
    listingId: str = Field(alias="listing_id")
    platforms: List[str]
    minFollowers: Optional[int] = Field(None, alias="min_followers")
    targetCountries: List[str] = Field(alias="target_countries")
    targetAgeMin: Optional[int] = Field(None, alias="target_age_min")
    targetAgeMax: Optional[int] = Field(None, alias="target_age_max")
    createdAt: datetime = Field(alias="created_at")
    updatedAt: datetime = Field(alias="updated_at")
    
    class Config:
        populate_by_name = True
        from_attributes = True


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
    creatorRequirements: CreatorRequirementsResponse = Field(alias="creator_requirements")
    
    class Config:
        populate_by_name = True
        from_attributes = True


@router.get("/me", response_model=HotelProfileResponse, status_code=status.HTTP_200_OK)
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
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        if user["type"] != "hotel":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
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
                status_code=status.HTTP_404_NOT_FOUND,
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
                       target_age_min, target_age_max, created_at, updated_at
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile: {str(e)}"
        )


@router.put("/me", response_model=HotelProfileResponse, status_code=status.HTTP_200_OK)
async def update_hotel_profile(
    request: UpdateHotelProfileRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update the currently authenticated hotel's profile.
    Supports partial updates - only provided fields will be updated.
    """
    try:
        # Verify user is a hotel
        user = await Database.fetchrow(
            "SELECT id, type, email FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if user['type'] != 'hotel':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
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
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        was_complete_before = hotel.get('profile_complete', False)
        
        # Build dynamic UPDATE query for hotel_profiles table
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
        
        if request.about is not None:
            update_fields.append(f"about = ${param_counter}")
            update_values.append(request.about)
            param_counter += 1
        
        if request.website is not None:
            update_fields.append(f"website = ${param_counter}")
            update_values.append(str(request.website))
            param_counter += 1
        
        if request.phone is not None:
            update_fields.append(f"phone = ${param_counter}")
            update_values.append(request.phone)
            param_counter += 1
        
        if request.picture is not None:
            update_fields.append(f"picture = ${param_counter}")
            update_values.append(str(request.picture))
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
        if request.email is not None:
            await Database.execute(
                """
                UPDATE users 
                SET email = $1, updated_at = now()
                WHERE id = $2
                """,
                request.email,
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
                
                html_body = create_profile_completion_email_html(user_name, "hotel")
                
                email_sent = await send_email(
                    to_email=user_email,
                    subject="🎉 Your Hotel Profile is Complete!",
                    html_body=html_body
                )
                
                if email_sent:
                    logger.info(f"Profile completion email sent to {user_email}")
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
                       target_age_min, target_age_max, created_at, updated_at
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
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update profile: {str(e)}"
        )


@router.post("/me/listings", response_model=ListingResponse, status_code=status.HTTP_201_CREATED)
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
                    (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, platforms, min_followers, target_countries, 
                              target_age_min, target_age_max, created_at, updated_at
                    """,
                    listing_id,
                    request.creatorRequirements.platforms,
                    request.creatorRequirements.minFollowers,
                    request.creatorRequirements.targetCountries,
                    request.creatorRequirements.targetAgeMin,
                    request.creatorRequirements.targetAgeMax
                )
                
                requirements_response = CreatorRequirementsResponse.model_validate({
                    "id": str(requirements['id']),
                    "listing_id": str(listing_id),
                    "platforms": requirements['platforms'],
                    "min_followers": requirements['min_followers'],
                    "target_countries": requirements['target_countries'],
                    "target_age_min": requirements['target_age_min'],
                    "target_age_max": requirements['target_age_max'],
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
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
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
            status_code=status.HTTP_404_NOT_FOUND,
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
               target_age_min, target_age_max, created_at, updated_at
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
            "created_at": requirements['created_at'],
            "updated_at": requirements['updated_at']
        })
    
    return {
        "listing": listing,
        "offerings": offerings_response,
        "requirements": requirements_response
    }


@router.put("/me/listings/{listing_id}", response_model=ListingResponse, status_code=status.HTTP_200_OK)
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
                        (listing_id, platforms, min_followers, target_countries, target_age_min, target_age_max)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        """,
                        listing_id,
                        request.creatorRequirements.platforms,
                        request.creatorRequirements.minFollowers,
                        request.creatorRequirements.targetCountries,
                        request.creatorRequirements.targetAgeMin,
                        request.creatorRequirements.targetAgeMax
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
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/me/listings/{listing_id}", status_code=status.HTTP_204_NO_CONTENT)
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
                status_code=status.HTTP_404_NOT_FOUND,
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete listing: {str(e)}"
        )

