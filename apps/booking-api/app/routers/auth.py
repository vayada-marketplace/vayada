"""
Authentication routes for the booking engine
"""

import logging
import secrets
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth import (
    clear_auth_cookie,
    create_password_reset_token,
    hash_password,
    mark_password_reset_token_as_used,
    set_auth_cookie,
    validate_password_reset_token,
    verify_password,
)
from app.config import settings
from app.dependencies import get_current_user_id
from app.email_service import (
    create_email_change_verification_html,
    create_password_reset_html,
    create_welcome_email_html,
    send_email,
)
from app.jwt_utils import (
    create_access_token,
    create_totp_session_token,
    decode_access_token,
    decode_totp_session_token,
    get_token_expiration_seconds,
    is_token_expired,
)
from app.models.auth import (
    ChangeEmailRequest,
    ChangeEmailResponse,
    ChangePasswordRequest,
    ChangePasswordResponse,
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginHistoryResponse,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
    ResetPasswordResponse,
    TokenValidationResponse,
    TotpConfirmRequest,
    TotpConfirmResponse,
    TotpRecoveryCodeCountResponse,
    TotpRegenerateRequest,
    TotpRegenerateResponse,
    TotpSetupResponse,
    TotpStatusResponse,
    TotpVerifyRequest,
    VerifyEmailChangeRequest,
    VerifyEmailChangeResponse,
)
from app.repositories.consent_repo import ConsentRepository
from app.repositories.email_change_repo import EmailChangeRepository
from app.repositories.login_audit_repo import LoginAuditRepository, RateLimitRepository
from app.repositories.password_reset_repo import PasswordResetRepository
from app.repositories.totp_repo import TotpRepository
from app.repositories.user_repo import UserRepository
from app.totp_utils import (
    decrypt_secret,
    encrypt_secret,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_uri,
    hash_recovery_code,
    verify_recovery_code,
    verify_totp_code,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])

_INVALID_TOKEN = TokenValidationResponse(
    valid=False, expired=False, user_id=None, email=None, type=None
)


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest, response: Response):
    if not request.terms_accepted:
        raise HTTPException(
            status_code=400, detail="You must accept the Terms of Service to register"
        )
    if not request.privacy_accepted:
        raise HTTPException(
            status_code=400, detail="You must accept the Privacy Policy to register"
        )
    if await UserRepository.exists_by_email(request.email):
        raise HTTPException(status_code=400, detail="Email already registered")

    password_hash = hash_password(request.password)
    user_name = request.name
    if not user_name or user_name.strip() == "":
        user_name = request.email.split("@")[0].capitalize()

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

    await ConsentRepository.record(user["id"], "terms", True, version=terms_version)
    await ConsentRepository.record(user["id"], "privacy", True, version=privacy_version)
    if request.marketing_consent:
        await ConsentRepository.record(user["id"], "marketing", True)

    access_token = create_access_token(
        data={"sub": str(user["id"]), "email": user["email"], "type": user["type"]}
    )
    set_auth_cookie(response, access_token, get_token_expiration_seconds())

    # Send welcome/registration confirmation email
    login_link = f"{settings.FRONTEND_URL}/login"
    welcome_html = create_welcome_email_html(user_name, login_link)
    await send_email(user["email"], "Welcome to vayada!", welcome_html)

    return RegisterResponse(
        id=str(user["id"]),
        email=user["email"],
        name=user["name"],
        type=user["type"],
        status=user["status"],
        access_token=access_token,
        expires_in=get_token_expiration_seconds(),
        message="User registered successfully",
    )


