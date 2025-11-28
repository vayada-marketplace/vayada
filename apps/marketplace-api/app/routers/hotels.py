"""
Hotel profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends, UploadFile, File, Form
from pydantic import BaseModel, Field, EmailStr, HttpUrl, field_validator, model_validator
from typing import Optional, List, Literal
from datetime import datetime
import uuid
from app.database import Database
from app.dependencies import get_current_user_id, get_current_hotel_profile_id

router = APIRouter(prefix="/hotels", tags=["hotels"])


# ============================================
# Request/Response Models
# ============================================

class CollaborationOfferingResponse(BaseModel):
    id: str
    listing_id: str
    collaboration_type: Literal["Free Stay", "Paid", "Discount"]
    availability_months: List[str]
    platforms: List[str]
    free_stay_min_nights: Optional[int] = None
    free_stay_max_nights: Optional[int] = None
    paid_max_amount: Optional[float] = None
    discount_percentage: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class CreatorRequirementsResponse(BaseModel):
    id: str
    listing_id: str
    platforms: List[str]
    min_followers: Optional[int] = None
    target_countries: List[str]
    target_age_min: Optional[int] = None
    target_age_max: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class ListingResponse(BaseModel):
    id: str
    hotel_profile_id: str
    name: str
    location: str
    description: str
    accommodation_type: Optional[str] = None
    images: List[str]
    status: str
    created_at: datetime
    updated_at: datetime
    collaboration_offerings: List[CollaborationOfferingResponse]
    creator_requirements: Optional[CreatorRequirementsResponse] = None


class HotelProfileResponse(BaseModel):
    id: str
    user_id: str
    name: str
    category: str
    location: str
    picture: Optional[str] = None
    website: Optional[str] = None
    about: Optional[str] = None
    email: str
    phone: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime
    listings: List[ListingResponse]


class UpdateHotelProfileRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=100)
    category: Optional[Literal[
        "Resort", "Hotel", "Villa", "Apartment", "Hostel",
        "Boutique Hotel", "Luxury Hotel", "Eco Resort",
        "Spa Resort", "Beach Resort"
    ]] = None
    location: Optional[str] = Field(None, min_length=1)
    picture: Optional[str] = None
    website: Optional[HttpUrl] = None
    about: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None

    @field_validator('website', mode='before')
    @classmethod
    def validate_website(cls, v):
        if v is None or v == "":
            return None
        return v


class CollaborationOfferingRequest(BaseModel):
    collaboration_type: Literal["Free Stay", "Paid", "Discount"]
    availability_months: List[str] = Field(..., min_items=1)
    platforms: List[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(..., min_items=1)
    free_stay_min_nights: Optional[int] = Field(None, ge=1)
    free_stay_max_nights: Optional[int] = Field(None, ge=1)
    paid_max_amount: Optional[float] = Field(None, gt=0)
    discount_percentage: Optional[int] = Field(None, ge=1, le=100)

    @model_validator(mode='after')
    def validate_collaboration_offering(self):
        collaboration_type = self.collaboration_type
        
        if collaboration_type == 'Free Stay':
            if self.free_stay_min_nights is None:
                raise ValueError('free_stay_min_nights is required for Free Stay')
            if self.free_stay_max_nights is None:
                raise ValueError('free_stay_max_nights is required for Free Stay')
            if self.free_stay_max_nights < self.free_stay_min_nights:
                raise ValueError('free_stay_max_nights must be >= free_stay_min_nights')
            if self.paid_max_amount is not None:
                raise ValueError('paid_max_amount should not be provided for Free Stay')
            if self.discount_percentage is not None:
                raise ValueError('discount_percentage should not be provided for Free Stay')
        elif collaboration_type == 'Paid':
            if self.paid_max_amount is None:
                raise ValueError('paid_max_amount is required for Paid')
            if self.free_stay_min_nights is not None:
                raise ValueError('free_stay_min_nights should not be provided for Paid')
            if self.free_stay_max_nights is not None:
                raise ValueError('free_stay_max_nights should not be provided for Paid')
            if self.discount_percentage is not None:
                raise ValueError('discount_percentage should not be provided for Paid')
        elif collaboration_type == 'Discount':
            if self.discount_percentage is None:
                raise ValueError('discount_percentage is required for Discount')
            if self.free_stay_min_nights is not None:
                raise ValueError('free_stay_min_nights should not be provided for Discount')
            if self.free_stay_max_nights is not None:
                raise ValueError('free_stay_max_nights should not be provided for Discount')
            if self.paid_max_amount is not None:
                raise ValueError('paid_max_amount should not be provided for Discount')
        
        return self


class CreatorRequirementsRequest(BaseModel):
    platforms: List[Literal["Instagram", "TikTok", "YouTube", "Facebook"]] = Field(..., min_items=1)
    min_followers: Optional[int] = Field(None, ge=0)
    target_countries: List[str] = Field(..., min_items=1)
    target_age_min: Optional[int] = Field(None, ge=0, le=100)
    target_age_max: Optional[int] = Field(None, ge=0, le=100)

    @model_validator(mode='after')
    def validate_age_range(self):
        if self.target_age_min is not None and self.target_age_max is not None:
            if self.target_age_max < self.target_age_min:
                raise ValueError('target_age_max must be >= target_age_min')
        return self


class CreateListingRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    location: str = Field(..., min_length=1)
    description: str = Field(..., min_length=10, max_length=5000)
    accommodation_type: Optional[Literal["Hotel", "Resort", "Boutique Hotel", "Lodge", "Apartment", "Villa"]] = None
    images: Optional[List[str]] = None
    collaboration_offerings: List[CollaborationOfferingRequest] = Field(..., min_items=1)
    creator_requirements: CreatorRequirementsRequest


class UpdateListingRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=100)
    location: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = Field(None, min_length=10, max_length=5000)
    accommodation_type: Optional[Literal["Hotel", "Resort", "Boutique Hotel", "Lodge", "Apartment", "Villa"]] = None
    images: Optional[List[str]] = None
    collaboration_offerings: Optional[List[CollaborationOfferingRequest]] = None
    creator_requirements: Optional[CreatorRequirementsRequest] = None


class UploadPictureResponse(BaseModel):
    url: str


class UploadImagesResponse(BaseModel):
    urls: List[str]


# ============================================
# Helper Functions
# ============================================

async def get_hotel_profile_with_listings(hotel_profile_id: str) -> dict:
    """Get hotel profile with all listings, offerings, and requirements"""
    # Get hotel profile
    # Note: email is stored in hotel_profiles table
    hotel = await Database.fetchrow(
        """
        SELECT * FROM hotel_profiles
        WHERE id = $1
        """,
        hotel_profile_id
    )
    
    if not hotel:
        return None
    
    # Get all listings for this hotel
    listings_rows = await Database.fetch(
        """
        SELECT * FROM hotel_listings
        WHERE hotel_profile_id = $1
        ORDER BY created_at DESC
        """,
        hotel_profile_id
    )
    
    listings = []
    for listing_row in listings_rows:
        listing_id = str(listing_row['id'])
        
        # Get collaboration offerings
        offerings_rows = await Database.fetch(
            """
            SELECT * FROM listing_collaboration_offerings
            WHERE listing_id = $1
            ORDER BY created_at ASC
            """,
            listing_id
        )
        
        offerings = []
        for offering_row in offerings_rows:
            offerings.append(CollaborationOfferingResponse(
                id=str(offering_row['id']),
                listing_id=listing_id,
                collaboration_type=offering_row['collaboration_type'],
                availability_months=offering_row['availability_months'] or [],
                platforms=offering_row['platforms'] or [],
                free_stay_min_nights=offering_row['free_stay_min_nights'],
                free_stay_max_nights=offering_row['free_stay_max_nights'],
                paid_max_amount=float(offering_row['paid_max_amount']) if offering_row['paid_max_amount'] else None,
                discount_percentage=offering_row['discount_percentage'],
                created_at=offering_row['created_at'],
                updated_at=offering_row['updated_at']
            ))
        
        # Get creator requirements
        requirements_row = await Database.fetchrow(
            """
            SELECT * FROM listing_creator_requirements
            WHERE listing_id = $1
            """,
            listing_id
        )
        
        requirements = None
        if requirements_row:
            requirements = CreatorRequirementsResponse(
                id=str(requirements_row['id']),
                listing_id=listing_id,
                platforms=requirements_row['platforms'] or [],
                min_followers=requirements_row['min_followers'],
                target_countries=requirements_row['target_countries'] or [],
                target_age_min=requirements_row['target_age_min'],
                target_age_max=requirements_row['target_age_max'],
                created_at=requirements_row['created_at'],
                updated_at=requirements_row['updated_at']
            )
        
        listings.append(ListingResponse(
            id=listing_id,
            hotel_profile_id=str(listing_row['hotel_profile_id']),
            name=listing_row['name'],
            location=listing_row['location'],
            description=listing_row['description'],
            accommodation_type=listing_row['accommodation_type'],
            images=listing_row['images'] or [],
            status=listing_row['status'],
            created_at=listing_row['created_at'],
            updated_at=listing_row['updated_at'],
            collaboration_offerings=offerings,
            creator_requirements=requirements
        ))
    
    return {
        'hotel': hotel,
        'listings': listings
    }


# ============================================
# Endpoints
# ============================================

@router.get("/me", response_model=HotelProfileResponse, status_code=status.HTTP_200_OK)
async def get_hotel_profile(
    user_id: str = Depends(get_current_user_id)
):
    """
    Get current hotel's complete profile with all listings, collaboration offerings, and creator requirements
    """
    try:
        # Get hotel profile ID
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Get hotel profile with listings
        data = await get_hotel_profile_with_listings(hotel_profile_id)
        
        if not data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel = data['hotel']
        listings = data['listings']
        
        return HotelProfileResponse(
            id=str(hotel['id']),
            user_id=str(hotel['user_id']),
            name=hotel['name'],
            category=hotel['category'],
            location=hotel['location'],
            picture=hotel['picture'],
            website=hotel['website'],
            about=hotel['about'],
            email=hotel['email'],
            phone=hotel['phone'],
            status=hotel['status'],
            created_at=hotel['created_at'],
            updated_at=hotel['updated_at'],
            listings=listings
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get hotel profile: {str(e)}"
        )


@router.put("/me", response_model=HotelProfileResponse, status_code=status.HTTP_200_OK)
async def update_hotel_profile(
    request: UpdateHotelProfileRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update hotel profile information (Overview tab - Edit mode)
    """
    try:
        # Get hotel profile
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Build update query dynamically
        updates = []
        values = []
        param_num = 1
        
        if request.name is not None:
            updates.append(f"name = ${param_num}")
            values.append(request.name)
            param_num += 1
        
        if request.category is not None:
            updates.append(f"category = ${param_num}")
            values.append(request.category)
            param_num += 1
        
        if request.location is not None:
            updates.append(f"location = ${param_num}")
            values.append(request.location)
            param_num += 1
        
        if request.picture is not None:
            updates.append(f"picture = ${param_num}")
            values.append(request.picture)
            param_num += 1
        
        if request.website is not None:
            updates.append(f"website = ${param_num}")
            values.append(str(request.website))
            param_num += 1
        
        if request.about is not None:
            updates.append(f"about = ${param_num}")
            values.append(request.about)
            param_num += 1
        
        if request.email is not None:
            updates.append(f"email = ${param_num}")
            values.append(request.email)
            param_num += 1
        
        if request.phone is not None:
            updates.append(f"phone = ${param_num}")
            values.append(request.phone)
            param_num += 1
        
        if not updates:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="At least one field must be provided for update"
            )
        
        updates.append("updated_at = now()")
        values.append(hotel_profile_id)
        
        query = f"""
            UPDATE hotel_profiles
            SET {', '.join(updates)}
            WHERE id = ${param_num}
            RETURNING id
        """
        
        await Database.fetchrow(query, *values)
        
        # Return updated profile
        data = await get_hotel_profile_with_listings(hotel_profile_id)
        hotel = data['hotel']
        listings = data['listings']
        
        return HotelProfileResponse(
            id=str(hotel['id']),
            user_id=str(hotel['user_id']),
            name=hotel['name'],
            category=hotel['category'],
            location=hotel['location'],
            picture=hotel['picture'],
            website=hotel['website'],
            about=hotel['about'],
            email=hotel['email'],
            phone=hotel['phone'],
            status=hotel['status'],
            created_at=hotel['created_at'],
            updated_at=hotel['updated_at'],
            listings=listings
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update hotel profile: {str(e)}"
        )


