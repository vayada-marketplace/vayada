"""
User routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.database import Database
from app.dependencies import get_current_user_id

router = APIRouter(prefix="/users", tags=["users"])


class UpdateEmailRequest(BaseModel):
    email: EmailStr


class UpdateEmailResponse(BaseModel):
    id: str
    email: str
    name: str
    updated_at: str


@router.put("/me", response_model=UpdateEmailResponse, status_code=status.HTTP_200_OK)
async def update_email(
    request: UpdateEmailRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Update user email address
    
    Note: Email is stored in the users table and is available for all user types
    """
    try:
        # Check if email is already taken
        existing = await Database.fetchrow(
            "SELECT id FROM users WHERE email = $1 AND id != $2",
            request.email, user_id
        )
        
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        
        # Update email in users table
        updated_user = await Database.fetchrow(
            """
            UPDATE users
            SET email = $1, updated_at = now()
            WHERE id = $2
            RETURNING *
            """,
            request.email, user_id
        )
        
        if not updated_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        return UpdateEmailResponse(
            id=str(updated_user['id']),
            email=updated_user['email'],
            name=updated_user['name'],
            updated_at=updated_user['updated_at'].isoformat()
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update email: {str(e)}"
        )

