"""
Pydantic models for request/response validation
"""
from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Literal
from datetime import datetime
import uuid


class RegisterRequest(BaseModel):
    """Registration request model"""
    email: EmailStr
    password: str = Field(..., min_length=8, description="Password must be at least 8 characters")
    type: Literal["hotel", "creator"] = Field(..., description="User type: hotel or creator")
    name: Optional[str] = None  # Will default to email if not provided


class UserResponse(BaseModel):
    """User response model"""
    id: uuid.UUID
    email: str
    name: str
    type: str
    status: str
    avatar: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class RegisterResponse(BaseModel):
    """Registration response model"""
    message: str
    user: UserResponse

