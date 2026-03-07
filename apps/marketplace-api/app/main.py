"""
Main FastAPI application
"""
import asyncio
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.database import Database, AuthDatabase, check_database_connection
from app.config import settings
from app.routers import auth, creators, hotels, upload, admin, marketplace, collaborations, chat, contact, consent, gdpr, newsletter

logger = logging.getLogger(__name__)


async def _newsletter_scheduler():
    """
    Background task that sends the weekly newsletter.
    Runs every Monday at 09:00 UTC. Survives across the app lifetime.
    """
    from datetime import datetime, timedelta
    import traceback

    while True:
        try:
            now = datetime.utcnow()
            # Calculate next Monday 09:00 UTC
            days_ahead = (7 - now.weekday()) % 7  # 0 = Monday
            if days_ahead == 0 and now.hour >= 9:
                days_ahead = 7
            next_run = (now + timedelta(days=days_ahead)).replace(
                hour=9, minute=0, second=0, microsecond=0
            )
            wait_seconds = (next_run - now).total_seconds()
            logger.info(f"Newsletter scheduler: next run at {next_run} UTC ({wait_seconds:.0f}s from now)")
            await asyncio.sleep(wait_seconds)

            logger.info("Newsletter scheduler: starting weekly send...")
            from scripts.send_weekly_newsletter import send_newsletters_with_pools
            await send_newsletters_with_pools()
            logger.info("Newsletter scheduler: weekly send complete.")
        except asyncio.CancelledError:
            logger.info("Newsletter scheduler: shutting down.")
            break
        except Exception:
            logger.error(f"Newsletter scheduler error:\n{traceback.format_exc()}")
            # Retry in 1 hour on failure
            await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan events for startup and shutdown"""
    # Startup
    await Database.get_pool()
    await AuthDatabase.get_pool()
    scheduler_task = asyncio.create_task(_newsletter_scheduler())
    yield
    # Shutdown
    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass
    await AuthDatabase.close_pool()
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
app.include_router(upload.router)
app.include_router(admin.router)
app.include_router(marketplace.router)
app.include_router(collaborations.router)
app.include_router(chat.router)
app.include_router(contact.router)
app.include_router(consent.router)
app.include_router(gdpr.router)
app.include_router(newsletter.router)

