"""
In-process weekly newsletter scheduler.

This is a stopgap. The web process holds an asyncio task that wakes up
every Monday at 09:00 UTC and runs the newsletter send. The risks:

  * Multi-replica deploys would send N copies, one per replica.
  * The bg job is coupled to web-process lifetime — restarts skip a run
    if they happen during the firing window.

For real production use, move the trigger to an external scheduler
(cron / Cloud Scheduler / Celery beat / Cloud Run Jobs) and have it hit
a /newsletter/send endpoint or run send_weekly_newsletter as a one-shot
container. The flag NEWSLETTER_SCHEDULER_ENABLED gates this so prod
can enable it on exactly one replica until that migration happens.
"""
import asyncio
import logging
import traceback
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


async def run_forever() -> None:
    """Loop body for the in-process scheduler. Cancelled at shutdown."""
    while True:
        try:
            now = datetime.utcnow()
            # Calculate next Monday 09:00 UTC.
            days_ahead = (7 - now.weekday()) % 7  # 0 = Monday
            if days_ahead == 0 and now.hour >= 9:
                days_ahead = 7
            next_run = (now + timedelta(days=days_ahead)).replace(
                hour=9, minute=0, second=0, microsecond=0
            )
            wait_seconds = (next_run - now).total_seconds()
            logger.info(
                f"Newsletter scheduler: next run at {next_run} UTC ({wait_seconds:.0f}s from now)"
            )
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
            # Retry in 1 hour on failure.
            await asyncio.sleep(3600)
