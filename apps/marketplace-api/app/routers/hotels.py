"""
Hotels routes for marketplace
"""
from fastapi import APIRouter, HTTPException, status, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from app.database import Database

router = APIRouter(prefix="/hotels", tags=["hotels"])


class HotelResponse(BaseModel):
    """Hotel response model"""
    id: str
    user_id: str
    name: str
    location: str
    description: Optional[str] = None
    images: List[str] = []
    amenities: List[str] = []
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class HotelsListResponse(BaseModel):
    """List of hotels response"""
    data: List[HotelResponse]
    total: int


@router.get("", response_model=HotelsListResponse, status_code=status.HTTP_200_OK)
async def get_all_hotels(
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status (pending, verified, rejected, suspended)")
):
    """
    Get all hotels
    
    - **status**: Optional filter by status (default: returns all)
    """
    try:
        # Build query based on status filter
        if status_filter:
            query = """
                SELECT id, user_id, name, location, description, images, amenities, status, created_at, updated_at
                FROM hotels
                WHERE status = $1
                ORDER BY created_at DESC
            """
            rows = await Database.fetch(query, status_filter)
        else:
            query = """
                SELECT id, user_id, name, location, description, images, amenities, status, created_at, updated_at
                FROM hotels
                ORDER BY created_at DESC
            """
            rows = await Database.fetch(query)
        
        hotels = []
        for row in rows:
            hotels.append(HotelResponse(
                id=str(row['id']),
                user_id=str(row['user_id']),
                name=row['name'],
                location=row['location'],
                description=row['description'],
                images=row['images'] or [],
                amenities=row['amenities'] or [],
                status=row['status'],
                created_at=row['created_at'],
                updated_at=row['updated_at']
            ))
        
        return HotelsListResponse(
            data=hotels,
            total=len(hotels)
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch hotels: {str(e)}"
        )


@router.get("/{hotel_id}", response_model=HotelResponse, status_code=status.HTTP_200_OK)
async def get_hotel_by_id(hotel_id: str):
    """
    Get a specific hotel by ID
    """
    try:
        row = await Database.fetchrow(
            """
            SELECT id, user_id, name, location, description, images, amenities, status, created_at, updated_at
            FROM hotels
            WHERE id = $1
            """,
            hotel_id
        )
        
        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Hotel not found"
            )
        
        return HotelResponse(
            id=str(row['id']),
            user_id=str(row['user_id']),
            name=row['name'],
            location=row['location'],
            description=row['description'],
            images=row['images'] or [],
            amenities=row['amenities'] or [],
            status=row['status'],
            created_at=row['created_at'],
            updated_at=row['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch hotel: {str(e)}"
        )

