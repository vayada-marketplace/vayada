"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel, EmailStr, Field
from typing import List, Optional, Literal
from datetime import datetime
from decimal import Decimal
import logging

from app.database import Database
from app.dependencies import get_current_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# Admin dependency - checks if user is admin
async def get_admin_user(user_id: str = Depends(get_current_user_id)) -> str:
    """
    Verify that the current user is an admin.
    """
    user = await Database.fetchrow(
        "SELECT id, type, status FROM users WHERE id = $1",
        user_id
    )
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    if user['type'] != 'admin':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    
    if user['status'] == 'suspended':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin account is suspended"
        )
    
    return user_id


# Response models
class UserListItem(BaseModel):
    """User list item response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response with pagination"""
    users: List[UserListItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class UserDetailResponse(BaseModel):
    """Detailed user response with profile information"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # Profile information (if exists)
    creator_profile: Optional[dict] = None
    hotel_profile: Optional[dict] = None


class UpdateUserRequest(BaseModel):
    """Request model for updating user information"""
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = None


class UpdateUserResponse(BaseModel):
    """Response model for user update"""
    message: str
    user: UserDetailResponse


class UpdateUserStatusRequest(BaseModel):
    """Request model for updating user status"""
    status: Literal["pending", "verified", "rejected", "suspended"]
    reason: Optional[str] = None


class UpdateUserStatusResponse(BaseModel):
    """Response model for status update"""
    message: str
    user_id: str
    old_status: str
    new_status: str


class CreateUserRequest(BaseModel):
    """Request model for creating a new user"""
    name: str = Field(..., min_length=1, description="User's full name")
    email: EmailStr = Field(..., description="User's email address")
    password: str = Field(..., min_length=8, description="User's password (min 8 characters)")
    type: Literal["creator", "hotel", "admin"] = Field(..., description="User type")
    status: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Field(
        default="pending", 
        description="Initial user status"
    )
    avatar: Optional[str] = Field(None, description="Avatar URL")
    email_verified: Optional[bool] = Field(default=False, description="Whether email is verified")


class CreateUserResponse(BaseModel):
    """Response model for user creation"""
    message: str
    user: UserDetailResponse


class DeleteUserResponse(BaseModel):
    """Response model for user deletion"""
    message: str
    deleted_user_id: str
    cascade_deleted: dict


@router.post("/users", response_model=CreateUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    request: CreateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Create a new user.
    
    Admin can create users with initial profile data.
    For creator/hotel types, basic profile records will be created automatically.
    """
    try:
        from app.auth import hash_password
        
        # Check if email already exists
        existing_user = await Database.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            request.email
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already in use"
            )
        
        # Hash password
        password_hash = hash_password(request.password)
        
        # Create user
        new_user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status, avatar, email_verified)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, email, name, type, status, email_verified, avatar, created_at, updated_at
            """,
            request.email,
            password_hash,
            request.name,
            request.type,
            request.status,
            request.avatar,
            request.email_verified
        )
        
        user_id = str(new_user['id'])
        
        # Create profile based on user type
        creator_profile = None
        hotel_profile = None
        
        if request.type == 'creator':
            # Create empty creator profile
            creator = await Database.fetchrow(
                """
                INSERT INTO creators (user_id)
                VALUES ($1)
                RETURNING id, location, short_description, portfolio_link, phone,
                        profile_picture, profile_complete, profile_completed_at,
                        created_at, updated_at
                """,
                user_id
            )
            if creator:
                creator_profile = {
                    'id': str(creator['id']),
                    'location': creator['location'],
                    'short_description': creator['short_description'],
                    'portfolio_link': creator['portfolio_link'],
                    'phone': creator['phone'],
                    'profile_picture': creator['profile_picture'],
                    'profile_complete': creator['profile_complete'],
                    'profile_completed_at': creator['profile_completed_at'].isoformat() if creator['profile_completed_at'] else None,
                    'created_at': creator['created_at'].isoformat(),
                    'updated_at': creator['updated_at'].isoformat(),
                    'platforms': []
                }
        
        elif request.type == 'hotel':
            # Create hotel profile with placeholder location
            hotel = await Database.fetchrow(
                """
                INSERT INTO hotel_profiles (user_id, name, location)
                VALUES ($1, $2, 'Not specified')
                RETURNING id, name, location, about, website, phone,
                        picture, profile_complete, profile_completed_at,
                        created_at, updated_at
                """,
                user_id,
                request.name  # Use user name as initial hotel name
            )
            if hotel:
                # Get listings count (will be 0 for new hotel)
                listings_count = await Database.fetchval(
                    "SELECT COUNT(*) FROM hotel_listings WHERE hotel_profile_id = $1",
                    hotel['id']
                )
                
                hotel_profile = {
                    'id': str(hotel['id']),
                    'name': hotel['name'],
                    'location': hotel['location'],
                    'about': hotel['about'],
                    'website': hotel['website'],
                    'phone': hotel['phone'],
                    'picture': hotel['picture'],
                    'profile_complete': hotel['profile_complete'],
                    'profile_completed_at': hotel['profile_completed_at'].isoformat() if hotel['profile_completed_at'] else None,
                    'created_at': hotel['created_at'].isoformat(),
                    'updated_at': hotel['updated_at'].isoformat(),
                    'listings_count': listings_count
                }
        
        user_detail = UserDetailResponse(
            id=user_id,
            email=new_user['email'],
            name=new_user['name'],
            type=new_user['type'],
            status=new_user['status'],
            email_verified=new_user['email_verified'],
            avatar=new_user['avatar'],
            created_at=new_user['created_at'],
            updated_at=new_user['updated_at'],
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
        logger.info(f"Admin {admin_id} created user {user_id} (type: {request.type})")
        
        return CreateUserResponse(
            message="User created successfully",
            user=user_detail
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create user: {str(e)}"
        )


@router.delete("/users/{user_id}", response_model=DeleteUserResponse, status_code=status.HTTP_200_OK)
async def delete_user(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Delete a user and all associated data (cascade delete).
    
    This will delete:
    - User record
    - Creator profile (if creator) and all platforms
    - Hotel profile (if hotel) and all listings
    - All related records due to CASCADE constraints
    
    Admins cannot delete their own account.
    """
    try:
        # Check if user exists and get type for cascade info
        user = await Database.fetchrow(
            "SELECT id, type FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Prevent admin from deleting themselves
        if user_id == admin_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own admin account"
            )
        
        # Count related records before deletion (for response)
        cascade_info = {}
        
        if user['type'] == 'creator':
            # Count platforms
            creator = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            if creator:
                platform_count = await Database.fetchrow(
                    "SELECT COUNT(*) as count FROM creator_platforms WHERE creator_id = $1",
                    creator['id']
                )
                cascade_info['platforms'] = platform_count['count'] if platform_count else 0
            else:
                cascade_info['platforms'] = 0
        
        elif user['type'] == 'hotel':
            # Count listings
            hotel = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            if hotel:
                listing_count = await Database.fetchrow(
                    "SELECT COUNT(*) as count FROM hotel_listings WHERE hotel_profile_id = $1",
                    hotel['id']
                )
                cascade_info['listings'] = listing_count['count'] if listing_count else 0
            else:
                cascade_info['listings'] = 0
        
        # Delete user (CASCADE will handle related records)
        await Database.execute(
            "DELETE FROM users WHERE id = $1",
            user_id
        )
        
        logger.info(f"Admin {admin_id} deleted user {user_id} (type: {user['type']})")
        
        return DeleteUserResponse(
            message="User deleted successfully",
            deleted_user_id=user_id,
            cascade_deleted=cascade_info
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete user: {str(e)}"
        )


