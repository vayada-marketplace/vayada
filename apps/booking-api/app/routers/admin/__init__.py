"""
Admin routes — split into domain-focused sub-routers.

All sub-routers share the /admin prefix via the combined `router`.
"""
from fastapi import APIRouter
from app.routers.admin.profile import router as profile_router
from app.routers.admin.settings import router as settings_router
from app.routers.admin.design import router as design_router
from app.routers.admin.upload import router as upload_router
from app.routers.admin.addons import router as addons_router
from app.routers.admin.superadmin import router as superadmin_router
from app.routers.admin.dashboard import router as dashboard_router

router = APIRouter(prefix="/admin", tags=["admin"])

router.include_router(profile_router)
router.include_router(settings_router)
router.include_router(design_router)
router.include_router(upload_router)
router.include_router(addons_router)
router.include_router(superadmin_router)
router.include_router(dashboard_router)
