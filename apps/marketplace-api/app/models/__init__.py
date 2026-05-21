"""
Pydantic models for the vayada Creator Marketplace API

This module re-exports all models for convenient importing:
    from app.models import RegisterRequest, LoginResponse, etc.

Or import from specific modules:
    from app.models.auth import RegisterRequest, LoginResponse
    from app.models.creators import CreatorProfileResponse
"""

# Common/shared models
# Admin models
from app.models.admin import (
    AdminCollaborationOfferingResponse,
    AdminCreatorRequirementsResponse,
    AdminListingResponse,
    AdminPlatformRequest,
    AdminPlatformResponse,
    CollaborationListResponse,
    CreateCreatorProfileRequest,
    CreateHotelProfileRequest,
    CreateUserRequest,
    CreatorProfileDetail,
    HotelProfileDetail,
    UpdateUserRequest,
    UserDetailResponse,
    UserListResponse,
    UserResponse,
)

# Auth models
from app.models.auth import (
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
    ResetPasswordResponse,
    SendVerificationCodeRequest,
    SendVerificationCodeResponse,
    TokenValidationResponse,
    VerifyEmailCodeRequest,
    VerifyEmailCodeResponse,
    VerifyEmailResponse,
)

# Chat models
from app.models.chat import (
    ChatMessageResponse,
    ConversationResponse,
    CreateChatMessageRequest,
)

# Collaboration models
from app.models.collaborations import (
    CancelCollaborationRequest,
    CollaborationResponse,
    CreateCollaborationRequest,
    PlatformDeliverable,
    PlatformDeliverablesItem,
    RespondToCollaborationRequest,
    UpdateCollaborationTermsRequest,
)
from app.models.common import (
    CollaborationOfferingResponse,
    CreatorRequirementsResponse,
    GenderSplit,
    PlatformResponse,
    TopAgeGroup,
    TopCountry,
)

# Creator models
from app.models.creators import (
    CreatorCollaborationDetailResponse,
    CreatorCollaborationListResponse,
    CreatorProfileFullResponse,
    CreatorProfileResponse,
    CreatorProfileStatusResponse,
    PlatformRequest,
    RatingResponse,
    ReviewResponse,
    UpdateCreatorProfileRequest,
)

# Hotel models
from app.models.hotels import (
    CollaborationOfferingRequest,
    CreateListingRequest,
    CreatorPlatformDetail,
    CreatorReputation,
    CreatorRequirementsRequest,
    CreatorReview,
    HotelCollaborationDetailResponse,
    HotelCollaborationListResponse,
    HotelProfileResponse,
    HotelProfileStatusHasDefaults,
    HotelProfileStatusResponse,
    ListingResponse,
    UpdateHotelProfileRequest,
    UpdateListingRequest,
)

# Marketplace models
from app.models.marketplace import (
    CreatorMarketplaceResponse,
    ListingMarketplaceResponse,
    PlatformMarketplaceResponse,
)

# Upload models
from app.models.upload import (
    ImageUploadResponse,
    MultipleImageUploadResponse,
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
