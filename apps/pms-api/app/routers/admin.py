import logging

from fastapi import APIRouter, HTTPException, Depends

from app.dependencies import require_hotel_admin
from app.database import Database, AuthDatabase
from app.models.hotel import HotelRegister, HotelResponse, SetupStatusResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# ── Hotel Registration ─────────────────────────────────────────────


@router.post("/register-hotel", response_model=HotelResponse, status_code=201)
async def register_hotel(
    data: HotelRegister,
    user_id: str = Depends(require_hotel_admin),
):
    # Idempotent: return existing hotel if already registered
    existing = await Database.fetchrow(
        "SELECT id, slug, name, contact_email, user_id, created_at FROM hotels WHERE user_id = $1",
        user_id,
    )
    if existing:
        return HotelResponse(
            id=str(existing["id"]),
            slug=existing["slug"],
            name=existing["name"],
            contact_email=existing["contact_email"],
            user_id=str(existing["user_id"]),
            created_at=existing["created_at"].isoformat(),
        )

    row = await Database.fetchrow(
        """INSERT INTO hotels (slug, name, contact_email, user_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, slug, name, contact_email, user_id, created_at""",
        data.slug,
        data.name,
        data.contact_email,
        user_id,
    )
    return HotelResponse(
        id=str(row["id"]),
        slug=row["slug"],
        name=row["name"],
        contact_email=row["contact_email"],
        user_id=str(row["user_id"]),
        created_at=row["created_at"].isoformat(),
    )


@router.get("/setup-status", response_model=SetupStatusResponse)
async def get_setup_status(
    user_id: str = Depends(require_hotel_admin),
):
    hotel = await Database.fetchrow(
        "SELECT id FROM hotels WHERE user_id = $1", user_id
    )

    # Auto-register: if no PMS hotel exists yet, create one from the auth profile
    if not hotel:
        try:
            user = await AuthDatabase.fetchrow(
                "SELECT name, email FROM users WHERE id = $1", user_id
            )
            if user and user["name"]:
                import re
                import uuid
                base_slug = re.sub(r'[^a-z0-9]+', '-', user["name"].lower()).strip('-')
                slug = base_slug or "hotel"
                # Append short suffix to avoid slug collisions
                slug = f"{slug}-{uuid.uuid4().hex[:6]}"
                hotel = await Database.fetchrow(
                    """INSERT INTO hotels (slug, name, contact_email, user_id)
                       VALUES ($1, $2, $3, $4)
                       RETURNING id""",
                    slug,
                    user["name"],
                    user["email"],
                    user_id,
                )
        except Exception as e:
            logger.error(f"Auto-register hotel failed for user {user_id}: {e}")

    if not hotel:
        return SetupStatusResponse(registered=False, setup_complete=False, room_count=0)

    hotel_id = str(hotel["id"])
    room_count = await Database.fetchval(
        "SELECT COUNT(*) FROM room_types WHERE hotel_id = $1", hotel_id
    )
    return SetupStatusResponse(
        registered=True,
        setup_complete=room_count > 0,
        room_count=room_count,
    )
