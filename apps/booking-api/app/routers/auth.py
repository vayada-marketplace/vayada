"""
Authentication routes for the booking engine
"""
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import bcrypt
import logging

from app.database import AuthDatabase
from app.jwt_utils import create_access_token, get_token_expiration_seconds, decode_access_token, is_token_expired
from app.auth import hash_password, create_password_reset_token, validate_password_reset_token, mark_password_reset_token_as_used
from app.config import settings
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

        existing_user = await AuthDatabase.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            request.email
        )

        if existing_user:
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

        user = await AuthDatabase.fetchrow(
            """
            INSERT INTO users (
                email, password_hash, name, type, status,
                terms_accepted_at, terms_version,
                privacy_accepted_at, privacy_version,
                marketing_consent, marketing_consent_at
            )
            VALUES ($1, $2, $3, 'hotel', 'pending', now(), $4, now(), $5, $6, CASE WHEN $6 THEN now() ELSE NULL END)
            RETURNING id, email, name, type, status
            """,
            request.email,
            password_hash,
            user_name,
            terms_version,
            privacy_version,
            request.marketing_consent
        )

        # Create consent history records for GDPR audit trail
        await AuthDatabase.execute(
            """
            INSERT INTO consent_history (user_id, consent_type, consent_given, version)
            VALUES ($1, 'terms', true, $2)
            """,
            user['id'],
            terms_version
        )

        await AuthDatabase.execute(
            """
            INSERT INTO consent_history (user_id, consent_type, consent_given, version)
            VALUES ($1, 'privacy', true, $2)
            """,
            user['id'],
            privacy_version
        )

        if request.marketing_consent:
            await AuthDatabase.execute(
                """
                INSERT INTO consent_history (user_id, consent_type, consent_given)
                VALUES ($1, 'marketing', true)
                """,
                user['id']
            )

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
        user = await AuthDatabase.fetchrow(
            "SELECT id, email, password_hash, name, type, status FROM users WHERE email = $1",
            request.email
        )

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

    user = await AuthDatabase.fetchrow(
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
    Request a password reset.

    Generates a secure reset token and returns a success message.
    In DEBUG mode, the token is returned in the response for testing.
    Always returns success (security: don't reveal if email exists).
    """
    try:
        user = await AuthDatabase.fetchrow(
            "SELECT id, email, name, status FROM users WHERE email = $1",
            request.email
        )

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

        await AuthDatabase.execute(
            """
            UPDATE users
            SET password_hash = $1, updated_at = now()
            WHERE id = $2
            """,
            password_hash,
            user_id
        )

        await mark_password_reset_token_as_used(request.token)

        # Invalidate all other tokens for this user
        await AuthDatabase.execute(
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
