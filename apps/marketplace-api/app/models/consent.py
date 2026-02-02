"""
GDPR Consent-related Pydantic models
"""
from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime


# ============================================
# COOKIE CONSENT
# ============================================

class CookieConsentRequest(BaseModel):
    """Cookie consent request model"""
    visitor_id: str = Field(..., description="Unique identifier for the visitor")
    necessary: bool = Field(default=True, description="Essential cookies (always true)")
    functional: bool = Field(default=False, description="Functional cookies")
    analytics: bool = Field(default=False, description="Analytics cookies")
    marketing: bool = Field(default=False, description="Marketing cookies")


class CookieConsentResponse(BaseModel):
    """Cookie consent response model"""
    id: str
    visitor_id: str
    user_id: Optional[str] = None
    necessary: bool
    functional: bool
    analytics: bool
    marketing: bool
    created_at: datetime
    updated_at: datetime


# ============================================
# USER CONSENT STATUS
# ============================================

class ConsentStatusResponse(BaseModel):
    """User consent status response model"""
    terms_accepted: bool
    terms_accepted_at: Optional[datetime] = None
    terms_version: Optional[str] = None
    privacy_accepted: bool
    privacy_accepted_at: Optional[datetime] = None
    privacy_version: Optional[str] = None
    marketing_consent: bool
    marketing_consent_at: Optional[datetime] = None


class UpdateMarketingConsentRequest(BaseModel):
    """Update marketing consent request model"""
    marketing_consent: bool = Field(..., description="Whether user consents to marketing")


class UpdateMarketingConsentResponse(BaseModel):
    """Update marketing consent response model"""
    marketing_consent: bool
    marketing_consent_at: datetime
    message: str


# ============================================
# CONSENT HISTORY
# ============================================

class ConsentHistoryItem(BaseModel):
    """Individual consent history record"""
    id: str
    consent_type: str
    consent_given: bool
    version: Optional[str] = None
    created_at: datetime


class ConsentHistoryResponse(BaseModel):
    """Consent history response model"""
    history: list[ConsentHistoryItem]
    total: int


# ============================================
# GDPR DATA REQUESTS
# ============================================

class GdprExportRequestResponse(BaseModel):
    """GDPR data export request response"""
    id: str
    status: str
    requested_at: datetime
    expires_at: Optional[datetime] = None
    message: str


class GdprExportDownloadResponse(BaseModel):
    """GDPR data export download response"""
    download_url: str
    expires_at: datetime
    message: str


class GdprDeletionRequestResponse(BaseModel):
    """GDPR deletion request response"""
    id: str
    status: str
    requested_at: datetime
    scheduled_deletion_at: datetime
    message: str


class GdprDeletionCancelResponse(BaseModel):
    """GDPR deletion cancel response"""
    message: str
    cancelled: bool


class GdprRequestStatusResponse(BaseModel):
    """GDPR request status response"""
    id: str
    request_type: Literal["export", "deletion"]
    status: Literal["pending", "processing", "completed", "cancelled", "expired"]
    requested_at: datetime
    processed_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
