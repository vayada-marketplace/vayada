"""
Database connection and utilities
"""
import asyncpg
from typing import Optional
from app.config import settings


class Database:
    """Database connection pool manager"""
    
    _pool: Optional[asyncpg.Pool] = None
    
    @classmethod
    async def get_pool(cls) -> asyncpg.Pool:
        """Get or create database connection pool"""
        if cls._pool is None:
            cls._pool = await asyncpg.create_pool(
                settings.DATABASE_URL,
                min_size=settings.DATABASE_POOL_MIN_SIZE,
                max_size=settings.DATABASE_POOL_MAX_SIZE,
                command_timeout=settings.DATABASE_COMMAND_TIMEOUT
            )
        return cls._pool
    
    @classmethod
    async def close_pool(cls):
        """Close database connection pool"""
        if cls._pool:
            await cls._pool.close()
            cls._pool = None
    
    @classmethod
    async def execute(cls, query: str, *args):
        """Execute a query"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.execute(query, *args)
    
    @classmethod
    async def fetch(cls, query: str, *args):
        """Fetch multiple rows"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetch(query, *args)
    
    @classmethod
    async def fetchrow(cls, query: str, *args):
        """Fetch a single row"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetchrow(query, *args)
    
    @classmethod
    async def fetchval(cls, query: str, *args):
        """Fetch a single value"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetchval(query, *args)


class AuthDatabase:
    """Auth database connection pool manager (shared auth DB)"""

    _pool: Optional[asyncpg.Pool] = None

    @classmethod
    async def get_pool(cls) -> asyncpg.Pool:
        """Get or create auth database connection pool"""
        if cls._pool is None:
            cls._pool = await asyncpg.create_pool(
                settings.AUTH_DATABASE_URL,
                min_size=settings.DATABASE_POOL_MIN_SIZE,
                max_size=settings.DATABASE_POOL_MAX_SIZE,
                command_timeout=settings.DATABASE_COMMAND_TIMEOUT
            )
        return cls._pool

    @classmethod
    async def close_pool(cls):
        """Close auth database connection pool"""
        if cls._pool:
            await cls._pool.close()
            cls._pool = None

    @classmethod
    async def execute(cls, query: str, *args):
        """Execute a query"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.execute(query, *args)

    @classmethod
    async def fetch(cls, query: str, *args):
        """Fetch multiple rows"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetch(query, *args)

    @classmethod
    async def fetchrow(cls, query: str, *args):
        """Fetch a single row"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetchrow(query, *args)

    @classmethod
    async def fetchval(cls, query: str, *args):
        """Fetch a single value"""
        pool = await cls.get_pool()
        async with pool.acquire() as connection:
            return await connection.fetchval(query, *args)


async def check_database_connection() -> dict:
    """Check if database connection is working"""
    try:
        pool = await Database.get_pool()
        version = await Database.fetchval("SELECT version()")
        table_count = await Database.fetchval(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'"
        )
        return {
            "connected": True,
            "version": version.split(",")[0] if version else "unknown",
            "tables": table_count
        }
    except Exception as e:
        return {
            "connected": False,
            "error": str(e)
        }

