"""
Authentication routes for the booking engine
"""
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
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

_INVALID_TOKEN = TokenValidationResponse(valid=False, expired=False, user_id=None, email=None, type=None)


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest):
    if not request.terms_accepted:
        raise HTTPException(status_code=400, detail="You must accept the Terms of Service to register")
    if not request.privacy_accepted:
        raise HTTPException(status_code=400, detail="You must accept the Privacy Policy to register")
    if await UserRepository.exists_by_email(request.email):
        raise HTTPException(status_code=400, detail="Email already registered")

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
        message="User registered successfully",
    )


@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest):
    user = await UserRepository.get_by_email(request.email)
    if not user or not verify_password(request.password, user['password_hash']):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user['status'] == 'suspended':
        raise HTTPException(status_code=403, detail="Account is suspended")

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
        message="Login successful",
        is_superadmin=bool(user.get('is_superadmin', False)),
    )


@router.post("/validate-token", response_model=TokenValidationResponse)
async def validate_token(credentials: Optional[HTTPAuthorizationCredentials] = Depends(HTTPBearer(auto_error=False))):
    if not credentials:
        return _INVALID_TOKEN

    token = credentials.credentials
    payload = decode_access_token(token)
    if not payload:
        expired = is_token_expired(token)
        return TokenValidationResponse(valid=False, expired=bool(expired), user_id=None, email=None, type=None)

    if is_token_expired(token):
        return TokenValidationResponse(valid=False, expired=True, user_id=None, email=None, type=None)

    user_id = payload.get("sub")
    if not user_id:
        return _INVALID_TOKEN

    user = await UserRepository.get_by_id(user_id, columns="id, email, type")
    if not user:
        return _INVALID_TOKEN

    return TokenValidationResponse(
        valid=True, expired=False,
        user_id=str(user['id']), email=user['email'], type=user['type'],
    )


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
async def forgot_password(request: ForgotPasswordRequest):
    generic_msg = "If an account with that email exists, a password reset link has been sent."
    user = await UserRepository.get_by_email(request.email)

    if user and user['status'] != 'suspended':
        token = await create_password_reset_token(str(user['id']), expires_in_hours=1)
        logger.info(f"Password reset link generated for user {user['id']}")
        return ForgotPasswordResponse(
            message=generic_msg,
            token=token if settings.DEBUG else None,
        )

    return ForgotPasswordResponse(message=generic_msg, token=None)


@router.post("/reset-password", response_model=ResetPasswordResponse)
async def reset_password(request: ResetPasswordRequest):
    token_data = await validate_password_reset_token(request.token)
    if not token_data:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    password_hash = hash_password(request.new_password)
    await UserRepository.update_password(token_data['user_id'], password_hash)
    await mark_password_reset_token_as_used(request.token)
    await PasswordResetRepository.invalidate_all_for_user(token_data['user_id'])

    return ResetPasswordResponse(message="Password has been reset successfully")


@router.post("/change-password", response_model=ChangePasswordResponse)
async def change_password(
    request: ChangePasswordRequest,
    user_id: str = Depends(get_current_user_id),
):
    user = await UserRepository.get_by_id(user_id, columns="id, password_hash")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(request.current_password, user['password_hash']):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    await UserRepository.update_password(user_id, hash_password(request.new_password))
    return ChangePasswordResponse(message="Password changed successfully")


@router.post("/change-email", response_model=ChangeEmailResponse)
async def change_email(
    request: ChangeEmailRequest,
    user_id: str = Depends(get_current_user_id),
):
    user = await UserRepository.get_by_id(user_id, columns="id, email, password_hash")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(request.password, user['password_hash']):
        raise HTTPException(status_code=400, detail="Password is incorrect")
    if user['email'] == request.new_email:
        raise HTTPException(status_code=400, detail="New email is the same as the current email")
    if await UserRepository.exists_by_email(request.new_email):
        raise HTTPException(status_code=409, detail="Email is already in use")

    updated = await UserRepository.update_email(user_id, request.new_email)
    return ChangeEmailResponse(message="Email updated successfully", email=updated['email'])
