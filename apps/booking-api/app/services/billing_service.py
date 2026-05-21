"""Billing helpers — plan-switch scheduling, projected-fee math, and the
PMS room-count read that drives the Fixed-plan quote.

Pulled out of ``routers/admin/settings.py`` so a sibling router
(``superadmin``) can use them without importing private symbols across
router files.
"""

import logging
from datetime import date

from app.config import settings as app_settings
from app.database import Database, PmsDatabase

logger = logging.getLogger(__name__)


def first_of_next_month(today: date) -> date:
    """First day of the month after ``today`` — the standard effective
    date for a scheduled billing-plan switch."""
    if today.month == 12:
        return date(today.year + 1, 1, 1)
    return date(today.year, today.month + 1, 1)


def schedule_pending_plan_switch(updates: dict, today: date) -> None:
    """Given a settings PATCH payload, fill in
    ``billing_switch_effective_date`` so the switch lands on the first of
    next month — or clear both fields when the caller passes an empty
    pending value to cancel a scheduled switch.

    Mutates ``updates`` in place. Idempotent if ``billing_pending_switch``
    isn't in the payload."""
    if "billing_pending_switch" not in updates:
        return
    pending = updates["billing_pending_switch"]
    if pending:
        updates["billing_switch_effective_date"] = first_of_next_month(today)
    else:
        updates["billing_pending_switch"] = None
        updates["billing_switch_effective_date"] = None


async def count_active_rooms(hotel_id: str) -> int:
    """Physical-inventory room count from pms_db, filtered to active room
    types. Returns 0 if PMS is unconfigured or the query fails (logged)."""
    if not app_settings.PMS_DATABASE_URL:
        return 0
    try:
        count = await PmsDatabase.fetchval(
            """
            SELECT COUNT(*)
              FROM rooms r
              JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.hotel_id = $1
               AND rt.is_active = TRUE
            """,
            hotel_id,
        )
        return int(count or 0)
    except Exception as exc:
        logger.warning("Failed to count active rooms: %s", exc)
        return 0


def compute_fixed_plan_projected_fee(
    base: float, rooms_included: int, per_extra: float, room_count: int
) -> float:
    """Fixed-plan monthly fee given ``room_count`` total active rooms:
    base fee plus ``per_extra`` per room beyond ``rooms_included``."""
    extras = max(0, room_count - rooms_included)
    return round(base + extras * per_extra, 2)


async def apply_pending_plan_switch_if_due(hotel_id: str) -> None:
    """Flip ``billing_active_plan`` in place when a pending switch's
    effective date has passed. Idempotent — the WHERE clause skips rows
    without a due pending switch. Called on read paths so a missed cron
    or unscheduled day still lands on the right plan."""
    await Database.execute(
        """
        UPDATE booking_hotels
           SET billing_active_plan = billing_pending_switch,
               billing_pending_switch = NULL,
               billing_switch_effective_date = NULL
         WHERE id = $1
           AND billing_pending_switch IS NOT NULL
           AND billing_switch_effective_date IS NOT NULL
           AND billing_switch_effective_date <= CURRENT_DATE
        """,
        hotel_id,
    )
