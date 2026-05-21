"""
AffiliateProvisioningService — auto-creates a PMS affiliate when a
collaboration is accepted, and stores the resulting referral link on
the collaboration row.

The marketplace and PMS run in separate databases; this service keeps
the cross-DB write path in one place so it can't drift between the
self-service collaborations router and the admin override.
"""

import logging
import secrets
from decimal import Decimal

from app.config import settings
from app.database import Database, PmsDatabase
from app.repositories.hotel_repo import HotelRepository

logger = logging.getLogger(__name__)


_DEFAULT_COMMISSION = Decimal("5.00")


async def _fetch_creator_social_media(creator_id: str) -> str:
    rows = await Database.fetch(
        "SELECT name, handle FROM creator_platforms WHERE creator_id = $1",
        creator_id,
    )
    return ", ".join(f"{r['name']}: @{r['handle']}" for r in rows if r.get("handle"))


class AffiliateProvisioningService:
    @staticmethod
    async def provision_for_accepted_collab(
        collaboration_id: str,
        *,
        creator_id: str,
        hotel_id: str,
        creator_email: str | None,
        creator_name: str | None,
        commission: Decimal | None,
    ) -> str | None:
        """Create a PMS affiliate row for the creator on the hotel and persist
        the affiliate link onto the collaboration. Returns the link or None.

        Failures are logged but never raised — affiliate creation must not
        prevent collaboration acceptance from succeeding.
        """
        if not settings.PMS_DATABASE_URL:
            return None

        try:
            hotel_profile = await HotelRepository.get_profile_by_id(hotel_id, columns="user_id")
            if not hotel_profile:
                return None

            pms_hotel = await PmsDatabase.fetchrow(
                "SELECT id, slug FROM hotels WHERE user_id = $1",
                hotel_profile["user_id"],
            )
            if not pms_hotel:
                return None

            referral_code = secrets.token_urlsafe(8)
            social_media = await _fetch_creator_social_media(creator_id)

            pms_affiliate = await PmsDatabase.fetchrow(
                """
                INSERT INTO affiliates (
                    hotel_id, referral_code, full_name, email,
                    social_media, user_type, commission_pct, status
                ) VALUES ($1, $2, $3, $4, $5, 'creator', $6, 'approved')
                RETURNING id, referral_code
                """,
                pms_hotel["id"],
                referral_code,
                creator_name or "Unknown",
                creator_email or "",
                social_media,
                commission or _DEFAULT_COMMISSION,
            )
            if not pms_affiliate:
                return None

            affiliate_link = settings.AFFILIATE_LINK_TEMPLATE.format(
                slug=pms_hotel["slug"],
                referral_code=referral_code,
            )
            await Database.execute(
                """
                UPDATE collaborations
                SET affiliate_referral_code = $1, affiliate_link = $2
                WHERE id = $3
                """,
                referral_code,
                affiliate_link,
                collaboration_id,
            )
            return affiliate_link
        except Exception as e:
            logger.error(f"Failed to create affiliate for collaboration {collaboration_id}: {e}")
            return None
