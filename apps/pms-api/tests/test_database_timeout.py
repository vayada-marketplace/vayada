"""Real asyncpg regressions; use PMS_TIMEOUT_TEST_DATABASE_URL with a local DB."""

import asyncio
import os

import asyncpg
import pytest
from app.config import settings
from app.database import AuthDatabase, BookingEngineDatabase, Database


@pytest.mark.parametrize("database", [Database, AuthDatabase, BookingEngineDatabase])
async def test_exhausted_pool_times_out_and_next_call_recovers(monkeypatch, database):
    url = os.environ.get("PMS_TIMEOUT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("PMS_TIMEOUT_TEST_DATABASE_URL is required")
    pool = await asyncpg.create_pool(url, min_size=1, max_size=1)
    monkeypatch.setattr(database, "_pool", pool)
    monkeypatch.setattr(settings, "DATABASE_COMMAND_TIMEOUT", 0.05)
    try:
        async with pool.acquire():
            start = asyncio.get_running_loop().time()
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(database.fetchval("SELECT 1"), timeout=1)
            assert asyncio.get_running_loop().time() - start < 0.5
        monkeypatch.setattr(settings, "DATABASE_COMMAND_TIMEOUT", 2)
        assert await database.fetchval("SELECT 1") == 1
    finally:
        pool.terminate()


async def test_stuck_connection_reset_times_out_and_pool_recovers(monkeypatch):
    url = os.environ.get("PMS_TIMEOUT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("PMS_TIMEOUT_TEST_DATABASE_URL is required")
    resets = 0

    async def reset(connection):
        nonlocal resets
        resets += 1
        if resets == 1:
            await asyncio.Event().wait()
        await connection.execute("RESET ALL")

    pool = await asyncpg.create_pool(url, min_size=1, max_size=1, reset=reset)
    monkeypatch.setattr(Database, "_pool", pool)
    monkeypatch.setattr(settings, "DATABASE_COMMAND_TIMEOUT", 0.05)
    try:
        start = asyncio.get_running_loop().time()
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(Database.fetchval("SELECT 1"), timeout=1)
        assert asyncio.get_running_loop().time() - start < 0.5
        monkeypatch.setattr(settings, "DATABASE_COMMAND_TIMEOUT", 2)
        assert await Database.fetchval("SELECT 1") == 1
    finally:
        pool.terminate()
