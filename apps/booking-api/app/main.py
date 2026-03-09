import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from app.database import Database, AuthDatabase, MarketplaceDatabase, PmsDatabase, check_database_connection
from app.config import settings
from app.routers import hotels, auth, admin

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await Database.get_pool()
    await AuthDatabase.get_pool()
    if settings.MARKETPLACE_DATABASE_URL:
        await MarketplaceDatabase.get_pool()
    if settings.PMS_DATABASE_URL:
        await PmsDatabase.get_pool()
    yield
    await PmsDatabase.close_pool()
    await MarketplaceDatabase.close_pool()
    await AuthDatabase.close_pool()
    await Database.close_pool()


app = FastAPI(
    title=settings.API_TITLE,
    description="Vayada Booking Engine Backend API",
    version=settings.API_VERSION,
    lifespan=lifespan,
    debug=settings.DEBUG,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=settings.cors_methods_list,
    allow_headers=settings.cors_headers_list,
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s %s: %s", request.method, request.url.path, exc, exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/")
async def root():
    return {"message": "Welcome to Vayada Booking Engine API"}


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "vayada-booking-engine"}


@app.get("/health/db")
async def health_db():
    db_status = await check_database_connection()
    return {
        "status": "healthy" if db_status.get("connected") else "unhealthy",
        "database": db_status,
    }


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(hotels.router)
app.include_router(hotels.exchange_router)