@router.post("/login", response_model=LoginResponse)
async def login(http_request: Request, request: LoginRequest, response: Response):
    """Login with email and password. Admin accounts with 2FA enrolled receive a totp_session."""
    ip = http_request.client.host if http_request.client else None
    ua = http_request.headers.get("user-agent")

    lockout = await RateLimitRepository.check_locked(request.email)
    if lockout:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": "Too many failed login attempts. Try again later.",
                "locked_until": lockout["locked_until"].isoformat(),
            },
        )

    user = await UserRepository.get_by_email(request.email)

    if not user or not verify_password(request.password, user["password_hash"]):
        await RateLimitRepository.record_failure(request.email)
        await LoginAuditRepository.log(
            email=request.email,
            success=False,
            failure_reason="invalid_credentials",
            user_id=str(user["id"]) if user else None,
            ip_address=ip,
            user_agent=ua,
        )
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user["status"] == "suspended":
        await LoginAuditRepository.log(
            email=request.email,
            success=False,
            failure_reason="suspended",
            user_id=str(user["id"]),
            ip_address=ip,
            user_agent=ua,
        )
        raise HTTPException(status_code=403, detail="Account is suspended")

    await RateLimitRepository.clear(request.email)

    is_superadmin = bool(user.get("is_superadmin"))
    if (user["type"] == "hotel" or is_superadmin) and await TotpRepository.is_enrolled(
        str(user["id"])
    ):
        totp_session = create_totp_session_token(str(user["id"]), user["email"], user["type"])
        await LoginAuditRepository.log(
            email=request.email,
            success=False,
            failure_reason="totp_required",
            auth_method="password",
            user_id=str(user["id"]),
            ip_address=ip,
            user_agent=ua,
        )
        return LoginResponse(
            message="Two-factor authentication required.",
            requires_totp=True,
            totp_session=totp_session,
        )

    access_token = create_access_token(
        data={"sub": str(user["id"]), "email": user["email"], "type": user["type"]}
    )
    set_auth_cookie(response, access_token, get_token_expiration_seconds())
    await LoginAuditRepository.log(
        email=request.email,
        success=True,
        auth_method="password",
        user_id=str(user["id"]),
        ip_address=ip,
        user_agent=ua,
    )
    return LoginResponse(
        id=str(user["id"]),
        email=user["email"],
        name=user["name"],
        type=user["type"],
        status=user["status"],
        access_token=access_token,
        expires_in=get_token_expiration_seconds(),
        is_superadmin=is_superadmin,
        message="Login successful",
    )


@router.post("/totp/verify", response_model=LoginResponse, status_code=status.HTTP_200_OK)
async def totp_verify(http_request: Request, request: TotpVerifyRequest, response: Response):
    """Verify a TOTP code (or recovery code) after the password step. Issues a full JWT on success."""
    ip = http_request.client.host if http_request.client else None
    ua = http_request.headers.get("user-agent")

    payload = decode_totp_session_token(request.totp_session)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user_id = payload["sub"]
    email = payload["email"]
    user_type = payload["type"]

    lockout = await RateLimitRepository.check_locked(email)
    if lockout:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": "Too many failed attempts. Try again later.",
                "locked_until": lockout["locked_until"].isoformat(),
            },
        )

    user = await UserRepository.get_by_id(
        user_id, columns="id, email, name, type, status, is_superadmin"
    )
    if not user or user["status"] == "suspended":
        raise HTTPException(status_code=401, detail="Invalid session")

    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row or not secret_row["enrolled"]:
        raise HTTPException(status_code=400, detail="2FA not enrolled")

    code = request.code.strip()
    verified = False
    auth_method = "password+totp"

    if len(code) > 6:
        for rc in await TotpRepository.get_unused_recovery_codes(user_id):
            if verify_recovery_code(code, rc["code_hash"]):
                await TotpRepository.mark_recovery_code_used(str(rc["id"]))
                verified = True
                auth_method = "password+recovery_code"
                break
    else:
        secret = decrypt_secret(secret_row["secret_encrypted"])
        verified = verify_totp_code(secret, code)

    if not verified:
        await RateLimitRepository.record_failure(email)
        await LoginAuditRepository.log(
            email=email,
            success=False,
            failure_reason="wrong_totp",
            auth_method=auth_method,
            user_id=user_id,
            ip_address=ip,
            user_agent=ua,
        )
        raise HTTPException(status_code=401, detail="Invalid code")

    await RateLimitRepository.clear(email)
    access_token = create_access_token(data={"sub": user_id, "email": email, "type": user_type})
    set_auth_cookie(response, access_token, get_token_expiration_seconds())
    await LoginAuditRepository.log(
        email=email,
        success=True,
        auth_method=auth_method,
        user_id=user_id,
        ip_address=ip,
        user_agent=ua,
    )
    return LoginResponse(
        id=user_id,
        email=user["email"],
        name=user["name"],
        type=user["type"],
        status=user["status"],
        access_token=access_token,
        expires_in=get_token_expiration_seconds(),
        is_superadmin=bool(user.get("is_superadmin")),
        message="Login successful",
    )


