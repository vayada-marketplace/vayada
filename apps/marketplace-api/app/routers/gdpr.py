"""
GDPR data subject rights routes (Articles 17 & 20)
"""
from fastapi import APIRouter, HTTPException, status, Depends, Request
from fastapi.responses import JSONResponse
import logging
import secrets
from datetime import datetime, timedelta, timezone
import json

from app.dependencies import get_current_user_id_allow_pending
from app.repositories.user_repo import UserRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.consent_repo import ConsentRepository
from app.repositories.collaboration_repo import CollaborationRepository
from app.repositories.gdpr_repo import GdprRepository
from app.models.consent import (
    GdprExportRequestResponse,
    GdprExportDownloadResponse,
    GdprDeletionRequestResponse,
    GdprDeletionCancelResponse,
    GdprRequestStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gdpr", tags=["gdpr"])

# Constants
EXPORT_EXPIRY_DAYS = 7  # Download link valid for 7 days
DELETION_GRACE_PERIOD_DAYS = 30  # 30 days before deletion is executed


def get_client_ip(request: Request) -> str:
    """Extract client IP address from request"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/export-request", response_model=GdprExportRequestResponse, status_code=status.HTTP_201_CREATED)
async def request_data_export(
    request: Request,
    user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Request a data export (GDPR Article 20 - Right to Data Portability).

    Creates a request for exporting all user data. The export will be
    processed and made available for download within 30 days (per GDPR).
    """
    try:
        # Check for existing pending/processing export request
        existing = await GdprRepository.get_pending_request(user_id, 'export')

        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You already have a pending export request. Please wait for it to complete."
            )

        # Generate secure download token
        download_token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(days=EXPORT_EXPIRY_DAYS)

        # Create export request
        result = await GdprRepository.create_export_request(
            user_id, download_token, expires_at, get_client_ip(request)
        )

        # Process export immediately (in production, use background task)
        await _process_export(user_id, str(result['id']))

        logger.info(f"Data export requested for user {user_id}")

        return GdprExportRequestResponse(
            id=str(result['id']),
            status="processing",
            requested_at=result['requested_at'],
            expires_at=result['expires_at'],
            message="Your data export request has been received. You will be notified when it's ready for download."
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating export request: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create export request"
        )


async def _process_export(user_id: str, request_id: str):
    """Process a data export request (collect and prepare user data)"""
    try:
        # Update status to processing
        await GdprRepository.update_status(request_id, 'processing')

        # Collect user data from all relevant tables
        user_data = {}

        # Basic user info
        user = await UserRepository.get_by_id(
            user_id,
            columns="id, email, name, type, status, created_at, updated_at, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version, marketing_consent, marketing_consent_at"
        )
        if user:
            user_data['user'] = {k: str(v) if v else None for k, v in user.items()}

        # Creator profile (if exists)
        creator = await CreatorRepository.get_by_user_id(user_id)
        if creator:
            user_data['creator_profile'] = {k: str(v) if v else None for k, v in creator.items()}

        # Creator platforms
        if creator:
            platforms = await CreatorRepository.get_platforms(str(creator['id']), columns="*")
            user_data['creator_platforms'] = [
                {k: str(v) if v else None for k, v in p.items()}
                for p in platforms
            ]

        # Hotel profile (if exists)
        hotel = await HotelRepository.get_profile_by_user_id(user_id)
        if hotel:
            user_data['hotel_profile'] = {k: str(v) if v else None for k, v in hotel.items()}

        # Hotel listings (if hotel)
        if hotel:
            listings = await HotelRepository.get_listings_by_profile_id(str(hotel['id']), columns="*")
            user_data['hotel_listings'] = [
                {k: str(v) if v else None for k, v in l.items()}
                for l in listings
            ]

        # Collaborations
        collaborations = await CollaborationRepository.get_user_collaborations(user_id)
        user_data['collaborations'] = [
            {k: str(v) if v else None for k, v in c.items()}
            for c in collaborations
        ]

        # Consent history
        consent_history = await ConsentRepository.get_all_history(user_id)
        user_data['consent_history'] = [
            {k: str(v) if v else None for k, v in c.items()}
            for c in consent_history
        ]

        # Cookie consent
        cookie_consent = await ConsentRepository.get_cookie_consents_by_user_id(user_id)
        user_data['cookie_consent'] = [
            {k: str(v) if v else None for k, v in c.items()}
            for c in cookie_consent
        ]

        # Store the export data (in production, store in S3 or similar)
        export_json = json.dumps(user_data, indent=2, default=str)

        # Update request as completed
        await GdprRepository.mark_completed(request_id)

        logger.info(f"Export processed for user {user_id}, request {request_id}")

    except Exception as e:
        logger.error(f"Error processing export: {e}")
        await GdprRepository.update_status(request_id, 'pending')


