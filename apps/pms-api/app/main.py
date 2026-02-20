import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import Database, AuthDatabase
from app.routers.rooms import router as rooms_router
from app.routers.bookings import router as bookings_router
from app.routers.admin import router as admin_router
from app.routers.upload import router as upload_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Vayada PMS...")
    yield
    logger.info("Shutting down Vayada PMS...")
    await Database.close_pool()
    await AuthDatabase.close_pool()


app = FastAPI(
    title=settings.API_TITLE,
    description="Vayada Property Management System — rooms & bookings",
    version=settings.API_VERSION,
    lifespan=lifespan,
    debug=settings.DEBUG,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rooms_router)
app.include_router(bookings_router)
app.include_router(admin_router)
app.include_router(upload_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "pms"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=settings.DEBUG,
    )