@router.get("/users", response_model=UserListResponse, status_code=status.HTTP_200_OK)
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    type: Optional[Literal["creator", "hotel", "admin"]] = Query(None, description="Filter by user type"),
    status_filter: Optional[Literal["pending", "verified", "rejected", "suspended"]] = Query(None, alias="status", description="Filter by status"),
    search: Optional[str] = Query(None, description="Search by name or email"),
    admin_id: str = Depends(get_admin_user)
):
    """
    List all users with pagination and filtering.
    
    - **page**: Page number (starts at 1)
    - **page_size**: Number of items per page (max 100)
    - **type**: Filter by user type (creator, hotel, admin)
    - **status**: Filter by user status (pending, verified, rejected, suspended)
    - **search**: Search by name or email (case-insensitive)
    """
    try:
        # Build WHERE clause
        where_conditions = []
        params = []
        param_count = 0
        
        if type:
            param_count += 1
            where_conditions.append(f"u.type = ${param_count}")
            params.append(type)
        
        if status_filter:
            param_count += 1
            where_conditions.append(f"u.status = ${param_count}")
            params.append(status_filter)
        
        if search:
            param_count += 1
            where_conditions.append(f"(LOWER(u.name) LIKE LOWER(${param_count}) OR LOWER(u.email) LIKE LOWER(${param_count}))")
            search_pattern = f"%{search}%"
            params.append(search_pattern)
        
        where_clause = " AND ".join(where_conditions) if where_conditions else "1=1"
        
        # Get total count
        count_query = f"""
            SELECT COUNT(*) as total
            FROM users u
            WHERE {where_clause}
        """
        total_result = await Database.fetchrow(count_query, *params)
        total = total_result['total'] if total_result else 0
        
        # Calculate pagination
        offset = (page - 1) * page_size
        total_pages = (total + page_size - 1) // page_size if total > 0 else 0
        
        # Get users
        users_query = f"""
            SELECT 
                u.id, u.email, u.name, u.type, u.status, 
                u.email_verified, u.created_at, u.updated_at
            FROM users u
            WHERE {where_clause}
            ORDER BY u.created_at DESC
            LIMIT ${param_count + 1} OFFSET ${param_count + 2}
        """
        params.extend([page_size, offset])
        
        users_data = await Database.fetch(users_query, *params)
        
        users = [
            UserListItem(
                id=str(u['id']),
                email=u['email'],
                name=u['name'],
                type=u['type'],
                status=u['status'],
                email_verified=u['email_verified'],
                created_at=u['created_at'],
                updated_at=u['updated_at']
            )
            for u in users_data
        ]
        
        return UserListResponse(
            users=users,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages
        )
        
    except Exception as e:
        logger.error(f"Error listing users: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list users: {str(e)}"
        )


