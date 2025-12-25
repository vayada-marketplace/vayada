"""
Admin routes for user management
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
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
class UserResponse(BaseModel):
    """User response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    email_verified: bool
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class UserListResponse(BaseModel):
    """User list response"""
    users: List[UserResponse]
    total: int


@router.get("/users", response_model=UserListResponse, status_code=status.HTTP_200_OK)
async def get_all_users(
    page: int = Query(1, ge=1, description="Page number (starts at 1)"),
    page_size: int = Query(10, ge=1, le=100, description="Number of items per page (max 100)"),
    type: Optional[str] = Query(None, description="Filter by user type (creator, hotel, admin)"),
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by user status (pending, verified, rejected, suspended)"),
    search: Optional[str] = Query(None, description="Search by name or email (case-insensitive)"),
    admin_id: str = Depends(get_admin_user)
):
    """
    Get all users with optional filtering and pagination.
    
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
            where_conditions.append(f"type = ${param_count}")
            params.append(type)
        
        if status_filter:
            param_count += 1
            where_conditions.append(f"status = ${param_count}")
            params.append(status_filter)
        
        if search:
            param_count += 1
            where_conditions.append(f"(LOWER(name) LIKE ${param_count} OR LOWER(email) LIKE ${param_count + 1})")
            search_pattern = f"%{search.lower()}%"
            params.append(search_pattern)
            params.append(search_pattern)
            param_count += 1  # Increment for the second search parameter
        
        where_clause = f"WHERE {' AND '.join(where_conditions)}" if where_conditions else ""
        
        # Get total count
        count_query = f"SELECT COUNT(*) FROM users {where_clause}"
        if params:
            total = await Database.fetchval(count_query, *params)
        else:
            total = await Database.fetchval(count_query)
        
        # Calculate offset
        offset = (page - 1) * page_size
        
        # Build pagination parameters
        limit_param = param_count + 1
        offset_param = param_count + 2
        
        # Get users with pagination
        query = f"""
            SELECT id, email, name, type, status, email_verified, avatar, created_at, updated_at
            FROM users
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ${limit_param} OFFSET ${offset_param}
        """
        pagination_params = list(params) + [page_size, offset]
        
        users_data = await Database.fetch(query, *pagination_params)
        
        users = [
            UserResponse(
                id=str(u['id']),
                email=u['email'],
                name=u['name'],
                type=u['type'],
                status=u['status'],
                email_verified=u['email_verified'],
                avatar=u['avatar'],
                created_at=u['created_at'],
                updated_at=u['updated_at']
            )
            for u in users_data
        ]
        
        logger.info(f"Admin {admin_id} fetched {len(users)} users (page {page}, total: {total})")
        
        return UserListResponse(
            users=users,
            total=total
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching users: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch users: {str(e)}"
        )
