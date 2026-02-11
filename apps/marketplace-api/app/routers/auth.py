"""
Authentication routes
"""
from fastapi import APIRouter, HTTPException, status, Depends, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import bcrypt
import logging

from app.jwt_utils import create_access_token, get_token_expiration_seconds, decode_access_token, is_token_expired
from app.auth import (
    create_password_reset_token, validate_password_reset_token, mark_password_reset_token_as_used,
    hash_password, create_email_verification_code, verify_email_code, mark_email_as_verified,
    validate_email_verification_token, mark_email_verification_token_as_used
)
from app.email_service import send_email, create_password_reset_email_html, create_email_verification_html
from app.config import settings
from app.repositories.user_repo import UserRepository
from app.repositories.password_reset_repo import PasswordResetRepository
from app.repositories.consent_repo import ConsentRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post("/send-verification-code", response_model=SendVerificationCodeResponse, status_code=status.HTTP_200_OK)
async def send_verification_code(request: SendVerificationCodeRequest):
    """
    Send a 6-digit verification code to the user's email address.
    This is used during registration to verify the email address.

    The code expires in 15 minutes and can only be used once.
    """
    try:
        # Check if email is already registered
        if await UserRepository.exists_by_email(request.email):
            # Don't reveal if email exists for security
            return SendVerificationCodeResponse(
                message="If this email is not registered, a verification code has been sent.",
                code=None
            )

        # Generate and store verification code
        code = await create_email_verification_code(request.email, expires_in_minutes=15)

        # Create email content
        html_body = create_email_verification_html(code, None)

        # Send email
        email_sent = await send_email(
            to_email=request.email,
            subject="Verify Your Email - Vayada",
            html_body=html_body
        )

        if not email_sent and settings.DEBUG:
            # In debug mode, return code if email fails
            return SendVerificationCodeResponse(
                message="Verification code sent. (Email failed, code returned for debug)",
                code=code
            )
        elif not email_sent:
            # In production, return generic message
            return SendVerificationCodeResponse(
                message="If this email is not registered, a verification code has been sent.",
                code=None
            )
        else:
            return SendVerificationCodeResponse(
                message="Verification code sent to your email.",
                code=code if settings.DEBUG else None
            )

    except Exception as e:
        logger.error(f"Error sending verification code: {e}")
        # Return generic message for security
        return SendVerificationCodeResponse(
            message="If this email is not registered, a verification code has been sent.",
            code=None
        )