@router.get("/users/{user_id}", response_model=UserDetailResponse, status_code=status.HTTP_200_OK)
async def get_user_details(
    user_id: str,
    admin_id: str = Depends(get_admin_user)
):
    """
    Get detailed information about a specific user, including profile data.
    """
    try:
        # Get user
        user = await Database.fetchrow(
            """
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            WHERE id = $1
            """,
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Get profile information based on user type
        creator_profile = None
        hotel_profile = None
        
        if user['type'] == 'creator':
            creator = await Database.fetchrow(
                """
                SELECT 
                    c.id, c.location, c.short_description, c.portfolio_link, c.phone,
                    c.profile_picture, c.profile_complete, c.profile_completed_at,
                    c.created_at, c.updated_at
                FROM creators c
                WHERE c.user_id = $1
                """,
                user_id
            )
            if creator:
                creator_profile = {
                    'id': str(creator['id']),
                    'location': creator['location'],
                    'short_description': creator['short_description'],
                    'portfolio_link': creator['portfolio_link'],
                    'phone': creator['phone'],
                    'profile_picture': creator['profile_picture'],
                    'profile_complete': creator['profile_complete'],
                    'profile_completed_at': creator['profile_completed_at'].isoformat() if creator['profile_completed_at'] else None,
                    'created_at': creator['created_at'].isoformat(),
                    'updated_at': creator['updated_at'].isoformat()
                }
                
                # Get platforms
                platforms = await Database.fetch(
                    """
                    SELECT id, name, handle, followers, engagement_rate
                    FROM creator_platforms
                    WHERE creator_id = $1
                    ORDER BY name
                    """,
                    creator['id']
                )
                creator_profile['platforms'] = [
                    {
                        'id': str(p['id']),
                        'name': p['name'],
                        'handle': p['handle'],
                        'followers': p['followers'],
                        'engagement_rate': float(p['engagement_rate']) if p['engagement_rate'] else None
                    }
                    for p in platforms
                ]
        
        elif user['type'] == 'hotel':
            hotel = await Database.fetchrow(
                """
                SELECT 
                    hp.id, hp.name, hp.location, hp.about, hp.website, hp.phone,
                    hp.picture, hp.profile_complete, hp.profile_completed_at,
                    hp.created_at, hp.updated_at
                FROM hotel_profiles hp
                WHERE hp.user_id = $1
                """,
                user_id
            )
            if hotel:
                hotel_profile = {
                    'id': str(hotel['id']),
                    'name': hotel['name'],
                    'location': hotel['location'],
                    'about': hotel['about'],
                    'website': hotel['website'],
                    'phone': hotel['phone'],
                    'picture': hotel['picture'],
                    'profile_complete': hotel['profile_complete'],
                    'profile_completed_at': hotel['profile_completed_at'].isoformat() if hotel['profile_completed_at'] else None,
                    'created_at': hotel['created_at'].isoformat(),
                    'updated_at': hotel['updated_at'].isoformat()
                }
                
                # Get listings count
                listings_count = await Database.fetchval(
                    "SELECT COUNT(*) FROM hotel_listings WHERE hotel_profile_id = $1",
                    hotel['id']
                )
                hotel_profile['listings_count'] = listings_count
        
        return UserDetailResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            email_verified=user['email_verified'],
            avatar=user['avatar'],
            created_at=user['created_at'],
            updated_at=user['updated_at'],
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user details: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get user details: {str(e)}"
        )


