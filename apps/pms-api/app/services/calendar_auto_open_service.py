import calendar
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.repositories.hotel_repo import HotelRepository
from app.repositories.room_type_repo import RoomTypeRepository

logger = logging.getLogger(__name__)

AUTO_OPEN_MODES = {"rolling", "fixed"}
ROLLING_MONTH_PRESETS = {12, 18, 24}


@dataclass
class AutoOpenApplyResult:
    open_through: date | None
    changed: bool
    warnings: list[str]


def month_start(value: date) -> date:
    return date(value.year, value.month, 1)


def month_end(value: date) -> date:
    return date(value.year, value.month, calendar.monthrange(value.year, value.month)[1])


def add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    return date(year, month, 1)


def local_today(timezone: str | None) -> date:
    if timezone:
        try:
            return datetime.now(ZoneInfo(timezone)).date()
        except ZoneInfoNotFoundError:
            logger.warning("Unknown hotel timezone %s; falling back to UTC", timezone)
    return datetime.now(UTC).date()


def rolling_open_through(today: date, months: int) -> date:
    return month_end(add_months(month_start(today), months))


def target_open_through(
    *,
    mode: str,
    months: int,
    fixed_month: date | None,
    timezone: str | None,
) -> date:
    if mode == "rolling":
        return rolling_open_through(local_today(timezone), months)
    if not fixed_month:
        raise ValueError("Fixed auto-open mode requires a target month")
    return month_end(fixed_month)


def has_sellable_rate_on_date(room_type: dict, check_date: date) -> bool:
    if not RoomTypeRepository.is_date_in_operating_periods(room_type, check_date):
        return False
    base_rate, _ = RoomTypeRepository.resolve_rate(room_type, check_date)
    return float(base_rate) > 0


def is_date_auto_open(hotel_settings: dict | None, check_date: date) -> bool:
    if not hotel_settings:
        return True
    if not hotel_settings.get("calendar_auto_open_enabled", False):
        return True
    open_through = hotel_settings.get("calendar_auto_open_through")
    if not open_through:
        return True
    return check_date <= open_through


def is_stay_sellable(
    check_in: date,
    check_out: date,
    room_type: dict,
    calendar_settings: dict | None,
) -> bool:
    current = check_in
    while current < check_out:
        if (
            not is_date_auto_open(calendar_settings, current)
            or not has_sellable_rate_on_date(room_type, current)
        ):
            return False
        current += timedelta(days=1)
    return True


async def collect_rate_warnings(
    hotel_id: str, open_through: date | None, timezone: str | None = None
) -> list[str]:
    if not open_through:
        return []

    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    warnings: list[str] = []
    for room in rooms:
        current = month_start(local_today(timezone))
        while current <= open_through:
            end = month_end(current)
            day = current
            missing_rate = False
            while day <= end:
                if RoomTypeRepository.is_date_in_operating_periods(room, day):
                    if not has_sellable_rate_on_date(room, day):
                        missing_rate = True
                        break
                day += timedelta(days=1)
            if missing_rate:
                warnings.append(
                    f"Rates are missing for {room['name']} in {current.strftime('%B %Y')}; "
                    "those dates stay closed until rates are set."
                )
            current = add_months(current, 1)
    return warnings


async def apply_auto_open_for_hotel(hotel_id: str, *, push_ari: bool = True) -> AutoOpenApplyResult:
    settings = await HotelRepository.get_calendar_settings(hotel_id)
    if not settings or not settings.get("calendar_auto_open_enabled"):
        return AutoOpenApplyResult(
            open_through=settings.get("calendar_auto_open_through") if settings else None,
            changed=False,
            warnings=[],
        )

    target = target_open_through(
        mode=settings.get("calendar_auto_open_mode") or "rolling",
        months=int(settings.get("calendar_auto_open_months") or 18),
        fixed_month=settings.get("calendar_auto_open_fixed_month"),
        timezone=settings.get("timezone"),
    )
    current = settings.get("calendar_auto_open_through")
    next_open_through = max(current, target) if current else target
    changed = next_open_through != current

    if changed:
        await HotelRepository.update_calendar_settings(
            hotel_id,
            {
                "calendar_auto_open_through": next_open_through,
                "calendar_auto_open_last_run_at": datetime.now(UTC),
            },
        )
        if push_ari:
            try:
                from app.services.channex.orchestrator import push_ari_for_hotel

                await push_ari_for_hotel(hotel_id)
            except Exception:
                logger.exception("Auto-open ARI push failed for hotel %s", hotel_id)

    warnings = await collect_rate_warnings(
        hotel_id, next_open_through, settings.get("timezone")
    )
    return AutoOpenApplyResult(
        open_through=next_open_through,
        changed=changed,
        warnings=warnings,
    )