@router.post("/verify-email-code", response_model=VerifyEmailCodeResponse, status_code=status.HTTP_200_OK)
async def verify_email_code_endpoint(request: VerifyEmailCodeRequest):
    """
    Verify a 6-digit code sent to the user's email.
    This marks the email as verified for future registration.
    """
    try:
        # Verify the code
        is_valid = await verify_email_code(request.email, request.code)

        if is_valid:
            # Mark email as verified (if user exists, update their status)
            await mark_email_as_verified(request.email)

            logger.info(f"Email verification successful for: {request.email}")
            return VerifyEmailCodeResponse(
                message="Email verified successfully!",
                verified=True
            )
        else:
            logger.warning(f"Email verification failed for: {request.email} with code: {request.code}")
            return VerifyEmailCodeResponse(
                message="Invalid or expired verification code. Please request a new code.",
                verified=False
            )

    except Exception as e:
        logger.error(f"Error verifying email code for {request.email}: {e}", exc_info=True)
        return VerifyEmailCodeResponse(
            message="An error occurred while verifying the code. Please try again.",
            verified=False
        )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest):
    """
    Register a new user (creator or hotel)

    - **email**: User's email address (must be unique)
    - **password**: Password (minimum 8 characters)
    - **type**: User type - either "creator" or "hotel"
    - **name**: User's name
    - **terms_accepted**: Must be True (required for GDPR)
    - **privacy_accepted**: Must be True (required for GDPR)
    - **marketing_consent**: Optional marketing consent
    """
    try:
        # Validate GDPR consent requirements
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

        # Check if email already exists
        if await UserRepository.exists_by_email(request.email):
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

        # Default versions if not provided
        terms_version = request.terms_version or "2024-01-01"
        privacy_version = request.privacy_version or "2024-01-01"

        # Insert user into auth database with consent fields
        user = await UserRepository.create(
            email=request.email,
            password_hash=password_hash,
            name=user_name,
            user_type=request.type,
            terms_version=terms_version,
            privacy_version=privacy_version,
            marketing_consent=request.marketing_consent,
        )

        # Create profile in business DB + consent history in auth DB
        # Uses compensating action: if profile creation fails, delete user from auth DB
        try:
            # Automatically create corresponding profile based on user type
            if request.type == "creator":
                await CreatorRepository.create(user['id'])
            elif request.type == "hotel":
                await HotelRepository.create_profile(user['id'], user['name'])

            # Create consent history records for GDPR audit trail
            await ConsentRepository.record(user['id'], 'terms', True, version=terms_version)
            await ConsentRepository.record(user['id'], 'privacy', True, version=privacy_version)

            if request.marketing_consent:
                await ConsentRepository.record(user['id'], 'marketing', True)
        except Exception:
            # Compensating action: clean up user from auth DB if profile creation failed
            await UserRepository.delete(user['id'])
            raise

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
        user = await UserRepository.get_by_email(request.email)

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

    # Decode token first to check if it's valid
    payload = decode_access_token(token)
    if not payload:
        # Invalid token - check if it's expired or just malformed
        is_exp = is_token_expired(token)
        # If is_exp is None, token is invalid (not a valid JWT format)
        # If is_exp is True, token is expired
        # If is_exp is False, token is valid but signature is wrong
        return TokenValidationResponse(
            valid=False,
            expired=is_exp if is_exp is not None else False,  # False if invalid format, True if expired
            user_id=None,
            email=None,
            type=None
        )

    # Check if token is expired (only if payload exists)
    is_exp = is_token_expired(token)
    if is_exp is True:
        return TokenValidationResponse(
            valid=False,
            expired=True,
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
        user = await UserRepository.get_by_email(request.email)

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
        await UserRepository.update_password(user_id, password_hash)

        # Mark token as used
        await mark_password_reset_token_as_used(request.token)

        # Invalidate all existing tokens for this user (security best practice)
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


@router.get("/verify-email", response_model=VerifyEmailResponse, status_code=status.HTTP_200_OK)
async def verify_email_endpoint(token: str = Query(..., description="Email verification token")):
    """
    Verify email address using a verification token from the profile completion email.

    This endpoint is called when a user clicks the verification link in their email.
    The token is provided as a query parameter.

    - **token**: Email verification token from the profile completion email

    Returns:
    - Success message if verification is successful
    - Error message if token is invalid, expired, or already used
    """
    try:
        # Validate the verification token
        token_data = await validate_email_verification_token(token)

        if not token_data:
            logger.warning(f"Invalid or expired email verification token attempted")
            return VerifyEmailResponse(
                message="Invalid or expired verification token. Please request a new verification link.",
                verified=False,
                email=None
            )

        user_id = token_data['user_id']
        email = token_data['email']

        # Mark email as verified
        email_verified = await mark_email_as_verified(email)

        if not email_verified:
            logger.error(f"Failed to mark email as verified for user {user_id}")
            return VerifyEmailResponse(
                message="Failed to verify email. Please try again or contact support.",
                verified=False,
                email=email
            )

        # Mark token as used
        await mark_email_verification_token_as_used(token)

        logger.info(f"Email verified successfully for user {user_id} ({email})")
        return VerifyEmailResponse(
            message="Email verified successfully! Your account is now fully activated.",
            verified=True,
            email=email
        )

    except Exception as e:
        logger.error(f"Error verifying email with token: {str(e)}", exc_info=True)
        return VerifyEmailResponse(
            message="An error occurred while verifying your email. Please try again or contact support.",
            verified=False,
            email=None
        )