@router.post("/me/upload-picture", response_model=UploadPictureResponse, status_code=status.HTTP_200_OK)
async def upload_hotel_picture(
    picture: UploadFile = File(..., description="Hotel profile picture"),
    user_id: str = Depends(get_current_user_id)
):
    """
    Upload hotel profile picture/logo
    
    NOTE: This endpoint currently returns a placeholder URL.
    Actual file storage implementation (e.g., S3) needs to be added.
    """
    try:
        # Verify hotel profile exists
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        # Validate file type
        if not picture.content_type or not picture.content_type.startswith('image/'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="File must be an image"
            )
        
        # TODO: Implement actual file upload to storage (S3, local filesystem, etc.)
        # For now, return a placeholder URL
        # In production, you would:
        # 1. Save file to storage (S3, local filesystem, etc.)
        # 2. Get the public URL
        # 3. Update hotel_profiles.picture with the URL
        
        file_extension = picture.filename.split('.')[-1] if picture.filename else 'jpg'
        placeholder_url = f"https://example.com/uploads/hotel-picture-{uuid.uuid4()}.{file_extension}"
        
        return UploadPictureResponse(url=placeholder_url)
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload picture: {str(e)}"
        )


@router.post("/me/listings", response_model=ListingResponse, status_code=status.HTTP_201_CREATED)
async def create_listing(
    request: CreateListingRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Create a new property listing with collaboration offerings and creator requirements
    """
    try:
        # Get hotel profile ID
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Create listing
        listing = await Database.fetchrow(
            """
            INSERT INTO hotel_listings (
              hotel_profile_id, name, location, description,
              accommodation_type, images
            )
            VALUES ($1, $2, $3, $4, $5, $6::text[])
            RETURNING *
            """,
            hotel_profile_id,
            request.name,
            request.location,
            request.description,
            request.accommodation_type,
            request.images or []
        )
        
        listing_id = str(listing['id'])
        
        # Create collaboration offerings
        for offering in request.collaboration_offerings:
            await Database.execute(
                """
                INSERT INTO listing_collaboration_offerings (
                  listing_id, collaboration_type, availability_months,
                  platforms, free_stay_min_nights, free_stay_max_nights,
                  paid_max_amount, discount_percentage
                )
                VALUES ($1, $2, $3::text[], $4::text[], $5, $6, $7, $8)
                """,
                listing_id,
                offering.collaboration_type,
                offering.availability_months,
                offering.platforms,
                offering.free_stay_min_nights,
                offering.free_stay_max_nights,
                offering.paid_max_amount,
                offering.discount_percentage
            )
        
        # Create creator requirements
        await Database.execute(
            """
            INSERT INTO listing_creator_requirements (
              listing_id, platforms, min_followers,
              target_countries, target_age_min, target_age_max
            )
            VALUES ($1, $2::text[], $3, $4::text[], $5, $6)
            """,
            listing_id,
            request.creator_requirements.platforms,
            request.creator_requirements.min_followers,
            request.creator_requirements.target_countries,
            request.creator_requirements.target_age_min,
            request.creator_requirements.target_age_max
        )
        
        # Get full listing with offerings and requirements
        listing_row = await Database.fetchrow(
            "SELECT * FROM hotel_listings WHERE id = $1",
            listing_id
        )
        
        # Get collaboration offerings
        offerings_rows = await Database.fetch(
            "SELECT * FROM listing_collaboration_offerings WHERE listing_id = $1",
            listing_id
        )
        
        offerings = []
        for offering_row in offerings_rows:
            offerings.append(CollaborationOfferingResponse(
                id=str(offering_row['id']),
                listing_id=listing_id,
                collaboration_type=offering_row['collaboration_type'],
                availability_months=offering_row['availability_months'] or [],
                platforms=offering_row['platforms'] or [],
                free_stay_min_nights=offering_row['free_stay_min_nights'],
                free_stay_max_nights=offering_row['free_stay_max_nights'],
                paid_max_amount=float(offering_row['paid_max_amount']) if offering_row['paid_max_amount'] else None,
                discount_percentage=offering_row['discount_percentage'],
                created_at=offering_row['created_at'],
                updated_at=offering_row['updated_at']
            ))
        
        # Get creator requirements
        requirements_row = await Database.fetchrow(
            "SELECT * FROM listing_creator_requirements WHERE listing_id = $1",
            listing_id
        )
        
        requirements = CreatorRequirementsResponse(
            id=str(requirements_row['id']),
            listing_id=listing_id,
            platforms=requirements_row['platforms'] or [],
            min_followers=requirements_row['min_followers'],
            target_countries=requirements_row['target_countries'] or [],
            target_age_min=requirements_row['target_age_min'],
            target_age_max=requirements_row['target_age_max'],
            created_at=requirements_row['created_at'],
            updated_at=requirements_row['updated_at']
        )
        
        return ListingResponse(
            id=listing_id,
            hotel_profile_id=str(listing_row['hotel_profile_id']),
            name=listing_row['name'],
            location=listing_row['location'],
            description=listing_row['description'],
            accommodation_type=listing_row['accommodation_type'],
            images=listing_row['images'] or [],
            status=listing_row['status'],
            created_at=listing_row['created_at'],
            updated_at=listing_row['updated_at'],
            collaboration_offerings=offerings,
            creator_requirements=requirements
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create listing: {str(e)}"
        )


@router.put("/me/listings/{listing_id}", response_model=ListingResponse, status_code=status.HTTP_200_OK)
async def update_listing(
    listing_id: str,
    request: UpdateListingRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update an existing listing with all its offerings and requirements
    """
    try:
        # Get hotel profile ID
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Verify listing belongs to this hotel
        listing = await Database.fetchrow(
            "SELECT * FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2",
            listing_id, hotel_profile_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Update listing fields if provided
        if any([request.name, request.location, request.description, 
                request.accommodation_type is not None, request.images is not None]):
            updates = []
            values = []
            param_num = 1
            
            if request.name is not None:
                updates.append(f"name = ${param_num}")
                values.append(request.name)
                param_num += 1
            
            if request.location is not None:
                updates.append(f"location = ${param_num}")
                values.append(request.location)
                param_num += 1
            
            if request.description is not None:
                updates.append(f"description = ${param_num}")
                values.append(request.description)
                param_num += 1
            
            if request.accommodation_type is not None:
                updates.append(f"accommodation_type = ${param_num}")
                values.append(request.accommodation_type)
                param_num += 1
            
            if request.images is not None:
                updates.append(f"images = ${param_num}::text[]")
                values.append(request.images)
                param_num += 1
            
            updates.append("updated_at = now()")
            values.extend([listing_id, hotel_profile_id])
            
            query = f"""
                UPDATE hotel_listings
                SET {', '.join(updates)}
                WHERE id = ${param_num} AND hotel_profile_id = ${param_num + 1}
            """
            
            await Database.execute(query, *values)
        
        # Update collaboration offerings if provided
        if request.collaboration_offerings is not None:
            # Delete existing offerings
            await Database.execute(
                "DELETE FROM listing_collaboration_offerings WHERE listing_id = $1",
                listing_id
            )
            
            # Insert new offerings
            for offering in request.collaboration_offerings:
                await Database.execute(
                    """
                    INSERT INTO listing_collaboration_offerings (
                      listing_id, collaboration_type, availability_months,
                      platforms, free_stay_min_nights, free_stay_max_nights,
                      paid_max_amount, discount_percentage
                    )
                    VALUES ($1, $2, $3::text[], $4::text[], $5, $6, $7, $8)
                    """,
                    listing_id,
                    offering.collaboration_type,
                    offering.availability_months,
                    offering.platforms,
                    offering.free_stay_min_nights,
                    offering.free_stay_max_nights,
                    offering.paid_max_amount,
                    offering.discount_percentage
                )
        
        # Update creator requirements if provided
        if request.creator_requirements is not None:
            # Check if requirements exist
            existing = await Database.fetchrow(
                "SELECT id FROM listing_creator_requirements WHERE listing_id = $1",
                listing_id
            )
            
            if existing:
                # Update existing
                await Database.execute(
                    """
                    UPDATE listing_creator_requirements
                    SET 
                      platforms = $1::text[],
                      min_followers = $2,
                      target_countries = $3::text[],
                      target_age_min = $4,
                      target_age_max = $5,
                      updated_at = now()
                    WHERE listing_id = $6
                    """,
                    request.creator_requirements.platforms,
                    request.creator_requirements.min_followers,
                    request.creator_requirements.target_countries,
                    request.creator_requirements.target_age_min,
                    request.creator_requirements.target_age_max,
                    listing_id
                )
            else:
                # Create new
                await Database.execute(
                    """
                    INSERT INTO listing_creator_requirements (
                      listing_id, platforms, min_followers,
                      target_countries, target_age_min, target_age_max
                    )
                    VALUES ($1, $2::text[], $3, $4::text[], $5, $6)
                    """,
                    listing_id,
                    request.creator_requirements.platforms,
                    request.creator_requirements.min_followers,
                    request.creator_requirements.target_countries,
                    request.creator_requirements.target_age_min,
                    request.creator_requirements.target_age_max
                )
        
        # Get updated listing
        listing_row = await Database.fetchrow(
            "SELECT * FROM hotel_listings WHERE id = $1",
            listing_id
        )
        
        # Get collaboration offerings
        offerings_rows = await Database.fetch(
            "SELECT * FROM listing_collaboration_offerings WHERE listing_id = $1",
            listing_id
        )
        
        offerings = []
        for offering_row in offerings_rows:
            offerings.append(CollaborationOfferingResponse(
                id=str(offering_row['id']),
                listing_id=listing_id,
                collaboration_type=offering_row['collaboration_type'],
                availability_months=offering_row['availability_months'] or [],
                platforms=offering_row['platforms'] or [],
                free_stay_min_nights=offering_row['free_stay_min_nights'],
                free_stay_max_nights=offering_row['free_stay_max_nights'],
                paid_max_amount=float(offering_row['paid_max_amount']) if offering_row['paid_max_amount'] else None,
                discount_percentage=offering_row['discount_percentage'],
                created_at=offering_row['created_at'],
                updated_at=offering_row['updated_at']
            ))
        
        # Get creator requirements
        requirements_row = await Database.fetchrow(
            "SELECT * FROM listing_creator_requirements WHERE listing_id = $1",
            listing_id
        )
        
        requirements = None
        if requirements_row:
            requirements = CreatorRequirementsResponse(
                id=str(requirements_row['id']),
                listing_id=listing_id,
                platforms=requirements_row['platforms'] or [],
                min_followers=requirements_row['min_followers'],
                target_countries=requirements_row['target_countries'] or [],
                target_age_min=requirements_row['target_age_min'],
                target_age_max=requirements_row['target_age_max'],
                created_at=requirements_row['created_at'],
                updated_at=requirements_row['updated_at']
            )
        
        return ListingResponse(
            id=listing_id,
            hotel_profile_id=str(listing_row['hotel_profile_id']),
            name=listing_row['name'],
            location=listing_row['location'],
            description=listing_row['description'],
            accommodation_type=listing_row['accommodation_type'],
            images=listing_row['images'] or [],
            status=listing_row['status'],
            created_at=listing_row['created_at'],
            updated_at=listing_row['updated_at'],
            collaboration_offerings=offerings,
            creator_requirements=requirements
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update listing: {str(e)}"
        )


@router.delete("/me/listings/{listing_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_listing(
    listing_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Delete a listing (cascades to offerings and requirements)
    """
    try:
        # Get hotel profile ID
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Verify listing belongs to this hotel
        listing = await Database.fetchrow(
            "SELECT id FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2",
            listing_id, hotel_profile_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Delete listing (CASCADE will handle offerings and requirements)
        await Database.execute(
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


@router.post("/me/listings/{listing_id}/upload-images", response_model=UploadImagesResponse, status_code=status.HTTP_200_OK)
async def upload_listing_images(
    listing_id: str,
    images: List[UploadFile] = File(..., description="Listing images"),
    user_id: str = Depends(get_current_user_id)
):
    """
    Upload images for a listing
    
    NOTE: This endpoint currently returns placeholder URLs.
    Actual file storage implementation (e.g., S3) needs to be added.
    """
    try:
        # Get hotel profile ID
        hotel_profile = await Database.fetchrow(
            "SELECT id FROM hotel_profiles WHERE user_id = $1",
            user_id
        )
        
        if not hotel_profile:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel profile not found"
            )
        
        hotel_profile_id = str(hotel_profile['id'])
        
        # Verify listing belongs to this hotel
        listing = await Database.fetchrow(
            "SELECT id, images FROM hotel_listings WHERE id = $1 AND hotel_profile_id = $2",
            listing_id, hotel_profile_id
        )
        
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Listing not found"
            )
        
        # Validate all files are images
        for image in images:
            if not image.content_type or not image.content_type.startswith('image/'):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"File '{image.filename}' must be an image"
                )
        
        # TODO: Implement actual file upload to storage (S3, local filesystem, etc.)
        # For now, return placeholder URLs
        # In production, you would:
        # 1. Save each file to storage
        # 2. Get the public URLs
        # 3. Append to existing images array in hotel_listings.images
        
        uploaded_urls = []
        existing_images = listing['images'] or []
        
        for image in images:
            file_extension = image.filename.split('.')[-1] if image.filename else 'jpg'
            placeholder_url = f"https://example.com/uploads/listing-image-{uuid.uuid4()}.{file_extension}"
            uploaded_urls.append(placeholder_url)
        
        # Update listing with new images (append to existing)
        all_images = existing_images + uploaded_urls
        await Database.execute(
            "UPDATE hotel_listings SET images = $1::text[], updated_at = now() WHERE id = $2",
            all_images, listing_id
        )
        
        return UploadImagesResponse(urls=uploaded_urls)
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload images: {str(e)}"
        )