@router.post("/totp/setup", response_model=TotpSetupResponse, status_code=status.HTTP_200_OK)
async def totp_setup(user_id: str = Depends(get_current_user_id)):
    """Generate a new TOTP secret and return the otpauth URI for QR display. Does not enroll yet."""
    user = await UserRepository.get_by_id(user_id, columns="id, email, type, is_superadmin")
    if not user or (user["type"] != "hotel" and not user.get("is_superadmin")):
        raise HTTPException(status_code=403, detail="Admin access required")

    secret = generate_totp_secret()
    await TotpRepository.upsert_secret(user_id, encrypt_secret(secret))

    return TotpSetupResponse(
        otpauth_uri=get_totp_uri(secret, user["email"]),
        secret=secret,
        message="Scan the QR code with your authenticator app, then confirm with a code.",
    )


@router.post("/totp/confirm", response_model=TotpConfirmResponse, status_code=status.HTTP_200_OK)
async def totp_confirm(request: TotpConfirmRequest, user_id: str = Depends(get_current_user_id)):
    """Verify the first TOTP code to complete enrollment and receive recovery codes."""
    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row:
        raise HTTPException(status_code=400, detail="Run /totp/setup first")

    secret = decrypt_secret(secret_row["secret_encrypted"])
    if not verify_totp_code(secret, request.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid code")

    await TotpRepository.mark_enrolled(user_id)
    await TotpRepository.delete_recovery_codes(user_id)

    codes = generate_recovery_codes()
    await TotpRepository.insert_recovery_codes(user_id, [hash_recovery_code(c) for c in codes])

    return TotpConfirmResponse(
        recovery_codes=codes,
        message="2FA enabled. Save these recovery codes — they will not be shown again.",
    )


@router.post(
    "/totp/recovery-codes/regenerate",
    response_model=TotpRegenerateResponse,
    status_code=status.HTTP_200_OK,
)
async def totp_regenerate_recovery_codes(
    request: TotpRegenerateRequest, user_id: str = Depends(get_current_user_id)
):
    """Regenerate recovery codes. Requires a valid TOTP code as confirmation."""
    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row or not secret_row["enrolled"]:
        raise HTTPException(status_code=400, detail="2FA not enrolled")

    secret = decrypt_secret(secret_row["secret_encrypted"])
    if not verify_totp_code(secret, request.code.strip()):
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    await TotpRepository.delete_recovery_codes(user_id)
    codes = generate_recovery_codes()
    await TotpRepository.insert_recovery_codes(user_id, [hash_recovery_code(c) for c in codes])

    return TotpRegenerateResponse(
        recovery_codes=codes,
        message="Recovery codes regenerated. Save these — they will not be shown again.",
    )


@router.get(
    "/totp/recovery-codes/count",
    response_model=TotpRecoveryCodeCountResponse,
    status_code=status.HTTP_200_OK,
)
async def totp_recovery_code_count(user_id: str = Depends(get_current_user_id)):
    """Return the number of unused recovery codes remaining."""
    count = await TotpRepository.count_unused_recovery_codes(user_id)
    return TotpRecoveryCodeCountResponse(count=count)


@router.get("/totp/status", response_model=TotpStatusResponse, status_code=status.HTTP_200_OK)
async def totp_status(user_id: str = Depends(get_current_user_id)):
    """Return whether the current user has TOTP enrolled."""
    enrolled = await TotpRepository.is_enrolled(user_id)
    return TotpStatusResponse(enrolled=enrolled)


@router.get("/login-history", response_model=LoginHistoryResponse, status_code=status.HTTP_200_OK)
async def login_history(user_id: str = Depends(get_current_user_id)):
    """Return the 20 most recent login events for the current user."""
    entries = await LoginAuditRepository.get_recent(user_id)
    return LoginHistoryResponse(
        entries=[
            {**e, "id": str(e["id"]), "created_at": e["created_at"].isoformat()} for e in entries
        ]
    )


@router.post("/logout")
async def logout(response: Response):
    """Clear the httpOnly auth cookie. Idempotent — safe to call when
    not logged in. Bearer-using clients can ignore the response and
    continue dropping their token client-side."""
    clear_auth_cookie(response)
    return {"message": "Logged out"}


@router.post("/validate-token", response_model=TokenValidationResponse)
async def validate_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
):
    if not credentials:
        return _INVALID_TOKEN

    token = credentials.credentials
    payload = decode_access_token(token)
    if not payload:
        expired = is_token_expired(token)
        return TokenValidationResponse(
            valid=False, expired=bool(expired), user_id=None, email=None, type=None
        )

    if is_token_expired(token):
        return TokenValidationResponse(
            valid=False, expired=True, user_id=None, email=None, type=None
        )

    user_id = payload.get("sub")
    if not user_id:
        return _INVALID_TOKEN

    user = await UserRepository.get_by_id(user_id, columns="id, email, type")
    if not user:
        return _INVALID_TOKEN

    return TokenValidationResponse(
        valid=True,
        expired=False,
        user_id=str(user["id"]),
        email=user["email"],
        type=user["type"],
    )


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
async def forgot_password(request: ForgotPasswordRequest):
    generic_msg = "If an account with that email exists, a password reset link has been sent."
    user = await UserRepository.get_by_email(request.email)

    if user and user["status"] != "suspended":
        token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)
        reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"
        html_body = create_password_reset_html(reset_link, user.get("name"))
        await send_email(user["email"], "Reset Your Password", html_body)
        logger.info(f"Password reset email sent to user {user['id']}")
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
    await UserRepository.update_password(token_data["user_id"], password_hash)
    await mark_password_reset_token_as_used(request.token)
    await PasswordResetRepository.invalidate_all_for_user(token_data["user_id"])

    return ResetPasswordResponse(message="Password has been reset successfully")


