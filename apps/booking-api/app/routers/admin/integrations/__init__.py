"""Sub-routers for third-party PMS integrations on the Booking Engine.

One file per integration so the admin surface area stays scoped — the
day we add Hostaway it sits next to Lodgify rather than growing the
shared settings router.
"""

from fastapi import APIRouter

from app.routers.admin.integrations.lodgify import router as lodgify_router

router = APIRouter(prefix="/integrations")
router.include_router(lodgify_router)
