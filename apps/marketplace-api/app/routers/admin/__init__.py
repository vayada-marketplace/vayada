"""
Admin endpoints. Mounted under /admin.

Split into three subrouters by resource:
  - users.py — user CRUD + creator/hotel profile updates + cascade delete
  - listings.py — admin listing CRUD (delegates to ListingService)
  - collaborations.py — admin collaboration monitoring + admin-side respond/approve

Each subrouter declares its own paths; this __init__ mounts them under /admin.
"""

from fastapi import APIRouter

from . import collaborations, listings, users

router = APIRouter(prefix="/admin", tags=["admin"])
router.include_router(users.router)
router.include_router(listings.router)
router.include_router(collaborations.router)
