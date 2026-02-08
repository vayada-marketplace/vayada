"""
Authentication-related Pydantic models
"""
from pydantic import BaseModel, EmailStr, Field
from typing import Optional


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, description="Password must be at least 8 characters")
    name: Optional[str] = Field(None, description="User's name (optional, defaults to email prefix)")
    # GDPR consent fields
    terms_accepted: bool = Field(..., description="Must accept Terms of Service")
    privacy_accepted: bool = Field(..., description="Must accept Privacy Policy")
    marketing_consent: bool = Field(default=False, description="Optional marketing consent")
    terms_version: Optional[str] = Field(default=None, description="Version of Terms accepted")
    privacy_version: Optional[str] = Field(default=None, description="Version of Privacy Policy accepted")


class RegisterResponse(BaseModel):
    id: str
    email: str
    name: str
    type: str
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    message: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    id: str
    email: str
    name: str
    type: str
    status: str
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    message: str


class TokenValidationResponse(BaseModel):
    valid: bool
    expired: bool
    user_id: Optional[str] = None
    email: Optional[str] = None
    type: Optional[str] = None


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    message: str
    token: Optional[str] = None  # Only returned in DEBUG mode when email fails


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8)


class ResetPasswordResponse(BaseModel):
    message: str
