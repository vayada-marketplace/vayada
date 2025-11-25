"""
Creator profile routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime
import json
from app.database import Database
from app.dependencies import get_current_user_id, get_current_creator_id

router = APIRouter(prefix="/creators", tags=["creators"])


# ============================================
# Request/Response Models
# ============================================

class PlatformCountry(BaseModel):
    country: str
    percentage: float


class PlatformAgeGroup(BaseModel):
    ageRange: str
    percentage: float


class PlatformGenderSplit(BaseModel):
    male: float
    female: float


class PlatformResponse(BaseModel):
    id: str
    creator_id: str
    name: str
    handle: str
    followers: int
    engagement_rate: float
    top_countries: Optional[List[PlatformCountry]] = None
    top_age_groups: Optional[List[PlatformAgeGroup]] = None
    gender_split: Optional[PlatformGenderSplit] = None
    created_at: datetime
    updated_at: datetime


class CreatorRatingReview(BaseModel):
    id: str
    hotel_id: str
    hotel_name: Optional[str] = None
    rating: int
    comment: Optional[str] = None
    created_at: datetime


class CreatorRatingSummary(BaseModel):
    averageRating: float
    totalReviews: int
    reviews: List[CreatorRatingReview]


class CreatorProfileResponse(BaseModel):
    id: str
    user_id: str
    name: str
    location: str
    short_description: str
    portfolio_link: Optional[str] = None
    phone: Optional[str] = None
    email: str
    profile_picture: Optional[str] = None
    status: str
    profile_complete: bool
    platforms: List[PlatformResponse]
    rating: Optional[CreatorRatingSummary] = None
    created_at: datetime
    updated_at: datetime


class UpdateCreatorProfileRequest(BaseModel):
    location: Optional[str] = None
    short_description: Optional[str] = None
    portfolio_link: Optional[str] = None
    phone: Optional[str] = None


class CreatePlatformRequest(BaseModel):
    name: str = Field(..., description="Platform name: Instagram, TikTok, YouTube, or Facebook")
    handle: str
    followers: int = Field(..., ge=0)
    engagement_rate: float = Field(..., ge=0, le=100)
    top_countries: Optional[List[PlatformCountry]] = None
    top_age_groups: Optional[List[PlatformAgeGroup]] = None
    gender_split: Optional[PlatformGenderSplit] = None


class UpdatePlatformRequest(BaseModel):
    handle: Optional[str] = None
    followers: Optional[int] = Field(None, ge=0)
    engagement_rate: Optional[float] = Field(None, ge=0, le=100)
    top_countries: Optional[List[PlatformCountry]] = None
    top_age_groups: Optional[List[PlatformAgeGroup]] = None
    gender_split: Optional[PlatformGenderSplit] = None


# ============================================
# Helper Functions
# ============================================

def parse_jsonb(data: Any) -> Optional[Any]:
    """Parse JSONB data from database"""
    if data is None:
        return None
    if isinstance(data, str):
        return json.loads(data)
    return data


# ============================================
# Endpoints
# ============================================

@router.get("/me", response_model=CreatorProfileResponse, status_code=status.HTTP_200_OK)
async def get_creator_profile(
    user_id: str = Depends(get_current_user_id)
):
    """
    Get current creator's profile with platforms and ratings
    """
    try:
        # Get creator profile
        creator = await Database.fetchrow(
            """
            SELECT 
              c.id,
              c.user_id,
              c.location,
              c.short_description,
              c.portfolio_link,
              c.phone,
              c.profile_complete,
              c.profile_completed_at,
              c.created_at,
              c.updated_at,
              u.name,
              u.email,
              u.avatar as profile_picture,
              u.status
            FROM creators c
            INNER JOIN users u ON c.user_id = u.id
            WHERE c.user_id = $1
            """,
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator['id'])
        
        # Get platforms
        platform_rows = await Database.fetch(
            """
            SELECT * FROM creator_platforms
            WHERE creator_id = $1
            ORDER BY created_at ASC
            """,
            creator_id
        )
        
        platforms = []
        for row in platform_rows:
            platforms.append(PlatformResponse(
                id=str(row['id']),
                creator_id=creator_id,
                name=row['name'],
                handle=row['handle'],
                followers=row['followers'],
                engagement_rate=float(row['engagement_rate']),
                top_countries=[
                    PlatformCountry(**item) for item in parse_jsonb(row['top_countries']) or []
                ] if row['top_countries'] else None,
                top_age_groups=[
                    PlatformAgeGroup(**item) for item in parse_jsonb(row['top_age_groups']) or []
                ] if row['top_age_groups'] else None,
                gender_split=PlatformGenderSplit(**parse_jsonb(row['gender_split'])) if row['gender_split'] else None,
                created_at=row['created_at'],
                updated_at=row['updated_at']
            ))
        
        # Get rating summary
        rating_summary = await Database.fetchrow(
            """
            SELECT 
              COALESCE(AVG(rating), 0) as average_rating,
              COUNT(*) as total_reviews
            FROM creator_ratings
            WHERE creator_id = $1
            """,
            creator_id
        )
        
        # Get individual reviews
        # Note: hotels table might not exist yet, so we'll try to join but handle gracefully
        try:
            review_rows = await Database.fetch(
                """
                SELECT 
                  cr.id,
                  cr.hotel_id,
                  h.name as hotel_name,
                  cr.rating,
                  cr.comment,
                  cr.created_at
                FROM creator_ratings cr
                LEFT JOIN hotels h ON cr.hotel_id = h.id
                WHERE cr.creator_id = $1
                ORDER BY cr.created_at DESC
                """,
                creator_id
            )
        except Exception:
            # Hotels table doesn't exist yet, get reviews without hotel name
            review_rows = await Database.fetch(
                """
                SELECT 
                  cr.id,
                  cr.hotel_id,
                  NULL as hotel_name,
                  cr.rating,
                  cr.comment,
                  cr.created_at
                FROM creator_ratings cr
                WHERE cr.creator_id = $1
                ORDER BY cr.created_at DESC
                """,
                creator_id
            )
        
        reviews = []
        for row in review_rows:
            reviews.append(CreatorRatingReview(
                id=str(row['id']),
                hotel_id=str(row['hotel_id']),
                hotel_name=row['hotel_name'],
                rating=row['rating'],
                comment=row['comment'],
                created_at=row['created_at']
            ))
        
        rating = None
        if rating_summary and rating_summary['total_reviews'] > 0:
            rating = CreatorRatingSummary(
                averageRating=float(rating_summary['average_rating']),
                totalReviews=rating_summary['total_reviews'],
                reviews=reviews
            )
        
        return CreatorProfileResponse(
            id=creator_id,
            user_id=str(creator['user_id']),
            name=creator['name'],
            location=creator['location'],
            short_description=creator['short_description'],
            portfolio_link=creator['portfolio_link'],
            phone=creator['phone'],
            email=creator['email'],
            profile_picture=creator['profile_picture'],
            status=creator['status'],
            profile_complete=creator['profile_complete'],
            platforms=platforms,
            rating=rating,
            created_at=creator['created_at'],
            updated_at=creator['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get creator profile: {str(e)}"
        )


@router.put("/me", status_code=status.HTTP_200_OK)
async def update_creator_profile(
    request: UpdateCreatorProfileRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update creator profile (location, short_description, portfolio_link, phone)
    """
    try:
        # Verify user is creator and has profile
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        # Build update query dynamically
        updates = []
        values = []
        param_num = 1
        
        if request.location is not None:
            updates.append(f"location = ${param_num}")
            values.append(request.location)
            param_num += 1
        
        if request.short_description is not None:
            updates.append(f"short_description = ${param_num}")
            values.append(request.short_description)
            param_num += 1
        
        if request.portfolio_link is not None:
            updates.append(f"portfolio_link = ${param_num}")
            values.append(request.portfolio_link)
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
        
        updates.append(f"updated_at = now()")
        values.append(user_id)
        
        query = f"""
            UPDATE creators
            SET {', '.join(updates)}
            WHERE user_id = ${param_num}
            RETURNING *
        """
        
        updated = await Database.fetchrow(query, *values)
        
        return {
            "id": str(updated['id']),
            "user_id": str(updated['user_id']),
            "location": updated['location'],
            "short_description": updated['short_description'],
            "portfolio_link": updated['portfolio_link'],
            "phone": updated['phone'],
            "profile_complete": updated['profile_complete'],
            "updated_at": updated['updated_at']
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update creator profile: {str(e)}"
        )


