"""
Authentication-related Pydantic models
"""
from pydantic import BaseModel, EmailStr, Field
from typing import Literal, Optional


# ============================================
# REGISTRATION
# ============================================

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
    type: Literal["creator", "hotel", "admin"]
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # Token expiration time in seconds
    message: str


# ============================================
# LOGIN
# ============================================

class LoginRequest(BaseModel):
    """Login request model"""
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    """Login response model"""
    id: str
    email: str
    name: str
    type: Literal["creator", "hotel", "admin"]
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # Token expiration time in seconds
    message: str


# ============================================
# TOKEN VALIDATION
# ============================================

class TokenValidationResponse(BaseModel):
    """Token validation response model"""
    valid: bool
    expired: bool
    user_id: str | None = None
    email: str | None = None
    type: str | None = None


# ============================================
# PASSWORD RESET
# ============================================

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


# ============================================
# EMAIL VERIFICATION (Code-based)
# ============================================

class SendVerificationCodeRequest(BaseModel):
    """Send verification code request model"""
    email: EmailStr


class SendVerificationCodeResponse(BaseModel):
    """Send verification code response model"""
    message: str
    code: Optional[str] = None  # Only returned in DEBUG mode for testing


class VerifyEmailCodeRequest(BaseModel):
    """Verify email code request model"""
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6, description="6-digit verification code")


class VerifyEmailCodeResponse(BaseModel):
    """Verify email code response model"""
    message: str
    verified: bool


# ============================================
# EMAIL VERIFICATION (Token-based)
# ============================================

class VerifyEmailResponse(BaseModel):
    """Email verification response model"""
    message: str
    verified: bool
    email: str | None = None
