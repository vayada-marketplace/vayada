"""
Creators routes for marketplace
"""
from fastapi import APIRouter, HTTPException, status, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from app.database import Database

router = APIRouter(prefix="/creators", tags=["creators"])


class PlatformResponse(BaseModel):
    """Platform response model"""
    id: str
    name: str
    handle: str
    followers: int
    engagement_rate: float

    class Config:
        from_attributes = True


class CreatorResponse(BaseModel):
    """Creator response model"""
    id: str
    user_id: str
    name: str
    niche: List[str] = []
    audience_size: int = 0
    location: Optional[str] = None
    status: str
    platforms: List[PlatformResponse] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CreatorsListResponse(BaseModel):
    """List of creators response"""
    data: List[CreatorResponse]
    total: int


@router.get("", response_model=CreatorsListResponse, status_code=status.HTTP_200_OK)
async def get_all_creators(
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status (pending, verified, rejected, suspended)"),
    niche: Optional[str] = Query(None, description="Filter by niche"),
    location: Optional[str] = Query(None, description="Filter by location")
):
    """
    Get all creators
    
    - **status**: Optional filter by status (default: returns all)
    - **niche**: Optional filter by niche
    - **location**: Optional filter by location
    """
    try:
        # Build query with filters
        conditions = []
        params = []
        param_num = 1
        
        base_query = """
            SELECT c.id, c.user_id, c.name, c.niche, c.audience_size, c.location, c.status, c.created_at, c.updated_at
            FROM creators c
        """
        
        if status_filter:
            conditions.append(f"c.status = ${param_num}")
            params.append(status_filter)
            param_num += 1
        
        if niche:
            conditions.append(f"${param_num} = ANY(c.niche)")
            params.append(niche)
            param_num += 1
        
        if location:
            conditions.append(f"LOWER(c.location) LIKE LOWER(${param_num})")
            params.append(f"%{location}%")
            param_num += 1
        
        if conditions:
            where_clause = " WHERE " + " AND ".join(conditions)
            query = base_query + where_clause + " ORDER BY c.created_at DESC"
            rows = await Database.fetch(query, *params)
        else:
            query = base_query + " ORDER BY c.created_at DESC"
            rows = await Database.fetch(query)
        
        creators = []
        for row in rows:
            # Fetch platforms for this creator
            platform_rows = await Database.fetch(
                """
                SELECT id, name, handle, followers, engagement_rate
                FROM creator_platforms
                WHERE creator_id = $1
                ORDER BY followers DESC
                """,
                row['id']
            )
            
            platforms = [
                PlatformResponse(
                    id=str(p['id']),
                    name=p['name'],
                    handle=p['handle'],
                    followers=p['followers'] or 0,
                    engagement_rate=float(p['engagement_rate'] or 0.0)
                )
                for p in platform_rows
            ]
            
            # Calculate total audience size if not set
            audience_size = row['audience_size'] or 0
            if audience_size == 0 and platforms:
                audience_size = sum(p.followers for p in platforms)
            
            creators.append(CreatorResponse(
                id=str(row['id']),
                user_id=str(row['user_id']),
                name=row['name'],
                niche=row['niche'] or [],
                audience_size=audience_size,
                location=row['location'],
                status=row['status'],
                platforms=platforms,
                created_at=row['created_at'],
                updated_at=row['updated_at']
            ))
        
        return CreatorsListResponse(
            data=creators,
            total=len(creators)
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch creators: {str(e)}"
        )


@router.get("/{creator_id}", response_model=CreatorResponse, status_code=status.HTTP_200_OK)
async def get_creator_by_id(creator_id: str):
    """
    Get a specific creator by ID
    """
    try:
        row = await Database.fetchrow(
            """
            SELECT id, user_id, name, niche, audience_size, location, status, created_at, updated_at
            FROM creators
            WHERE id = $1
            """,
            creator_id
        )
        
        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Creator not found"
            )
        
        # Fetch platforms for this creator
        platform_rows = await Database.fetch(
            """
            SELECT id, name, handle, followers, engagement_rate
            FROM creator_platforms
            WHERE creator_id = $1
            ORDER BY followers DESC
            """,
            row['id']
        )
        
        platforms = [
            PlatformResponse(
                id=str(p['id']),
                name=p['name'],
                handle=p['handle'],
                followers=p['followers'] or 0,
                engagement_rate=float(p['engagement_rate'] or 0.0)
            )
            for p in platform_rows
        ]
        
        # Calculate total audience size if not set
        audience_size = row['audience_size'] or 0
        if audience_size == 0 and platforms:
            audience_size = sum(p['followers'] or 0 for p in platform_rows)
        
        return CreatorResponse(
            id=str(row['id']),
            user_id=str(row['user_id']),
            name=row['name'],
            niche=row['niche'] or [],
            audience_size=audience_size,
            location=row['location'],
            status=row['status'],
            platforms=platforms,
            created_at=row['created_at'],
            updated_at=row['updated_at']
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch creator: {str(e)}"
        )

