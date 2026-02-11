"""
Consent management routes for GDPR compliance
"""
from fastapi import APIRouter, HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import logging

from app.repositories.consent_repo import ConsentRepository
from app.dependencies import get_current_user_id_allow_pending
from app.jwt_utils import decode_access_token
from app.models.consent import (
    CookieConsentRequest,
    CookieConsentResponse,
    ConsentStatusResponse,
    UpdateMarketingConsentRequest,
    UpdateMarketingConsentResponse,
    ConsentHistoryItem,
    ConsentHistoryResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/consent", tags=["consent"])

# Optional security for cookie consent (works for both anonymous and logged-in users)
optional_security = HTTPBearer(auto_error=False)


def get_client_ip(request: Request) -> str:
    """Extract client IP address from request"""
    # Check for forwarded header (common with proxies/load balancers)
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.get("/me", response_model=ConsentStatusResponse, status_code=status.HTTP_200_OK)
async def get_consent_status(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the current user's consent status.

    Returns the current state of all consent preferences:
    - Terms of Service acceptance
    - Privacy Policy acceptance
    - Marketing consent
    """
    try:
        user = await ConsentRepository.get_consent_status(user_id)

        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        return ConsentStatusResponse(
            terms_accepted=user['terms_accepted_at'] is not None,
            terms_accepted_at=user['terms_accepted_at'],
            terms_version=user['terms_version'],
            privacy_accepted=user['privacy_accepted_at'] is not None,
            privacy_accepted_at=user['privacy_accepted_at'],
            privacy_version=user['privacy_version'],
            marketing_consent=user['marketing_consent'] or False,
            marketing_consent_at=user['marketing_consent_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting consent status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get consent status"
        )


@router.put("/me", response_model=UpdateMarketingConsentResponse, status_code=status.HTTP_200_OK)
async def update_marketing_consent(
    request_body: UpdateMarketingConsentRequest,
    request: Request,
    user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Update the user's marketing consent preference.

    This creates an audit trail entry for GDPR compliance.
    """
    try:
        # Update marketing consent
        result = await ConsentRepository.update_marketing_consent(user_id, request_body.marketing_consent)

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

        # Create audit trail entry
        await ConsentRepository.record(
            user_id,
            'marketing',
            request_body.marketing_consent,
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("user-agent", "unknown"),
        )

        action = "given" if request_body.marketing_consent else "withdrawn"
        logger.info(f"Marketing consent {action} for user {user_id}")

        return UpdateMarketingConsentResponse(
            marketing_consent=result['marketing_consent'],
            marketing_consent_at=result['marketing_consent_at'],
            message=f"Marketing consent {action} successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating marketing consent: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update marketing consent"
        )


@router.post("/cookies", response_model=CookieConsentResponse, status_code=status.HTTP_200_OK)
async def store_cookie_consent(
    consent: CookieConsentRequest,
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_security)
):
    """
    Store cookie consent preferences.

    Works for both anonymous visitors (using visitor_id) and logged-in users.
    If a user is logged in, their user_id is associated with the consent record.
    """
    try:
        # Try to get user_id from token if provided
        user_id = None
        if credentials:
            payload = decode_access_token(credentials.credentials)
            if payload:
                user_id = payload.get("sub")

        # Ensure necessary cookies are always true
        necessary = True

        # Insert or update cookie consent record
        result = await ConsentRepository.upsert_cookie_consent(
            consent.visitor_id,
            user_id,
            necessary,
            consent.functional,
            consent.analytics,
            consent.marketing,
        )

        # Create audit trail if user is logged in
        if user_id:
            await ConsentRepository.record(
                user_id,
                'cookies',
                True,
                ip_address=get_client_ip(request),
                user_agent=request.headers.get("user-agent", "unknown"),
            )

        logger.info(f"Cookie consent stored for visitor {consent.visitor_id}")

        return CookieConsentResponse(
            id=str(result['id']),
            visitor_id=result['visitor_id'],
            user_id=str(result['user_id']) if result['user_id'] else None,
            necessary=result['necessary'],
            functional=result['functional'],
            analytics=result['analytics'],
            marketing=result['marketing'],
            created_at=result['created_at'],
            updated_at=result['updated_at']
        )

    except Exception as e:
        logger.error(f"Error storing cookie consent: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to store cookie consent"
        )


@router.get("/cookies", response_model=Optional[CookieConsentResponse], status_code=status.HTTP_200_OK)
async def get_cookie_consent(
    visitor_id: str,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_security)
):
    """
    Get cookie consent preferences for a visitor.

    Returns the current cookie consent settings, or null if not set.
    """
    try:
        result = await ConsentRepository.get_cookie_consent(visitor_id)

        if not result:
            return None

        return CookieConsentResponse(
            id=str(result['id']),
            visitor_id=result['visitor_id'],
            user_id=str(result['user_id']) if result['user_id'] else None,
            necessary=result['necessary'],
            functional=result['functional'],
            analytics=result['analytics'],
            marketing=result['marketing'],
            created_at=result['created_at'],
            updated_at=result['updated_at']
        )

    except Exception as e:
        logger.error(f"Error getting cookie consent: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get cookie consent"
        )


@router.get("/history", response_model=ConsentHistoryResponse, status_code=status.HTTP_200_OK)
async def get_consent_history(
    user_id: str = Depends(get_current_user_id_allow_pending),
    limit: int = 50,
    offset: int = 0
):
    """
    Get the user's consent history (audit trail).

    Returns a list of all consent actions taken by the user.
    """
    try:
        # Get total count
        total = await ConsentRepository.count_history(user_id)

        # Get history records
        records = await ConsentRepository.get_history(user_id, limit, offset)

        history = [
            ConsentHistoryItem(
                id=str(record['id']),
                consent_type=record['consent_type'],
                consent_given=record['consent_given'],
                version=record['version'],
                created_at=record['created_at']
            )
            for record in records
        ]

        return ConsentHistoryResponse(
            history=history,
            total=total
        )

    except Exception as e:
        logger.error(f"Error getting consent history: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get consent history"
        )
