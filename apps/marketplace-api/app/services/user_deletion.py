"""
UserDeletionService — admin-driven cascade delete across S3, the
marketplace DB, and the auth DB.

There is no cross-DB transaction (marketplace and auth are separate
Postgres clusters with no 2PC). Order matters:

  1. S3 image folder is deleted first (best-effort; logged on failure).
  2. Marketplace business data is deleted inside a single transaction
     so a mid-cascade failure leaves the marketplace side either fully
     rolled back or fully gone.
  3. Auth user row is deleted last. If this step fails, the marketplace
     data is already gone and the auth user becomes an orphan; this is
     considered acceptable — re-running the admin delete cleans it up.

If you need stronger guarantees, switch to a soft-delete + reaper job
or wrap the two databases in 2PC.
"""

import logging

from app.database import Database
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.user_repo import UserRepository
from app.s3_service import delete_all_objects_in_prefix

logger = logging.getLogger(__name__)


async def _delete_user_images(user_id: str, user_type: str) -> dict:
    """Delete the S3 folder owned by this user. Best-effort."""
    if user_type == "creator":
        prefix = f"creators/{user_id}/"
    elif user_type == "hotel":
        prefix = f"listings/{user_id}/"
    else:
        logger.warning(f"Unknown user type {user_type}, skipping image deletion")
        return {"deleted_count": 0, "failed_count": 0, "total_objects": 0}

    stats = await delete_all_objects_in_prefix(prefix)
    logger.info(
        f"Deleted images from S3 folder {prefix} for user {user_id}: "
        f"{stats['deleted_count']} deleted, {stats['failed_count']} failed, "
        f"{stats['total_objects']} total"
    )
    return stats


class UserDeletionService:
    @staticmethod
    async def delete(user_id: str, user_type: str) -> dict:
        """Delete S3 → marketplace → auth, in that order. Returns image stats."""
        image_stats = await _delete_user_images(user_id, user_type)

        # Marketplace side, single transaction.
        pool = await Database.get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                if user_type == "creator":
                    creator = await CreatorRepository.get_by_user_id(
                        user_id, columns="id", conn=conn
                    )
                    if creator:
                        await CreatorRepository.delete_platforms(creator["id"], conn=conn)
                        await conn.execute("DELETE FROM creators WHERE id = $1", creator["id"])
                elif user_type == "hotel":
                    hotel = await HotelRepository.get_profile_by_user_id(
                        user_id, columns="id", conn=conn
                    )
                    if hotel:
                        listings = await HotelRepository.get_listings_by_profile_id(
                            hotel["id"], columns="id", conn=conn
                        )
                        for listing in listings:
                            await HotelRepository.delete_offerings(listing["id"], conn=conn)
                            await HotelRepository.delete_requirements(listing["id"], conn=conn)
                        await conn.execute(
                            "DELETE FROM hotel_listings WHERE hotel_profile_id = $1",
                            hotel["id"],
                        )
                        await conn.execute("DELETE FROM hotel_profiles WHERE id = $1", hotel["id"])

        # Auth side. If this fails, the marketplace rows are already gone
        # and the orphan auth row remains until a retry/manual cleanup.
        await UserRepository.delete(user_id)
        return image_stats
