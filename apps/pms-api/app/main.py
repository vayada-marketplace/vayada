import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import Database, AuthDatabase
from app.routers.rooms import router as rooms_router
from app.routers.bookings import router as bookings_router
from app.routers.admin import router as admin_router
from app.routers.admin_rooms import router as admin_rooms_router
from app.routers.admin_bookings import router as admin_bookings_router
from app.routers.admin_payments import router as admin_payments_router
from app.routers.admin_affiliates import router as admin_affiliates_router
from app.routers.admin_beds24 import router as admin_beds24_router
from app.routers.upload import router as upload_router
from app.routers.affiliates import router as affiliates_router
from app.routers.webhooks import router as webhooks_router
from app.services.scheduler import setup_scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = setup_scheduler()


async def run_migrations():
    """Run pending SQL migrations on startup."""
    from pathlib import Path
    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        executed = {r['filename'] for r in await conn.fetch("SELECT filename FROM schema_migrations")}
        migrations_dir = Path(__file__).parent.parent / "migrations"
        for f in sorted(migrations_dir.glob("*.sql")):
            if f.name in executed:
                continue
            sql = f.read_text()
            lines = [l for l in sql.split('\n') if l.strip() and not l.strip().startswith('--')]
            if not '\n'.join(lines).strip():
                await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", f.name)
                continue
            logger.info(f"Running migration {f.name}...")
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", f.name)
            logger.info(f"Migration {f.name} completed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Vayada PMS...")
    await run_migrations()
    logger.info("Migrations complete")
    scheduler.start()
    logger.info("Scheduler started")
    yield
    logger.info("Shutting down Vayada PMS...")
    scheduler.shutdown()
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
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rooms_router)
app.include_router(bookings_router)
app.include_router(admin_router)
app.include_router(admin_rooms_router)
app.include_router(admin_bookings_router)
app.include_router(admin_payments_router)
app.include_router(admin_affiliates_router)
app.include_router(admin_beds24_router)
app.include_router(upload_router)
app.include_router(affiliates_router)
app.include_router(webhooks_router)


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
