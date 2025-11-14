"""
Authentication routes
"""
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from typing import Literal
import bcrypt
from app.database import Database

router = APIRouter(prefix="/auth", tags=["authentication"])


class RegisterRequest(BaseModel):
    """Registration request model"""
    email: EmailStr
    password: str = Field(..., min_length=8, description="Password must be at least 8 characters")
    type: Literal["creator", "hotel"]
    name: str | None = Field(None, description="User's name (optional, defaults to email prefix)")


class RegisterResponse(BaseModel):
    """Registration response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    message: str


class LoginRequest(BaseModel):
    """Login request model"""
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    """Login response model"""
    id: str
    email: str
    name: str
    type: str
    status: str
    message: str


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest):
    """
    Register a new user (creator or hotel)
    
    - **email**: User's email address (must be unique)
    - **password**: Password (minimum 8 characters)
    - **type**: User type - either "creator" or "hotel"
    - **name**: User's name
    """
    try:
        # Check if email already exists
        existing_user = await Database.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            request.email
        )
        
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        
        # Hash password
        password_hash = bcrypt.hashpw(
            request.password.encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')
        
        # Use provided name or default to email prefix
        user_name = request.name
        if not user_name or user_name.strip() == "":
            # Extract name from email (part before @)
            user_name = request.email.split('@')[0].capitalize()
        
        # Insert user into database
        user = await Database.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status)
            VALUES ($1, $2, $3, $4, 'pending')
            RETURNING id, email, name, type, status
            """,
            request.email,
            password_hash,
            user_name,
            request.type
        )
        
        return RegisterResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            message="User registered successfully"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Registration failed: {str(e)}"
        )


@router.post("/login", response_model=LoginResponse, status_code=status.HTTP_200_OK)
async def login(request: LoginRequest):
    """
    Login with email and password
    
    - **email**: User's email address
    - **password**: User's password
    """
    try:
        # Find user by email
        user = await Database.fetchrow(
            "SELECT id, email, password_hash, name, type, status FROM users WHERE email = $1",
            request.email
        )
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password"
            )
        
        # Verify password
        password_valid = bcrypt.checkpw(
            request.password.encode('utf-8'),
            user['password_hash'].encode('utf-8')
        )
        
        if not password_valid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password"
            )
        
        # Check if user account is suspended
        if user['status'] == 'suspended':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account is suspended"
            )
        
        return LoginResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            message="Login successful"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Login failed: {str(e)}"
        )
