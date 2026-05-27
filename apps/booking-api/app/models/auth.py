"""
Authentication-related Pydantic models
"""

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, description="Password must be at least 8 characters")
    name: str | None = Field(None, description="User's name (optional, defaults to email prefix)")
    # GDPR consent fields
    terms_accepted: bool = Field(..., description="Must accept Terms of Service")
    privacy_accepted: bool = Field(..., description="Must accept Privacy Policy")
    marketing_consent: bool = Field(default=False, description="Optional marketing consent")
    terms_version: str | None = Field(default=None, description="Version of Terms accepted")
    privacy_version: str | None = Field(
        default=None, description="Version of Privacy Policy accepted"
    )


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
    """When requires_totp=True, only message/requires_totp/totp_session are set."""
    id: str | None = None
    email: str | None = None
    name: str | None = None
    type: str | None = None
    status: str | None = None
    access_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    message: str
    requires_totp: bool = False
    totp_session: str | None = None


class TokenValidationResponse(BaseModel):
    valid: bool
    expired: bool
    user_id: str | None = None
    email: str | None = None
    type: str | None = None


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    message: str
    token: str | None = None  # Only returned in DEBUG mode when email fails


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8)


class ResetPasswordResponse(BaseModel):
    message: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(
        ..., min_length=8, description="New password must be at least 8 characters"
    )


class ChangePasswordResponse(BaseModel):
    message: str


class ChangeEmailRequest(BaseModel):
    new_email: EmailStr
    password: str = Field(..., description="Current password for verification")


class ChangeEmailResponse(BaseModel):
    message: str
    email: str | None = None


class VerifyEmailChangeRequest(BaseModel):
    token: str


class VerifyEmailChangeResponse(BaseModel):
    message: str
    email: str


# ============================================
# TOTP / 2FA
# ============================================


class TotpVerifyRequest(BaseModel):
    totp_session: str
    code: str = Field(..., description="6-digit TOTP code or recovery code (XXXXXX-XXXXXX)")


class TotpSetupResponse(BaseModel):
    otpauth_uri: str
    secret: str
    message: str


class TotpConfirmRequest(BaseModel):
    code: str = Field(..., min_length=6, description="6-digit TOTP code from the authenticator app")


class TotpConfirmResponse(BaseModel):
    recovery_codes: list[str]
    message: str


class TotpRegenerateRequest(BaseModel):
    code: str = Field(..., min_length=6, description="Current TOTP code to authorize regeneration")


class TotpRegenerateResponse(BaseModel):
    recovery_codes: list[str]
    message: str


class TotpRecoveryCodeCountResponse(BaseModel):
    count: int


class TotpStatusResponse(BaseModel):
    enrolled: bool


class LoginHistoryEntry(BaseModel):
    id: str
    success: bool
    auth_method: str | None
    failure_reason: str | None
    ip_address: str | None
    user_agent: str | None
    created_at: str


class LoginHistoryResponse(BaseModel):
    entries: list[LoginHistoryEntry]
