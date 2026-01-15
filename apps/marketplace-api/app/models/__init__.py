"""
Pydantic models for the Vayada Creator Marketplace API

This module re-exports all models for convenient importing:
    from app.models import RegisterRequest, LoginResponse, etc.

Or import from specific modules:
    from app.models.auth import RegisterRequest, LoginResponse
    from app.models.creators import CreatorProfileResponse
"""

# Common/shared models
from app.models.common import (
    TopCountry,
    TopAgeGroup,
    GenderSplit,
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
    PlatformResponse,
)

# Auth models
from app.models.auth import (
    RegisterRequest,
    RegisterResponse,
    LoginRequest,
    LoginResponse,
    TokenValidationResponse,
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    ResetPasswordRequest,
    ResetPasswordResponse,
    SendVerificationCodeRequest,
    SendVerificationCodeResponse,
    VerifyEmailCodeRequest,
    VerifyEmailCodeResponse,
    VerifyEmailResponse,
)

# Creator models
from app.models.creators import (
    CreatorProfileStatusResponse,
    PlatformRequest,
    UpdateCreatorProfileRequest,
    ReviewResponse,
    RatingResponse,
    CreatorProfileFullResponse,
    CreatorProfileResponse,
    CreatorCollaborationListResponse,
    CreatorCollaborationDetailResponse,
)

# Hotel models
from app.models.hotels import (
    HotelProfileStatusHasDefaults,
    HotelProfileStatusResponse,
    UpdateHotelProfileRequest,
    HotelProfileResponse,
    CollaborationOfferingRequest,
    CreatorRequirementsRequest,
    CreateListingRequest,
    UpdateListingRequest,
    ListingResponse,
    CreatorPlatformDetail,
    CreatorReview,
    CreatorReputation,
    HotelCollaborationListResponse,
    HotelCollaborationDetailResponse,
)

# Collaboration models
from app.models.collaborations import (
    PlatformDeliverable,
    PlatformDeliverablesItem,
    CreateCollaborationRequest,
    RespondToCollaborationRequest,
    UpdateCollaborationTermsRequest,
    CancelCollaborationRequest,
    CollaborationResponse,
)

# Chat models
from app.models.chat import (
    CreateChatMessageRequest,
    ChatMessageResponse,
    ConversationResponse,
)

# Upload models
from app.models.upload import (
    ImageUploadResponse,
    MultipleImageUploadResponse,
)

# Marketplace models
from app.models.marketplace import (
    ListingMarketplaceResponse,
    PlatformMarketplaceResponse,
    CreatorMarketplaceResponse,
)

# Admin models
from app.models.admin import (
    UserResponse,
    UserListResponse,
    CollaborationListResponse,
    AdminPlatformRequest,
    CreateCreatorProfileRequest,
    CreateHotelProfileRequest,
    CreateUserRequest,
    UpdateUserRequest,
    AdminPlatformResponse,
    CreatorProfileDetail,
    AdminCollaborationOfferingResponse,
    AdminCreatorRequirementsResponse,
    AdminListingResponse,
    HotelProfileDetail,
    UserDetailResponse,
)

__all__ = [
    # Common
    "TopCountry",
    "TopAgeGroup",
    "GenderSplit",
    "CollaborationOfferingResponse",
    "CreatorRequirementsResponse",
    "PlatformResponse",
    # Auth
    "RegisterRequest",
    "RegisterResponse",
    "LoginRequest",
    "LoginResponse",
    "TokenValidationResponse",
    "ForgotPasswordRequest",
    "ForgotPasswordResponse",
    "ResetPasswordRequest",
    "ResetPasswordResponse",
    "SendVerificationCodeRequest",
    "SendVerificationCodeResponse",
    "VerifyEmailCodeRequest",
    "VerifyEmailCodeResponse",
    "VerifyEmailResponse",
    # Creator
    "CreatorProfileStatusResponse",
    "PlatformRequest",
    "UpdateCreatorProfileRequest",
    "ReviewResponse",
    "RatingResponse",
    "CreatorProfileFullResponse",
    "CreatorProfileResponse",
    "CreatorCollaborationListResponse",
    "CreatorCollaborationDetailResponse",
    # Hotel
    "HotelProfileStatusHasDefaults",
    "HotelProfileStatusResponse",
    "UpdateHotelProfileRequest",
    "HotelProfileResponse",
    "CollaborationOfferingRequest",
    "CreatorRequirementsRequest",
    "CreateListingRequest",
    "UpdateListingRequest",
    "ListingResponse",
    "CreatorPlatformDetail",
    "CreatorReview",
    "CreatorReputation",
    "HotelCollaborationListResponse",
    "HotelCollaborationDetailResponse",
    # Collaboration
    "PlatformDeliverable",
    "PlatformDeliverablesItem",
    "CreateCollaborationRequest",
    "RespondToCollaborationRequest",
    "UpdateCollaborationTermsRequest",
    "CancelCollaborationRequest",
    "CollaborationResponse",
    # Chat
    "CreateChatMessageRequest",
    "ChatMessageResponse",
    "ConversationResponse",
    # Upload
    "ImageUploadResponse",
    "MultipleImageUploadResponse",
    # Marketplace
    "ListingMarketplaceResponse",
    "PlatformMarketplaceResponse",
    "CreatorMarketplaceResponse",
    # Admin
    "UserResponse",
    "UserListResponse",
    "CollaborationListResponse",
    "AdminPlatformRequest",
    "CreateCreatorProfileRequest",
    "CreateHotelProfileRequest",
    "CreateUserRequest",
    "UpdateUserRequest",
    "AdminPlatformResponse",
    "CreatorProfileDetail",
    "AdminCollaborationOfferingResponse",
    "AdminCreatorRequirementsResponse",
    "AdminListingResponse",
    "HotelProfileDetail",
    "UserDetailResponse",
]