@router.post("/change-password", response_model=ChangePasswordResponse)
async def change_password(
    request: ChangePasswordRequest,
    user_id: str = Depends(get_current_user_id),
):
    user = await UserRepository.get_by_id(user_id, columns="id, password_hash")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(request.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    await UserRepository.update_password(user_id, hash_password(request.new_password))
    return ChangePasswordResponse(message="Password changed successfully")


@router.post("/change-email", response_model=ChangeEmailResponse)
async def change_email(
    request: ChangeEmailRequest,
    user_id: str = Depends(get_current_user_id),
):
    user = await UserRepository.get_by_id(user_id, columns="id, email, name, password_hash")
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Password is incorrect")
    if user["email"] == request.new_email:
        raise HTTPException(status_code=400, detail="New email is the same as the current email")
    if await UserRepository.exists_by_email(request.new_email):
        raise HTTPException(status_code=409, detail="Email is already in use")

    token = secrets.token_urlsafe(32)
    await EmailChangeRepository.create(user_id, request.new_email, token, expires_in_hours=1)

    verification_link = f"{settings.FRONTEND_URL}/verify-email-change?token={token}"
    html = create_email_change_verification_html(
        verification_link, request.new_email, user.get("name")
    )
    email_sent = await send_email(request.new_email, "Confirm your email change", html)

    if not email_sent:
        logger.warning(f"Email change verification email failed for user {user_id}")
        raise HTTPException(
            status_code=500, detail="Failed to send verification email. Please try again later."
        )

    return ChangeEmailResponse(
        message="A verification link has been sent to your new email address. Please check your inbox to confirm the change.",
    )


@router.post("/verify-email-change", response_model=VerifyEmailChangeResponse)
async def verify_email_change(request: VerifyEmailChangeRequest):
    token_record = await EmailChangeRepository.get_valid_token(request.token)

    if not token_record:
        raise HTTPException(status_code=400, detail="Invalid or expired verification token")
    if token_record["used"]:
        raise HTTPException(status_code=400, detail="This verification link has already been used")
    if datetime.now(UTC) > token_record["expires_at"]:
        raise HTTPException(status_code=400, detail="This verification link has expired")
    if token_record["status"] == "suspended":
        raise HTTPException(status_code=403, detail="Account is suspended")

    new_email = token_record["new_email"]

    # Check the new email is still available
    if await UserRepository.exists_by_email(new_email):
        raise HTTPException(status_code=409, detail="Email is already in use")

    await UserRepository.update_email(str(token_record["user_id"]), new_email)
    await EmailChangeRepository.mark_used(request.token)

    return VerifyEmailChangeResponse(
        message="Email updated successfully",
        email=new_email,
    )