@router.put("/users/{user_id}", response_model=UpdateUserResponse, status_code=status.HTTP_200_OK)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update user information (name, email, status).
    """
    try:
        # Check if user exists
        user = await Database.fetchrow(
            "SELECT id, name, email, status FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Build update query
        update_fields = []
        params = []
        param_count = 0
        
        if request.name is not None:
            param_count += 1
            update_fields.append(f"name = ${param_count}")
            params.append(request.name)
        
        if request.email is not None:
            # Check if email is already taken by another user
            existing = await Database.fetchrow(
                "SELECT id FROM users WHERE email = $1 AND id != $2",
                request.email,
                user_id
            )
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already in use by another user"
                )
            param_count += 1
            update_fields.append(f"email = ${param_count}")
            params.append(request.email)
        
        if request.status is not None:
            param_count += 1
            update_fields.append(f"status = ${param_count}")
            params.append(request.status)
        
        if not update_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )
        
        # Add updated_at
        update_fields.append("updated_at = now()")
        
        # Add user_id for WHERE clause
        param_count += 1
        params.append(user_id)
        
        # Execute update
        update_query = f"""
            UPDATE users
            SET {', '.join(update_fields)}
            WHERE id = ${param_count}
            RETURNING id, email, name, type, status, email_verified, avatar, created_at, updated_at
        """
        
        updated_user = await Database.fetchrow(update_query, *params)
        
        # Get profile information
        creator_profile = None
        hotel_profile = None
        
        if updated_user['type'] == 'creator':
            creator = await Database.fetchrow(
                "SELECT id FROM creators WHERE user_id = $1",
                user_id
            )
            if creator:
                creator_profile = {'id': str(creator['id'])}
        elif updated_user['type'] == 'hotel':
            hotel = await Database.fetchrow(
                "SELECT id FROM hotel_profiles WHERE user_id = $1",
                user_id
            )
            if hotel:
                hotel_profile = {'id': str(hotel['id'])}
        
        user_detail = UserDetailResponse(
            id=str(updated_user['id']),
            email=updated_user['email'],
            name=updated_user['name'],
            type=updated_user['type'],
            status=updated_user['status'],
            email_verified=updated_user['email_verified'],
            avatar=updated_user['avatar'],
            created_at=updated_user['created_at'],
            updated_at=updated_user['updated_at'],
            creator_profile=creator_profile,
            hotel_profile=hotel_profile
        )
        
        logger.info(f"Admin {admin_id} updated user {user_id}")
        
        return UpdateUserResponse(
            message="User updated successfully",
            user=user_detail
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user: {str(e)}"
        )


@router.patch("/users/{user_id}/status", response_model=UpdateUserStatusResponse, status_code=status.HTTP_200_OK)
async def update_user_status(
    user_id: str,
    request: UpdateUserStatusRequest,
    admin_id: str = Depends(get_admin_user)
):
    """
    Update user status (approve, deny, suspend).
    This is a convenience endpoint specifically for status changes.
    """
    try:
        # Get current status
        user = await Database.fetchrow(
            "SELECT id, status FROM users WHERE id = $1",
            user_id
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        old_status = user['status']
        
        # Update status
        await Database.execute(
            """
            UPDATE users
            SET status = $1, updated_at = now()
            WHERE id = $2
            """,
            request.status,
            user_id
        )
        
        logger.info(f"Admin {admin_id} changed user {user_id} status from {old_status} to {request.status}")
        if request.reason:
            logger.info(f"Reason: {request.reason}")
        
        return UpdateUserStatusResponse(
            message=f"User status updated from {old_status} to {request.status}",
            user_id=user_id,
            old_status=old_status,
            new_status=request.status
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user status: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update user status: {str(e)}"
        )
