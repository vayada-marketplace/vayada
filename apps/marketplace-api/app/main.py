"""
Main FastAPI application
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.database import Database, check_database_connection
from app.config import settings
from app.routers import auth, creators, hotels


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan events for startup and shutdown"""
    # Startup
    await Database.get_pool()
    yield
    # Shutdown
    await Database.close_pool()


app = FastAPI(
    title=settings.API_TITLE,
    description="Vayada Creator Marketplace Backend API",
    version=settings.API_VERSION,
    lifespan=lifespan,
    debug=settings.DEBUG
)

# Configure CORS from environment variables
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=settings.cors_methods_list,
    allow_headers=settings.cors_headers_list,
)


@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "Welcome to Vayada API"}


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "vayada-api"
    }


@app.get("/health/db")
async def health_db():
    """Database health check endpoint"""
    db_status = await check_database_connection()
    return {
        "status": "healthy" if db_status.get("connected") else "unhealthy",
        "database": db_status
    }


# Include routers
app.include_router(auth.router)
app.include_router(creators.router)
app.include_router(hotels.router)

