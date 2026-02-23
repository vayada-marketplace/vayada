"""
Authentication routes for the booking engine
"""
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import bcrypt
import logging

from app.jwt_utils import create_access_token, get_token_expiration_seconds, decode_access_token, is_token_expired
from app.auth import hash_password, verify_password, create_password_reset_token, validate_password_reset_token, mark_password_reset_token_as_used
from app.config import settings
from app.dependencies import get_current_user_id
from app.repositories.user_repo import UserRepository
from app.repositories.password_reset_repo import PasswordResetRepository
from app.repositories.consent_repo import ConsentRepository
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
    ChangePasswordRequest,
    ChangePasswordResponse,
    ChangeEmailRequest,
    ChangeEmailResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest):
    """
    Register a new hotel user.

    Hotel owners can register directly on the booking engine.
    The account is created in the shared auth database, so the same
    credentials will work on the marketplace too.
    """
    try:
        if not request.terms_accepted:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You must accept the Terms of Service to register"
            )

        if not request.privacy_accepted:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You must accept the Privacy Policy to register"
            )

        if await UserRepository.exists_by_email(request.email):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )

        password_hash = hash_password(request.password)

        user_name = request.name
        if not user_name or user_name.strip() == "":
            user_name = request.email.split('@')[0].capitalize()

        terms_version = request.terms_version or "2024-01-01"
        privacy_version = request.privacy_version or "2024-01-01"

        user = await UserRepository.create(
            email=request.email,
            password_hash=password_hash,
            name=user_name,
            terms_version=terms_version,
            privacy_version=privacy_version,
            marketing_consent=request.marketing_consent,
        )

        # Create consent history records for GDPR audit trail
        await ConsentRepository.record(user['id'], 'terms', True, version=terms_version)
        await ConsentRepository.record(user['id'], 'privacy', True, version=privacy_version)

        if request.marketing_consent:
            await ConsentRepository.record(user['id'], 'marketing', True)

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
    Login with email and password.

    Works for any user registered in the shared auth database,
    regardless of which service they originally registered on.
    """
    try:
        user = await UserRepository.get_by_email(request.email)

        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password"
            )

        password_valid = bcrypt.checkpw(
            request.password.encode('utf-8'),
            user['password_hash'].encode('utf-8')
        )

        if not password_valid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password"
            )

        if user['status'] == 'suspended':
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account is suspended"
            )

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
    Validate if the current token is still valid.

    Returns token validation status and user information.
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

    payload = decode_access_token(token)
    if not payload:
        is_exp = is_token_expired(token)
        return TokenValidationResponse(
            valid=False,
            expired=is_exp if is_exp is not None else False,
            user_id=None,
            email=None,
            type=None
        )

    is_exp = is_token_expired(token)
    if is_exp is True:
        return TokenValidationResponse(
            valid=False,
            expired=True,
            user_id=None,
            email=None,
            type=None
        )

    user_id = payload.get("sub")
    if not user_id:
        return TokenValidationResponse(
            valid=False,
            expired=False,
            user_id=None,
            email=None,
            type=None
        )

    user = await UserRepository.get_by_id(user_id, columns="id, email, type")

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
    Request a password reset.

    Generates a secure reset token and returns a success message.
    In DEBUG mode, the token is returned in the response for testing.
    Always returns success (security: don't reveal if email exists).
    """
    try:
        user = await UserRepository.get_by_email(request.email)

        if user and user['status'] != 'suspended':
            token = await create_password_reset_token(str(user['id']), expires_in_hours=1)

            reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"
            logger.info(f"Password reset link generated for user {user['id']}")

            # In DEBUG mode, return token directly (no email service needed for dev)
            return_token = token if settings.DEBUG else None

            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=return_token
            )
        else:
            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=None
            )

    except Exception as e:
        logger.error(f"Error in forgot-password: {e}")
        return ForgotPasswordResponse(
            message="If an account with that email exists, a password reset link has been sent.",
            token=None
        )


@router.post("/reset-password", response_model=ResetPasswordResponse, status_code=status.HTTP_200_OK)
async def reset_password(request: ResetPasswordRequest):
    """
    Reset password using a reset token.

    Validates the token, updates the password, and invalidates all
    existing reset tokens for the user.
    """
    try:
        token_data = await validate_password_reset_token(request.token)

        if not token_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired reset token"
            )

        user_id = token_data['user_id']

        password_hash = hash_password(request.new_password)

        await UserRepository.update_password(user_id, password_hash)
        await mark_password_reset_token_as_used(request.token)

        # Invalidate all other tokens for this user
        await PasswordResetRepository.invalidate_all_for_user(user_id)

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


@router.post("/change-password", response_model=ChangePasswordResponse, status_code=status.HTTP_200_OK)
async def change_password(
    request: ChangePasswordRequest,
    user_id: str = Depends(get_current_user_id),
):
    """
    Change the current user's password.

    Requires the current password for verification and a new password.
    """
    try:
        user = await UserRepository.get_by_id(user_id, columns="id, password_hash")

        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if not verify_password(request.current_password, user['password_hash']):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password is incorrect"
            )

        new_hash = hash_password(request.new_password)
        await UserRepository.update_password(user_id, new_hash)

        return ChangePasswordResponse(message="Password changed successfully")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error changing password: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to change password"
        )


@router.post("/change-email", response_model=ChangeEmailResponse, status_code=status.HTTP_200_OK)
async def change_email(
    request: ChangeEmailRequest,
    user_id: str = Depends(get_current_user_id),
):
    """
    Change the current user's email address.

    Requires the current password for verification.
    The new email must not already be in use.
    """
    try:
        user = await UserRepository.get_by_id(user_id, columns="id, email, password_hash")

        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        if not verify_password(request.password, user['password_hash']):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Password is incorrect"
            )

        if user['email'] == request.new_email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="New email is the same as the current email"
            )

        if await UserRepository.exists_by_email(request.new_email):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email is already in use"
            )

        updated = await UserRepository.update_email(user_id, request.new_email)

        return ChangeEmailResponse(
            message="Email updated successfully",
            email=updated['email'],
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error changing email: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to change email"
        )
