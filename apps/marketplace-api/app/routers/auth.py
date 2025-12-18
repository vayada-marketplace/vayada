"""
Authentication routes
"""
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, EmailStr, Field
from typing import Literal
import bcrypt
import logging

logger = logging.getLogger(__name__)
from app.database import Database
from app.jwt_utils import create_access_token, get_token_expiration_seconds, decode_access_token, is_token_expired
from app.auth import create_password_reset_token, validate_password_reset_token, mark_password_reset_token_as_used, hash_password
from app.email_service import send_email, create_password_reset_email_html
from app.config import settings
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional

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
    type: Literal["creator", "hotel"]
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # Token expiration time in seconds
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
    type: Literal["creator", "hotel"]
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # Token expiration time in seconds
    message: str


class TokenValidationResponse(BaseModel):
    """Token validation response model"""
    valid: bool
    expired: bool
    user_id: str | None = None
    email: str | None = None
    type: str | None = None


class ForgotPasswordRequest(BaseModel):
    """Forgot password request model"""
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    """Forgot password response model"""
    message: str
    # Note: In production, token should not be returned. 
    # This is for development/testing purposes only.
    # In production, send the token via email instead.
    token: str | None = None  # Only returned in development mode


class ResetPasswordRequest(BaseModel):
    """Reset password request model"""
    token: str
    new_password: str = Field(..., min_length=8, description="New password must be at least 8 characters")


class ResetPasswordResponse(BaseModel):
    """Reset password response model"""
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
        
        # Automatically create corresponding profile based on user type
        if request.type == "creator":
            # Create empty creator profile (location and short_description will be filled later)
            await Database.execute(
                """
                INSERT INTO creators (user_id, location, short_description)
                VALUES ($1, NULL, NULL)
                """,
                user['id']
            )
        elif request.type == "hotel":
            # Create minimal hotel profile (name, location will be filled/updated later)
            # Using defaults: name from user, location='Not specified'
            # Note: email is stored in users table only (like creators)
            # Note: category is removed - accommodation_type exists at listing level only
            await Database.execute(
                """
                INSERT INTO hotel_profiles (user_id, name, location)
                VALUES ($1, $2, 'Not specified')
                """,
                user['id'],
                user['name']
            )
        
        # Create JWT token
        access_token = create_access_token(
            data={"sub": str(user['id']), "email": user['email'], "type": user['type']}
        )
        
        return RegisterResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            access_token=access_token,
            expires_in=get_token_expiration_seconds(),
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
        
        # Create JWT token
        access_token = create_access_token(
            data={"sub": str(user['id']), "email": user['email'], "type": user['type']}
        )
        
        return LoginResponse(
            id=str(user['id']),
            email=user['email'],
            name=user['name'],
            type=user['type'],
            status=user['status'],
            access_token=access_token,
            expires_in=get_token_expiration_seconds(),
            message="Login successful"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Login failed: {str(e)}"
        )


@router.post("/validate-token", response_model=TokenValidationResponse, status_code=status.HTTP_200_OK)
async def validate_token(credentials: Optional[HTTPAuthorizationCredentials] = Depends(HTTPBearer(auto_error=False))):
    """
    Validate if the current token is still valid
    
    This endpoint can be used by the frontend to check if the token is still valid
    before making API calls, or to refresh user information.
    
    Returns token validation status and user information.
    
    Note: This endpoint is optional - if no token is provided, returns valid=False
    """
    if not credentials:
        return TokenValidationResponse(
            valid=False,
            expired=False,
            user_id=None,
            email=None,
            type=None
        )
    
    token = credentials.credentials
    
    # Check if token is expired
    if is_token_expired(token):
        return TokenValidationResponse(
            valid=False,
            expired=True,
            user_id=None,
            email=None,
            type=None
        )
    
    # Decode token
    payload = decode_access_token(token)
    if not payload:
        return TokenValidationResponse(
            valid=False,
            expired=False,
            user_id=None,
            email=None,
            type=None
        )
    
    # Get user info
    user_id = payload.get("sub")
    if not user_id:
        return TokenValidationResponse(
            valid=False,
            expired=False,
            user_id=None,
            email=None,
            type=None
        )
    
    user = await Database.fetchrow(
        "SELECT id, email, type FROM users WHERE id = $1",
        user_id
    )
    
    if not user:
        return TokenValidationResponse(
            valid=False,
            expired=False,
            user_id=None,
            email=None,
            type=None
        )
    
    return TokenValidationResponse(
        valid=True,
        expired=False,
        user_id=str(user['id']),
        email=user['email'],
        type=user['type']
    )


