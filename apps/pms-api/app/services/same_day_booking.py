from datetime import date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SAME_DAY_BOOKING_CLOSED_MESSAGE = (
    "Same-day bookings are no longer available for today. "
    "Please select tomorrow or another available date."
)


def property_timezone(timezone: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def property_today(timezone: str | None, *, now: datetime | None = None) -> date:
    tz = property_timezone(timezone)
    current = now.astimezone(tz) if now else datetime.now(tz)
    return current.date()


def is_same_day_booking_closed(
    check_in: date,
    *,
    same_day_bookings_enabled: bool,
    same_day_booking_cutoff_time: str | None,
    timezone: str | None,
    now: datetime | None = None,
) -> bool:
    tz = property_timezone(timezone)
    current = now.astimezone(tz) if now else datetime.now(tz)
    if check_in != current.date():
        return False
    if not same_day_bookings_enabled:
        return True
    if not same_day_booking_cutoff_time:
        return False
    cutoff_hour, cutoff_minute = (int(part) for part in same_day_booking_cutoff_time.split(":"))
    cutoff = time(cutoff_hour, cutoff_minute)
    return current.time().replace(microsecond=0) > cutoff