@router.get("/export-download", status_code=status.HTTP_200_OK)
async def download_data_export(
    token: str,
    user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Download exported data using the secure download token.

    Returns all user data in JSON format.
    """
    try:
        # Verify token and get request
        request_record = await GdprRepository.get_by_download_token(token)

        if not request_record:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Invalid or expired download token"
            )

        # Verify user owns this request
        if str(request_record['user_id']) != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to download this export"
            )

        # Check if expired
        if request_record['expires_at'] < datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="This download link has expired. Please request a new export."
            )

        # Check status
        if request_record['status'] != 'completed':
            raise HTTPException(
                status_code=status.HTTP_202_ACCEPTED,
                detail="Your export is still being processed. Please try again later."
            )

        # Regenerate export data (in production, fetch from storage)
        user_data = await _collect_user_data(user_id)

        logger.info(f"Data export downloaded for user {user_id}")

        return JSONResponse(
            content=user_data,
            headers={
                "Content-Disposition": f"attachment; filename=vayada-data-export-{user_id}.json"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error downloading export: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to download export"
        )


async def _collect_user_data(user_id: str) -> dict:
    """Collect all user data for export"""
    user_data = {"export_date": datetime.now(timezone.utc).isoformat()}

    # Basic user info
    user = await UserRepository.get_by_id(
        user_id,
        columns="id, email, name, type, status, created_at, updated_at, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version, marketing_consent, marketing_consent_at"
    )
    if user:
        user_data['user'] = {k: str(v) if v else None for k, v in user.items()}

    # Creator profile
    creator = await CreatorRepository.get_by_user_id(user_id)
    if creator:
        user_data['creator_profile'] = {k: str(v) if v else None for k, v in creator.items()}

        platforms = await CreatorRepository.get_platforms(str(creator['id']), columns="*")
        user_data['creator_platforms'] = [
            {k: str(v) if v else None for k, v in p.items()}
            for p in platforms
        ]

    # Hotel profile
    hotel = await HotelRepository.get_profile_by_user_id(user_id)
    if hotel:
        user_data['hotel_profile'] = {k: str(v) if v else None for k, v in hotel.items()}

        listings = await HotelRepository.get_listings_by_profile_id(str(hotel['id']), columns="*")
        user_data['hotel_listings'] = [
            {k: str(v) if v else None for k, v in l.items()}
            for l in listings
        ]

    # Consent history
    consent_history = await ConsentRepository.get_all_history(
        user_id, columns="id, consent_type, consent_given, version, created_at"
    )
    user_data['consent_history'] = [
        {k: str(v) if v else None for k, v in c.items()}
        for c in consent_history
    ]

    return user_data


@router.get("/export-status", response_model=GdprRequestStatusResponse, status_code=status.HTTP_200_OK)
async def get_export_status(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the status of the most recent export request.
    """
    try:
        result = await GdprRepository.get_latest_request(user_id, 'export')

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No export request found"
            )

        return GdprRequestStatusResponse(
            id=str(result['id']),
            request_type=result['request_type'],
            status=result['status'],
            requested_at=result['requested_at'],
            processed_at=result['processed_at'],
            expires_at=result['expires_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting export status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get export status"
        )


@router.post("/delete-request", response_model=GdprDeletionRequestResponse, status_code=status.HTTP_201_CREATED)
async def request_account_deletion(
    request: Request,
    user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Request account deletion (GDPR Article 17 - Right to Erasure).

    Initiates a 30-day grace period before the account is deleted.
    User can cancel the deletion during this period.

    Note: Due to German record-keeping requirements, some data may be
    anonymized rather than completely deleted.
    """
    try:
        # Check for existing pending deletion request
        existing = await GdprRepository.get_pending_request(user_id, 'deletion')

        if existing:
            return GdprDeletionRequestResponse(
                id=str(existing['id']),
                status=existing['status'],
                requested_at=datetime.now(timezone.utc),
                scheduled_deletion_at=existing['expires_at'],
                message="You already have a pending deletion request."
            )

        # Calculate scheduled deletion date (30 days from now)
        scheduled_deletion = datetime.now(timezone.utc) + timedelta(days=DELETION_GRACE_PERIOD_DAYS)

        # Create deletion request
        result = await GdprRepository.create_deletion_request(
            user_id, scheduled_deletion, get_client_ip(request)
        )

        # Create consent history entry
        await ConsentRepository.record(
            user_id, 'deletion_request', True,
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("user-agent", "unknown")
        )

        logger.info(f"Account deletion requested for user {user_id}, scheduled for {scheduled_deletion}")

        return GdprDeletionRequestResponse(
            id=str(result['id']),
            status=result['status'],
            requested_at=result['requested_at'],
            scheduled_deletion_at=result['expires_at'],
            message=f"Your account deletion request has been received. Your account will be deleted on {scheduled_deletion.strftime('%Y-%m-%d')}. You can cancel this request before then."
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating deletion request: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create deletion request"
        )


@router.post("/delete-cancel", response_model=GdprDeletionCancelResponse, status_code=status.HTTP_200_OK)
async def cancel_account_deletion(
    request: Request,
    user_id: str = Depends(get_current_user_id_allow_pending)
):
    """
    Cancel a pending account deletion request.

    Can only be done during the 30-day grace period.
    """
    try:
        # Find pending deletion request
        existing = await GdprRepository.get_pending_deletion(user_id)

        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No pending deletion request found"
            )

        # Cancel the request
        await GdprRepository.cancel_request(existing['id'])

        # Create consent history entry
        await ConsentRepository.record(
            user_id, 'deletion_cancelled', False,
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("user-agent", "unknown")
        )

        logger.info(f"Account deletion cancelled for user {user_id}")

        return GdprDeletionCancelResponse(
            message="Your account deletion request has been cancelled. Your account will remain active.",
            cancelled=True
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling deletion request: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to cancel deletion request"
        )


@router.get("/delete-status", response_model=GdprRequestStatusResponse, status_code=status.HTTP_200_OK)
async def get_deletion_status(user_id: str = Depends(get_current_user_id_allow_pending)):
    """
    Get the status of the most recent deletion request.
    """
    try:
        result = await GdprRepository.get_latest_request(user_id, 'deletion')

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No deletion request found"
            )

        return GdprRequestStatusResponse(
            id=str(result['id']),
            request_type=result['request_type'],
            status=result['status'],
            requested_at=result['requested_at'],
            processed_at=result['processed_at'],
            expires_at=result['expires_at']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting deletion status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get deletion status"
        )