@router.post("/forgot-password", response_model=ForgotPasswordResponse, status_code=status.HTTP_200_OK)
async def forgot_password(request: ForgotPasswordRequest):
    """
    Request a password reset
    
    - **email**: User's email address
    
    This endpoint will:
    1. Check if the email exists
    2. Generate a secure reset token
    3. Store the token in the database (expires in 1 hour)
    4. Return a success message
    
    Note: In production, the reset token should be sent via email.
    For development/testing, the token is returned in the response.
    """
    try:
        # Find user by email
        user = await Database.fetchrow(
            "SELECT id, email, name, status FROM users WHERE email = $1",
            request.email
        )
        
        # Always return success message (security best practice - don't reveal if email exists)
        # But only create token if user exists and is not suspended
        if user and user['status'] != 'suspended':
            # Create password reset token (expires in 1 hour)
            token = await create_password_reset_token(str(user['id']), expires_in_hours=1)
            
            # Create reset link
            reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"
            
            # Get user name for email personalization
            user_name = user.get('name') or user['email'].split('@')[0]
            
            # Create email content
            html_body = create_password_reset_email_html(reset_link, user_name)
            
            # Send email
            email_sent = await send_email(
                to_email=user['email'],
                subject="Reset Your Vayada Password",
                html_body=html_body
            )
            
            # In development mode, return token for testing if email failed
            # In production, always return None for token
            return_token = None
            if settings.DEBUG and not email_sent:
                # If email sending failed in debug mode, return token for testing
                return_token = token
                logger.warning(f"Email sending failed in debug mode. Returning token in response.")
            
            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=return_token
            )
        else:
            # Still return success (security best practice)
            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=None
            )
            
    except Exception as e:
        # Still return success message (security best practice)
        return ForgotPasswordResponse(
            message="If an account with that email exists, a password reset link has been sent.",
            token=None
        )


@router.post("/reset-password", response_model=ResetPasswordResponse, status_code=status.HTTP_200_OK)
async def reset_password(request: ResetPasswordRequest):
    """
    Reset password using a reset token
    
    - **token**: Password reset token (from forgot-password endpoint)
    - **new_password**: New password (minimum 8 characters)
    
    This endpoint will:
    1. Validate the reset token
    2. Check if token is expired or already used
    3. Update the user's password
    4. Mark the token as used
    """
    try:
        # Validate the reset token
        token_data = await validate_password_reset_token(request.token)
        
        if not token_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired reset token"
            )
        
        user_id = token_data['user_id']
        
        # Hash the new password
        password_hash = hash_password(request.new_password)
        
        # Update user's password
        await Database.execute(
            """
            UPDATE users
            SET password_hash = $1, updated_at = now()
            WHERE id = $2
            """,
            password_hash,
            user_id
        )
        
        # Mark token as used
        await mark_password_reset_token_as_used(request.token)
        
        # Optionally: Invalidate all existing tokens for this user (security best practice)
        # This prevents reuse of any other tokens that might have been generated
        await Database.execute(
            """
            UPDATE password_reset_tokens
            SET used = true
            WHERE user_id = $1 AND used = false
            """,
            user_id
        )
        
        return ResetPasswordResponse(
            message="Password has been reset successfully"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to reset password: {str(e)}"
        )
