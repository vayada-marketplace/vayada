from __future__ import annotations

import logging
import re
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.repositories.inbox_automation_repo import (
    AutomationSendRepository,
    GuestAutomationRepository,
    bookings_for_automation,
    latest_booking_context,
)
from app.repositories.messaging_repo import MessageRepository, MessageThreadRepository
from app.services import channex_service
from app.services.email_service import send_guest_message_email

logger = logging.getLogger(__name__)

_VARIABLE_RE = re.compile(r"{{\s*([a-zA-Z0-9_]+)\s*}}")
_OTA_CHANNELS = {"booking.com", "airbnb", "expedia"}


def _first_name(row: dict) -> str:
    first = (row.get("guest_first_name") or "").strip()
    if first:
        return first
    full = _guest_full(row)
    return full.split(" ")[0] if full else "Guest"


def _guest_full(row: dict) -> str:
    return " ".join(
        part for part in [row.get("guest_first_name"), row.get("guest_last_name")] if part
    ).strip()


def _fmt_date(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            value = date.fromisoformat(value)
        except ValueError:
            return value
    if isinstance(value, date):
        return value.strftime("%b %-d, %Y")
    return str(value)


def _night_count(row: dict) -> str:
    check_in = row.get("check_in")
    check_out = row.get("check_out")
    if isinstance(check_in, str):
        check_in = date.fromisoformat(check_in)
    if isinstance(check_out, str):
        check_out = date.fromisoformat(check_out)
    if isinstance(check_in, date) and isinstance(check_out, date):
        return str(max(1, (check_out - check_in).days))
    return ""


def variables_for_booking(row: dict | None) -> dict[str, str]:
    if not row:
        return {
            "guest": "Theodor",
            "guest_full": "Theodor Guest",
            "property": "",
            "checkin_date": "",
            "checkout_date": "",
            "checkin_time": "",
            "nights": "",
            "wifi": "",
            "address": "",
            "host": "",
            "review_link": "",
            "referral_link": "",
        }
    host_name = row.get("host_contact_name") or row.get("hotel_contact_email") or ""
    return {
        "guest": _first_name(row),
        "guest_full": _guest_full(row) or _first_name(row),
        "property": row.get("hotel_name") or "",
        "checkin_date": _fmt_date(row.get("check_in")),
        "checkout_date": _fmt_date(row.get("check_out")),
        "checkin_time": row.get("check_in_time") or "",
        "nights": _night_count(row),
        "wifi": row.get("wifi_password") or "",
        "address": row.get("hotel_address") or "",
        "host": host_name,
        "review_link": row.get("google_review_link") or "",
        "referral_link": "",
    }


def render_template(content: str, variables: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        value = variables.get(key)
        return value if value else match.group(0)

    return _VARIABLE_RE.sub(replace, content)


async def preview_variables(hotel_id: str) -> dict[str, str]:
    return variables_for_booking(await latest_booking_context(hotel_id))


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _send_time_due(now_local: datetime, send_at: time) -> bool:
    return now_local.time() >= send_at


def _target(trigger_event: str, days_offset: int, local_day: date) -> tuple[str, date]:
    if trigger_event == "before_check_in":
        return "check_in", local_day + timedelta(days=max(0, days_offset))
    if trigger_event == "day_of_check_in":
        return "check_in", local_day
    if trigger_event == "after_check_out":
        return "check_out", local_day - timedelta(days=max(0, days_offset))
    if trigger_event == "day_of_check_out":
        return "check_out", local_day
    return "check_in", local_day


def _normalize_channel(value: str | None) -> str:
    channel = (value or "").lower().replace("_", ".").strip()
    if "booking" in channel:
        return "booking.com"
    if "airbnb" in channel:
        return "airbnb"
    if "expedia" in channel:
        return "expedia"
    if channel in {"direct", "email"}:
        return channel
    return channel or "direct"


def _audience_matches(audience: str, booking: dict) -> bool:
    channel = _normalize_channel(booking.get("channex_channel") or booking.get("channel"))
    if audience == "all":
        return True
    if audience == "direct":
        return channel not in _OTA_CHANNELS
    if audience == "ota":
        return channel in _OTA_CHANNELS
    return channel == audience


def _delivery_mode(automation: dict, booking: dict) -> str | None:
    requested = automation.get("delivery_channel") or "smart"
    has_ota_thread = bool(
        booking.get("channex_thread_id") and booking.get("channex_source_thread_id")
    )
    if requested == "email_only":
        return "email"
    if requested == "ota_only":
        return "ota" if has_ota_thread else None
    if has_ota_thread:
        return "ota"
    return "email"


async def _send_via_ota(automation: dict, booking: dict, content: str) -> tuple[str, str]:
    api_key = channex_service.get_platform_api_key()
    channex_message = await channex_service.post_thread_message(
        api_key,
        str(booking["channex_source_thread_id"]),
        message=content,
    )
    attrs = channex_message.get("attributes") or {}
    inserted = await MessageRepository.insert_and_update_thread(
        thread_id=str(booking["channex_thread_id"]),
        source_message_id=str(channex_message["id"]),
        direction="outbound",
        sender_name=None,
        body=content,
        sent_at=datetime.fromisoformat(attrs["inserted_at"].replace("Z", "+00:00"))
        if attrs.get("inserted_at")
        else datetime.now(UTC),
        raw_payload=channex_message,
        automated=True,
    )
    return str(booking["channex_thread_id"]), str(inserted["id"]) if inserted else ""


async def _send_via_email(automation: dict, booking: dict, content: str) -> tuple[str, str]:
    guest_email = booking.get("guest_email")
    if not guest_email:
        raise ValueError("guest email missing")
    subject = f"{automation['name']} - {booking.get('hotel_name') or 'Your stay'}"
    await send_guest_message_email(guest_email, subject, content)
    thread = await MessageThreadRepository.upsert_from_source(
        hotel_id=str(booking["hotel_id"]),
        source="direct",
        source_thread_id=f"booking:{booking['id']}",
        channel="email",
        guest_name=_guest_full(booking) or _first_name(booking),
        guest_email=guest_email,
        source_booking_id=booking.get("booking_reference"),
        booking_id=str(booking["id"]),
        status="open",
    )
    inserted = await MessageRepository.insert_and_update_thread(
        thread_id=str(thread["id"]),
        source_message_id=f"automation:{automation['id']}:{booking['id']}",
        direction="outbound",
        sender_name=None,
        body=content,
        sent_at=datetime.now(UTC),
        raw_payload={"automation_id": str(automation["id"])},
        automated=True,
    )
    return str(thread["id"]), str(inserted["id"]) if inserted else ""


async def process_guest_automations() -> int:
    sent_count = 0
    for automation in await GuestAutomationRepository.list_active():
        if not automation.get("template_content"):
            continue
        now_local = datetime.now(_zone(automation.get("timezone")))
        if not _send_time_due(now_local, automation["send_time"]):
            continue
        target_field, target_date = _target(
            automation["trigger_event"],
            int(automation.get("days_offset") or 0),
            now_local.date(),
        )
        bookings = await bookings_for_automation(
            str(automation["hotel_id"]),
            target_field,
            target_date,
        )
        for booking in bookings:
            if not _audience_matches(automation.get("audience") or "all", booking):
                continue
            delivery_mode = _delivery_mode(automation, booking)
            reservation = await AutomationSendRepository.reserve(
                str(automation["id"]),
                str(booking["id"]),
                delivery_mode or automation.get("delivery_channel") or "smart",
            )
            if not reservation:
                continue
            if not delivery_mode:
                await AutomationSendRepository.mark(
                    str(reservation["id"]),
                    status="skipped",
                    error="No matching delivery channel available",
                )
                continue
            variables = variables_for_booking(booking)
            content = render_template(automation["template_content"], variables)
            try:
                if delivery_mode == "ota":
                    thread_id, message_id = await _send_via_ota(automation, booking, content)
                else:
                    thread_id, message_id = await _send_via_email(automation, booking, content)
                await AutomationSendRepository.mark(
                    str(reservation["id"]),
                    status="sent",
                    message_thread_id=thread_id,
                    message_id=message_id or None,
                )
                sent_count += 1
            except Exception as exc:
                logger.exception(
                    "Guest automation send failed: automation=%s booking=%s",
                    automation["id"],
                    booking["id"],
                )
                await AutomationSendRepository.mark(
                    str(reservation["id"]),
                    status="failed",
                    error=str(exc),
                )
    return sent_count