@router.post("/me/platforms", response_model=PlatformResponse, status_code=status.HTTP_201_CREATED)
async def create_platform(
    request: CreatePlatformRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Add a new platform to creator profile
    """
    try:
        # Get creator_id
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator['id'])
        
        # Validate platform name
        valid_platforms = ['Instagram', 'TikTok', 'YouTube', 'Facebook']
        if request.name not in valid_platforms:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Platform must be one of: {', '.join(valid_platforms)}"
            )
        
        # Check if platform already exists for this creator
        existing = await Database.fetchrow(
            "SELECT id FROM creator_platforms WHERE creator_id = $1 AND name = $2",
            creator_id, request.name
        )
        
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Platform '{request.name}' already exists for this creator"
            )
        
        # Insert platform
        platform = await Database.fetchrow(
            """
            INSERT INTO creator_platforms (
              creator_id, name, handle, followers, engagement_rate,
              top_countries, top_age_groups, gender_split
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
            RETURNING *
            """,
            creator_id,
            request.name,
            request.handle,
            request.followers,
            request.engagement_rate,
            json.dumps([item.dict() for item in request.top_countries]) if request.top_countries else None,
            json.dumps([item.dict() for item in request.top_age_groups]) if request.top_age_groups else None,
            json.dumps(request.gender_split.dict()) if request.gender_split else None
        )
        
        return PlatformResponse(
            id=str(platform['id']),
            creator_id=creator_id,
            name=platform['name'],
            handle=platform['handle'],
            followers=platform['followers'],
            engagement_rate=float(platform['engagement_rate']),
            top_countries=[
                PlatformCountry(**item) for item in parse_jsonb(platform['top_countries']) or []
            ] if platform['top_countries'] else None,
            top_age_groups=[
                PlatformAgeGroup(**item) for item in parse_jsonb(platform['top_age_groups']) or []
            ] if platform['top_age_groups'] else None,
            gender_split=PlatformGenderSplit(**parse_jsonb(platform['gender_split'])) if platform['gender_split'] else None,
            created_at=platform['created_at'],
            updated_at=platform['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create platform: {str(e)}"
        )


@router.put("/me/platforms/{platform_id}", response_model=PlatformResponse, status_code=status.HTTP_200_OK)
async def update_platform(
    platform_id: str,
    request: UpdatePlatformRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update a platform
    """
    try:
        # Get creator_id
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator['id'])
        
        # Verify platform belongs to creator
        platform = await Database.fetchrow(
            "SELECT * FROM creator_platforms WHERE id = $1 AND creator_id = $2",
            platform_id, creator_id
        )
        
        if not platform:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform not found"
            )
        
        # Build update query
        updates = []
        values = []
        param_num = 1
        
        if request.handle is not None:
            updates.append(f"handle = ${param_num}")
            values.append(request.handle)
            param_num += 1
        
        if request.followers is not None:
            updates.append(f"followers = ${param_num}")
            values.append(request.followers)
            param_num += 1
        
        if request.engagement_rate is not None:
            updates.append(f"engagement_rate = ${param_num}")
            values.append(request.engagement_rate)
            param_num += 1
        
        if request.top_countries is not None:
            updates.append(f"top_countries = ${param_num}::jsonb")
            values.append(json.dumps([item.dict() for item in request.top_countries]))
            param_num += 1
        
        if request.top_age_groups is not None:
            updates.append(f"top_age_groups = ${param_num}::jsonb")
            values.append(json.dumps([item.dict() for item in request.top_age_groups]))
            param_num += 1
        
        if request.gender_split is not None:
            updates.append(f"gender_split = ${param_num}::jsonb")
            values.append(json.dumps(request.gender_split.dict()))
            param_num += 1
        
        if not updates:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="At least one field must be provided for update"
            )
        
        updates.append("updated_at = now()")
        values.extend([platform_id, creator_id])
        
        query = f"""
            UPDATE creator_platforms
            SET {', '.join(updates)}
            WHERE id = ${param_num} AND creator_id = ${param_num + 1}
            RETURNING *
        """
        
        updated = await Database.fetchrow(query, *values)
        
        return PlatformResponse(
            id=str(updated['id']),
            creator_id=creator_id,
            name=updated['name'],
            handle=updated['handle'],
            followers=updated['followers'],
            engagement_rate=float(updated['engagement_rate']),
            top_countries=[
                PlatformCountry(**item) for item in parse_jsonb(updated['top_countries']) or []
            ] if updated['top_countries'] else None,
            top_age_groups=[
                PlatformAgeGroup(**item) for item in parse_jsonb(updated['top_age_groups']) or []
            ] if updated['top_age_groups'] else None,
            gender_split=PlatformGenderSplit(**parse_jsonb(updated['gender_split'])) if updated['gender_split'] else None,
            created_at=updated['created_at'],
            updated_at=updated['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update platform: {str(e)}"
        )


@router.delete("/me/platforms/{platform_id}", status_code=status.HTTP_200_OK)
async def delete_platform(
    platform_id: str,
    user_id: str = Depends(get_current_user_id)
):
    """
    Delete a platform
    """
    try:
        # Get creator_id
        creator = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1",
            user_id
        )
        
        if not creator:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator profile not found"
            )
        
        creator_id = str(creator['id'])
        
        # Verify platform belongs to creator
        platform = await Database.fetchrow(
            "SELECT id FROM creator_platforms WHERE id = $1 AND creator_id = $2",
            platform_id, creator_id
        )
        
        if not platform:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Platform not found"
            )
        
        # Delete platform
        await Database.execute(
            "DELETE FROM creator_platforms WHERE id = $1 AND creator_id = $2",
            platform_id, creator_id
        )
        
        return {"message": "Platform deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete platform: {str(e)}"
        )

