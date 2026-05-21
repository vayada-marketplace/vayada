"""
Newsletter preferences routes
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import get_current_user_id
from app.repositories.newsletter_repo import NewsletterRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/newsletter", tags=["newsletter"])


class NewsletterPreferencesResponse(BaseModel):
    enabled: bool
    country_filter: list[str] | None = None


class UpdateNewsletterPreferencesRequest(BaseModel):
    enabled: bool | None = None
    country_filter: list[str] | None = None


@router.get("/preferences", response_model=NewsletterPreferencesResponse)
async def get_newsletter_preferences(user_id: str = Depends(get_current_user_id)):
    """Get the current user's newsletter preferences."""
    prefs = await NewsletterRepository.get_by_user_id(user_id)
    if prefs is None:
        return NewsletterPreferencesResponse(enabled=True, country_filter=None)
    return NewsletterPreferencesResponse(
        enabled=prefs["enabled"],
        country_filter=prefs["country_filter"],
    )


@router.put("/preferences", response_model=NewsletterPreferencesResponse)
async def update_newsletter_preferences(
    request: UpdateNewsletterPreferencesRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Update the current user's newsletter preferences."""
    clear_country = False
    country_filter = request.country_filter
    if country_filter is not None and len(country_filter) == 0:
        clear_country = True
        country_filter = None

    prefs = await NewsletterRepository.upsert(
        user_id,
        enabled=request.enabled,
        country_filter=country_filter,
        clear_country_filter=clear_country,
    )
    return NewsletterPreferencesResponse(
        enabled=prefs["enabled"],
        country_filter=prefs["country_filter"],
    )
