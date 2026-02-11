from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.database import Database, AuthDatabase, MarketplaceDatabase, check_database_connection
from app.config import settings
from app.routers import hotels, auth, admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    await Database.get_pool()
    await AuthDatabase.get_pool()
    if settings.MARKETPLACE_DATABASE_URL:
        await MarketplaceDatabase.get_pool()
    yield
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
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=settings.cors_methods_list,
    allow_headers=settings.cors_headers_list,
)


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
